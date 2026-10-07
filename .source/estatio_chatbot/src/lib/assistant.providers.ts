/**
 * LLM provider chain with a circuit breaker.
 *
 * Problems this fixes (all visible in the dev log):
 *  1. OpenRouter `openai/gpt-oss-120b:free` returns HTTP 404 "unavailable for
 *     free" on EVERY call, yet it was retried on every request (a guaranteed
 *     wasted round-trip + a 3 KB error dump each time). A 404/401/403 is not
 *     transient: the breaker opens for 30 min.
 *  2. Groq `openai/gpt-oss-120b` hits its 8 000 tokens-per-minute cap after ~4
 *     requests (429). The response carries `retry-after`; we honour it by
 *     skipping Groq until then instead of hammering it.
 *  3. `maxRetries: 1` + a single `AbortSignal.timeout()` shared with the SDK's
 *     back-off meant the timer fired while the SDK was sleeping ("Delay was
 *     aborted") and the real error was lost. We use maxRetries: 0 and an
 *     independent timeout per attempt; failover is OUR job, not the SDK's.
 *  4. Worst-case latency was 15–27 s per message (10 s Groq timeout, dead
 *     OpenRouter, then a slow NVIDIA call). Every stage now has a total
 *     deadline.
 *  5. `createOpenAI()(model)` targets the Responses API (/v1/responses) in
 *     @ai-sdk/openai v4; OpenRouter-free and NVIDIA NIM speak /chat/completions,
 *     so `.chat()` is used explicitly.
 *  6. Slugs rot (llama-3.3-70b-versatile was decommissioned, gpt-oss-120b:free
 *     disappeared). Model ids are env-configurable so the fix is a config
 *     change, not a deploy.
 */
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, generateText, type LanguageModel } from "ai";
import type { ZodType } from "zod";

export type ProviderName = "groq" | "openrouter" | "nvidia";

interface ProviderSpec {
  name: ProviderName;
  model: string;
  timeoutMs: number;
  /** false => no json_schema support; we ask for raw JSON and parse it. */
  jsonSchema: boolean;
  build: () => LanguageModel | null;
  providerOptions?: Record<string, Record<string, string | number | boolean>>;
}

/* --------------------------- circuit breaker --------------------------- */

const breaker = new Map<ProviderName, { until: number; reason: string }>();

export function providerIsOpen(name: ProviderName): boolean {
  const s = breaker.get(name);
  if (!s) return false;
  if (Date.now() >= s.until) {
    breaker.delete(name);
    return false;
  }
  return true;
}

interface ErrLike {
  name?: string;
  message?: string;
  statusCode?: number;
  responseHeaders?: Record<string, string>;
  lastError?: ErrLike;
  cause?: ErrLike;
}

function unwrap(err: unknown): ErrLike {
  const e = (err ?? {}) as ErrLike;
  return e.lastError ?? e.cause ?? e; // RetryError wraps the real APICallError
}

export function summarizeError(err: unknown): string {
  const e = unwrap(err);
  const msg = (e.message ?? String(err)).replace(/\s+/g, " ").slice(0, 160);
  return `${e.name ?? "Error"}${e.statusCode ? ` ${e.statusCode}` : ""}: ${msg}`;
}

function cooldownMs(err: unknown): { ms: number; reason: string } {
  const e = unwrap(err);
  const status = e.statusCode;
  if (status === 401 || status === 403 || status === 404) return { ms: 30 * 60_000, reason: `permanent(${status})` };
  if (status === 429) {
    const header = Number(e.responseHeaders?.["retry-after"]);
    const fromMsg = /try again in ([\d.]+)\s*(ms|s)/i.exec(e.message ?? "");
    const fromBody = fromMsg ? Number(fromMsg[1]) * (fromMsg[2].toLowerCase() === "ms" ? 1 : 1000) : NaN;
    const ms = Number.isFinite(header) && header > 0 ? header * 1000 : Number.isFinite(fromBody) ? fromBody : 20_000;
    return { ms: Math.min(Math.max(ms + 250, 1_000), 60_000), reason: "rate_limited" };
  }
  if (e.name === "TimeoutError" || e.name === "AbortError") return { ms: 10_000, reason: "timeout" };
  if (status && status >= 500) return { ms: 15_000, reason: `upstream(${status})` };
  return { ms: 5_000, reason: "error" };
}

function trip(name: ProviderName, err: unknown, label: string) {
  const { ms, reason } = cooldownMs(err);
  breaker.set(name, { until: Date.now() + ms, reason });
  console.warn(`[LLM:${label}] ${name} failed (${reason}), skipping it for ${Math.round(ms / 1000)}s — ${summarizeError(err)}`);
}

/* ------------------------------ providers ------------------------------ */

const env = (k: string) => process.env[k]?.trim() || undefined;

function specs(stage: "router" | "synthesis"): ProviderSpec[] {
  const groqModel = (stage === "router" && env("GROQ_ROUTER_MODEL")) || env("GROQ_MODEL") || "openai/gpt-oss-120b";
  const all: Record<ProviderName, ProviderSpec> = {
    groq: {
      name: "groq",
      model: groqModel,
      timeoutMs: stage === "router" ? 4_000 : 7_000,
      jsonSchema: true,
      build: () => (env("GROQ_API_KEY") ? createGroq({ apiKey: env("GROQ_API_KEY")! })(groqModel) : null),
      // gpt-oss is a reasoning model; default effort burned 6–9 s and counts
      // against the 8k TPM cap. Routing/summarising needs none of it.
      // strictJsonSchema:false -> Groq rejected our schemas with HTTP 400 ("required must
      // include every key") because optional fields (propertyIds, topic, filters.*) are
      // not allowed in strict mode. Non-strict still returns schema-shaped JSON and zod validates it.
      providerOptions: { groq: { reasoningEffort: "low", strictJsonSchema: false } },
    },
    openrouter: {
      name: "openrouter",
      // Must be a slug that is currently free for your account (slugs rotate off free;
      // the llama-3.3 and gpt-oss ':free' slugs returned 404). Override with OPENROUTER_MODEL.
      // Reasoning model: kept LAST in the order so it only runs if groq and nvidia both fail.
      model: env("OPENROUTER_MODEL") || "dots-studio/dots-3-note-preview:free",
      timeoutMs: 8_000,
      jsonSchema: true,
      build: () =>
        env("OPENROUTER_API_KEY")
          ? createOpenAI({ apiKey: env("OPENROUTER_API_KEY")!, baseURL: "https://openrouter.ai/api/v1" }).chat(
              env("OPENROUTER_MODEL") || "dots-studio/dots-3-note-preview:free",
            )
          : null,
    },
    nvidia: {
      name: "nvidia",
      model: env("NVIDIA_CHAT_MODEL") || "meta/llama-3.2-11b-vision-instruct",
      timeoutMs: 8_000,
      jsonSchema: false,
      build: () =>
        env("NVIDIA_API_KEY")
          ? createOpenAI({ apiKey: env("NVIDIA_API_KEY")!, baseURL: "https://integrate.api.nvidia.com/v1" }).chat(
              env("NVIDIA_CHAT_MODEL") || "meta/llama-3.2-11b-vision-instruct",
            )
          : null,
    },
  };
  const order = (env("LLM_PROVIDER_ORDER") || "groq,nvidia,openrouter")
    .split(",")
    .map((s) => s.trim() as ProviderName)
    .filter((n) => n in all);
  return order.map((n) => all[n]);
}

/** Models often put raw newlines/tabs inside JSON strings ("Bad control character"). Escape them. */
function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) { escaped = false; out += ch; continue; }
      if (ch === "\\") { escaped = true; out += ch; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      if (ch < " ") continue; // drop other control chars
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

function parseJsonFromLlm(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const body = start !== -1 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(escapeControlCharsInStrings(body));
  }
}

/**
 * Try providers in order, skipping any whose breaker is open, with a hard
 * total deadline. Returns null if nothing succeeded (caller degrades).
 */
export async function runStructured<T>(opts: {
  stage: "router" | "synthesis";
  schema: ZodType<T>;
  prompt: string;
  /** Appended for providers without json_schema support. */
  jsonShapeHint: string;
  maxOutputTokens: number;
  deadlineMs: number;
}): Promise<{ object: T; provider: ProviderName } | null> {
  const deadline = Date.now() + opts.deadlineMs;
  for (const p of specs(opts.stage)) {
    if (providerIsOpen(p.name)) continue;
    const model = p.build();
    if (!model) continue;
    const remaining = deadline - Date.now();
    if (remaining < 800) break;
    const abortSignal = AbortSignal.timeout(Math.min(p.timeoutMs, remaining));
    try {
      if (p.jsonSchema) {
        const res = await generateObject({
          model,
          schema: opts.schema,
          prompt: opts.prompt,
          maxRetries: 0,
          abortSignal,
          maxOutputTokens: opts.maxOutputTokens,
          ...(p.providerOptions ? { providerOptions: p.providerOptions } : {}),
        });
        return { object: res.object as T, provider: p.name };
      }
      const res = await generateText({
        model,
        prompt: `${opts.prompt}\n\nReply with ONLY a raw JSON object (no markdown, no prose) shaped like:\n${opts.jsonShapeHint}`,
        maxRetries: 0,
        abortSignal,
        maxOutputTokens: opts.maxOutputTokens,
      });
      return { object: opts.schema.parse(parseJsonFromLlm(res.text)), provider: p.name };
    } catch (err) {
      trip(p.name, err, opts.stage);
    }
  }
  return null;
}

/** For /api/health and startup diagnostics. */
export function providerStatus() {
  return (["groq", "openrouter", "nvidia"] as ProviderName[]).map((name) => {
    const s = breaker.get(name);
    return { name, open: providerIsOpen(name), reason: s?.reason, retryInMs: s ? Math.max(0, s.until - Date.now()) : 0 };
  });
}
