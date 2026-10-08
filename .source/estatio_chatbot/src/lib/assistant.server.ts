import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { ChatResponse, ChatRequestSchema, ChatMessage, CandidateProperty, ListingFilters } from "./assistant.schemas";
import { classifyAndRoute, synthesizeResponse, getQueryEmbedding } from "./assistant.llm";
import { searchWithRelaxation, saveChatMessage, getChatHistory } from "./assistant.db";
import { REPLIES, inferPriorFromHistory, isArabicText, mergeFilters, pick } from "./assistant.nlu";

/* ----------------------------- rate limiting ---------------------------- */

const LIMIT = 20; // requests per minute per client
let ratelimit: Ratelimit | null = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    ratelimit = new Ratelimit({
      redis: new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN }),
      limiter: Ratelimit.slidingWindow(LIMIT, "1 m"),
      analytics: true,
      prefix: "estatio:assistant:ratelimit",
    });
  } catch (err) {
    console.warn("[RateLimit] Failed to initialise Upstash Redis:", err);
  }
}
if (!ratelimit) {
  // The previous version silently disabled rate limiting without Upstash: the
  // burst test showed 25/25 × 200 and 0 × 429 — an unauthenticated endpoint
  // that spends LLM + embedding tokens per call. Fall back to a per-process
  // sliding window (fine for dev / single instance; use Upstash for multi-instance).
  console.warn("[RateLimit] Upstash not configured — using the in-memory limiter (per-instance).");
}

const memoryHits = new Map<string, number[]>();
function memoryLimit(key: string): boolean {
  const now = Date.now();
  const hits = (memoryHits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= LIMIT) {
    memoryHits.set(key, hits);
    return false;
  }
  hits.push(now);
  memoryHits.set(key, hits);
  if (memoryHits.size > 5_000) for (const k of memoryHits.keys()) { memoryHits.delete(k); break; }
  return true;
}

async function allowed(clientIdentifier: string): Promise<boolean> {
  if (ratelimit) {
    try {
      return (await ratelimit.limit(clientIdentifier)).success;
    } catch (err) {
      console.warn("[RateLimit] Upstash check failed, using memory limiter:", (err as Error).message);
    }
  }
  return memoryLimit(clientIdentifier);
}

/* -------------------------------- handler ------------------------------- */

type HandlerResult = { status: number; body: ChatResponse | { error: string } };

export async function handleChatRequest(rawInput: unknown, clientIdentifier = "anonymous"): Promise<HandlerResult> {
  const parsed = ChatRequestSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { status: 400, body: { error: `Invalid request: ${parsed.error.issues.map((e) => e.message).join(", ")}` } };
  }
  const { message, sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, history: rawHistory, priorFilters } = parsed.data;

  if (!(await allowed(clientIdentifier))) {
    return { status: 429, body: { error: pick({ ar: "طلبات كتير في وقت قصير. استنى لحظة وحاول تاني.", en: "Too many requests. Please wait a moment." }, message) } };
  }

  let history: ChatMessage[] = rawHistory.length > 0 ? rawHistory : [];
  if (history.length === 0) history = await getChatHistory(sessionId, 6);
  void saveChatMessage(sessionId, "user", message);

  const reply = (body: Omit<ChatResponse, "sessionId">, persist: string, ids: number[] = [], filters: ListingFilters = {}): HandlerResult => {
    void saveChatMessage(sessionId, "assistant", persist, ids, filters);
    return { status: 200, body: { ...body, sessionId } };
  };

  // 1. Route (deterministic first, LLM only if ambiguous)
  const prior = priorFilters ?? inferPriorFromHistory(history);
  const t0 = Date.now();
  const route = await classifyAndRoute(message, history, prior);
  console.log(`[Timing] router: ${Date.now() - t0}ms -> type=${route.type} source=${route.source}${route.provider ? `/${route.provider}` : ""}`);

  if (route.unavailable) {
    // Previously this failed CLOSED to out_of_scope, i.e. an infra outage looked like a policy refusal.
    return { status: 503, body: { error: pick(REPLIES.unavailable, message) } };
  }

  if (route.type === "out_of_scope") {
    const text = pick(REPLIES.out_of_scope, message);
    return reply({ text, propertyIds: [], type: "out_of_scope", meta: { source: route.source } }, text);
  }

  if (route.type === "general") {
    const text = pick(REPLIES.general[route.topic ?? "identity"] ?? REPLIES.general.other, message);
    return reply({ text, propertyIds: [], type: "general", meta: { source: route.source } }, text);
  }

  // 2. Nonsense input (zero budget, negative rooms…) -> ask, don't search
  if (route.issues?.length) {
    const text = pick(REPLIES.clarify[route.issues[0]], message);
    return reply({ text, propertyIds: [], type: "general", meta: { source: route.source, reason: `clarify:${route.issues[0]}` } }, text);
  }

  // 3. Filters: follow-ups inherit prior constraints, fresh searches don't
  let filters = mergeFilters(prior, route.filters ?? {});
  if (route.followUp === "cheaper") filters = { ...filters, sortBy: "price_asc" };

  // 4. Hybrid search
  const te = Date.now();
  const queryEmbedding = await getQueryEmbedding(message);
  console.log(`[Timing] embedding: ${Date.now() - te}ms -> ${queryEmbedding ? "ok" : "null (filters-only)"}`);

  const ts = Date.now();
  const { candidates, relaxed } = await searchWithRelaxation(queryEmbedding, filters, 6);
  console.log(`[Timing] search: ${Date.now() - ts}ms -> ${candidates.length} candidates${relaxed.length ? ` (relaxed: ${relaxed.join("; ")})` : ""}`);

  if (candidates.length === 0) {
    const text = pick(REPLIES.noResults, message);
    return reply({ text, propertyIds: [], properties: [], type: "in_scope", filters, meta: { source: route.source } }, text, [], filters);
  }

  // 5. Synthesis (optional polish — the template below is a first-class fallback)
  const tl = Date.now();
  const synth = await synthesizeResponse(message, history, candidates, relaxed);
  console.log(`[Timing] synthesis: ${Date.now() - tl}ms -> ${synth ? `ok/${synth.provider}` : "degraded (template)"}`);

  let text: string;
  let ids: number[];
  if (synth?.object.text) {
    // The model sometimes echoes internal listing ids ("ID: 123", "فيلا 12524 –"); users must never see them.
    text = stripListingIds(synth.object.text, candidates.map((c) => c.property_id));
    // Never trust model-supplied ids: keep only ones that were actually retrieved.
    const known = new Set(candidates.map((c) => c.property_id));
    const requested = synth.object.propertyIds;
    ids = requested !== undefined ? requested.filter((id) => known.has(id)) : candidates.slice(0, 3).map((c) => c.property_id);
    // If the model referenced nothing valid, still show the top matches so text and cards agree.
    if (ids.length === 0) ids = candidates.slice(0, 4).map((c) => c.property_id);
  } else {
    ids = candidates.slice(0, 4).map((c) => c.property_id);
    text = isArabicText(message) ? buildArabicResultsText(candidates, relaxed) : buildEnglishResultsText(candidates, relaxed);
  }

  // Show the recommended listings first so the cards match the text.
  const order = new Map(ids.map((id, i) => [id, i]));
  const properties = [...candidates].sort((a, b) => (order.get(a.property_id) ?? 99) - (order.get(b.property_id) ?? 99));

  return reply(
    {
      text,
      propertyIds: ids,
      properties,
      type: "in_scope",
      filters,
      meta: { source: route.source, synthesis: synth ? "llm" : "template", provider: synth?.provider, relaxed },
    },
    text,
    ids,
    filters,
  );
}

/* ------------------------------ id scrubbing ----------------------------- */

const ID_LABEL = "(?:ID|Id|id|الرقم|رقم|كود|#)";
const MARKS = "[\\u200e\\u200f\\u202a-\\u202e]*";
const UNIT_AFTER = "(?!\\s*(?:م²|م2|م\\b|متر|جنيه|مليون|ألف|الف|غرف|غرفة|حمام|EGP|million|m²|sqm|sq))";

/** Remove retrieved listing ids from model-written text (they are only meant for propertyIds). */
export function stripListingIds(text: string, ids: number[]): string {
  const uniq = [...new Set(ids.map(String))].filter((i) => i.length >= 3);
  if (uniq.length === 0) return text;
  const alt = uniq.sort((x, y) => y.length - x.length).join("|");
  const id = `${MARKS}(?<![\\d.,])(?:${alt})(?![\\d.,])${MARKS}`;
  let out = text
    // "الـ{123}" / "[123]" / "{ID: 123}" — the model sometimes wraps the id in braces; drop the whole token,
    // including a dangling Arabic "الـ" article in front of it.
    .replace(new RegExp(`(?:الـ)?\\s*[\\{\\[<]\\s*(?:${ID_LABEL}\\s*[:：]?\\s*)?${id}\\s*[\\}\\]>]`, "g"), "")
    // "(ID: 123)" / "(123)"
    .replace(new RegExp(`\\(\\s*(?:${ID_LABEL}\\s*[:：]?\\s*)?${id}\\s*\\)`, "g"), "")
    // bullet that starts with a (labelled) id:  "• 123 – ..." / "- ID 123: ..." / "- **123**: ..."
    .replace(new RegExp(`(^|\\n)(\\s*[•\\-*]\\s*)(?:\\*\\*)?(?:${ID_LABEL}\\s*[:：]?\\s*)?${id}(?:\\*\\*)?\\s*[:：–—-]?\\s*`, "g"), "$1$2")
    // labelled id anywhere: "الرقم 123" / "ID: 123" / "#123"
    .replace(new RegExp(`${ID_LABEL}\\s*[:：]?\\s*${id}`, "g"), "")
    // bare id right after a word and not followed by a unit: "فيلا 12524 – 39 مليون"
    .replace(new RegExp(`\\s${id}${UNIT_AFTER}(?=\\s*[–—:：،,-]|\\s*$|\\s*\\n)`, "g"), "");
  out = out
    .replace(/[\u200e\u200f]/g, "")
    .replace(/\(\s*\)/g, "")
    // leftovers when the id sat inside braces/brackets: "الـ{}" / "{}" / "[]"
    .replace(/(?:الـ)?\s*[\{\[]\s*[\}\]]/g, "")
    .replace(/([•*-]\s*)[:：–—-]\s*/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n");
  return out.trim();
}

/* ------------------------------- templates ------------------------------ */

function buildArabicResultsText(candidates: CandidateProperty[], relaxed: string[]): string {
  const lines = candidates.slice(0, 4).map((p) => {
    const title = p.representative_title || `${p.property_type || "عقار"} في ${p.city || "مصر"}`;
    const price = p.price_egp ? `${Number(p.price_egp).toLocaleString("ar-EG")} جنيه` : "السعر عند الطلب";
    const details = [
      p.area_m2 ? `${Number(p.area_m2).toLocaleString("ar-EG")} م²` : null,
      p.rooms ? `${p.rooms} غرف` : null,
      p.baths ? `${p.baths} حمام` : null,
    ].filter(Boolean).join(" • ");
    const location = [p.neighbourhood, p.city].filter(Boolean).join("، ");
    return `• ${title} — ${price}${details ? ` (${details})` : ""}${location ? ` — ${location}` : ""}`;
  });
  const note = relaxed.length ? "\n(ملاحظة: مفيش نتائج مطابقة تماماً للمنطقة المحددة فعرضتلك نتائج في المدينة.)\n" : "";
  const shown = lines.length;
  const header = candidates.length > shown ? `لقيت ${candidates.length} عقار، دي أفضل ${shown} نتايج` : `لقيت لك ${shown} عقار مناسب`;
  return `${header} من قاعدة البيانات:\n\n${lines.join("\n")}\n${note}\nلو تحب، قلّي ميزانيتك أو المنطقة أو عدد الغرف عشان أضيّق النتائج أكتر.`;
}

function buildEnglishResultsText(candidates: CandidateProperty[], relaxed: string[]): string {
  const lines = candidates.slice(0, 4).map((c) => {
    const title = c.representative_title || `${c.property_type || "Property"} in ${c.city || "Egypt"}`;
    const price = c.price_egp ? `${c.price_egp.toLocaleString("en-US")} EGP` : "Price on request";
    const specs = [c.rooms ? `${c.rooms} rooms` : null, c.area_m2 ? `${c.area_m2}m²` : null].filter(Boolean).join(", ");
    return `• **${title}** — ${price}${specs ? ` (${specs})` : ""}${c.url ? ` — [View listing](${c.url})` : ""}`;
  });
  const note = relaxed.length ? `\n(Note: ${relaxed[0]}.)\n` : "";
  const shownEn = lines.length;
  const headerEn = candidates.length > shownEn ? `I found ${candidates.length} matches; here are the top ${shownEn}:` : "Here are the closest matches I found:";
  return `${headerEn}\n\n${lines.join("\n")}\n${note}\nTell me your budget, area or number of rooms to narrow it down.`;
}
