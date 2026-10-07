import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { CandidateProperty, ListingFilters, ChatMessage } from "./assistant.schemas";
import { canonicalPropertyType } from "./assistant.nlu";

let propertySupabaseInstance: SupabaseClient | null = null;
let accountsSupabaseInstance: SupabaseClient | null = null;

/** Supabase project containing properties, embeddings, and real-estate RPCs. */
export function getPropertySupabase(): SupabaseClient {
  if (propertySupabaseInstance) return propertySupabaseInstance;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment.");
  }

  propertySupabaseInstance = createClient(url, key, {
    auth: { persistSession: false },
  });

  return propertySupabaseInstance;
}

/** Supabase project containing users, chat messages, and session state. */
export function getAccountsSupabase(): SupabaseClient | null {
  if (accountsSupabaseInstance) return accountsSupabaseInstance;

  const url = process.env.ACCOUNTS_SUPABASE_URL?.trim();
  const key = process.env.ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY?.trim();

  // Chat persistence is optional for answering a request. Never construct a
  // Supabase client from a placeholder or malformed value because that turns a
  // successful property search into a server error log on every message.
  if (!url || !key || !isSupabaseUrl(url)) {
    console.warn("[DB] Accounts Supabase is unavailable; chat memory will not be persisted until ACCOUNTS_SUPABASE_URL and ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY are configured.");
    return null;
  }

  try {
    accountsSupabaseInstance = createClient(url, key, {
      auth: { persistSession: false },
    });
    return accountsSupabaseInstance;
  } catch (error) {
    console.warn("[DB] Accounts Supabase client could not be initialized; chat memory is disabled:", error);
    return null;
  }
}

function isSupabaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.endsWith(".supabase.co");
  } catch {
    return false;
  }
}

/** Backwards-compatible alias for real-estate database callers. */
export const getSupabase = getPropertySupabase;

/**
 * 5. Hybrid search (Supabase RPC with structured filter fallback).
 * Structured filters are hard constraints, vector distance ranks matches.
 */
export async function searchProperties(
  queryEmbedding: number[] | null,
  filters: ListingFilters,
  limit: number = 6
): Promise<CandidateProperty[]> {
  const supabase = getSupabase();

  const maxBudget = filters.maxBudget || filters.budget || null;

  // 1. Try vector RPC as the primary path: structured filters are hard
  // constraints (passed through to the SQL WHERE clause), vector distance
  // ranks within them.
  // Studios have no property_type of their own (they are شقق with "استوديو" in the
  // title), and the RPC cannot filter on titles, so they go straight to the structured query.
  const studio = isStudioRequest(filters.property_type);
  if (!studio && queryEmbedding && queryEmbedding.length > 0) {
    try {
      const { data, error } = await supabase.rpc("match_properties", {
        query_embedding: queryEmbedding,
        p_city: filters.neighbourhood || filters.city || null, // most specific wins
        p_budget: maxBudget,
        p_type: normalizePropertyTypeForQuery(filters.property_type),
        p_rooms: filters.rooms ?? null,
        match_count: Math.max(limit * 4, 24),
      });

      if (!error && Array.isArray(data) && data.length > 0) {
        const mapped = data.map((row: any) => mapDbRow({
          ...row,
          price_egp: row.price_egp !== null ? Number(row.price_egp) : Number(row.price ?? 0),
          property_id: row.property_id || row.id,
        }));
        const ordered = filters.sortBy === "price_asc"
          ? [...mapped].sort((a, b) => (a.price_egp ?? Infinity) - (b.price_egp ?? Infinity))
          : mapped;
        return ordered.slice(0, limit);
      }
      if (error) console.warn("[DB] match_properties RPC returned an error, falling back to structured query:", error.message);
    } catch (rpcErr) {
      console.warn("[DB] match_properties RPC threw, falling back to structured query:", rpcErr);
    }
  }

  // 2. Structured fallback query on property_features / properties —
  // used when the vector RPC is unavailable, errors, or (with no query
  // embedding) when only structured filters were extracted.
  try {
    let query = supabase
      .from("property_features")
      .select(
        "property_id, property_type, rooms, baths, area_m2, city, neighbourhood, price_egp, price_per_m2, representative_title, url"
      );

    if (filters.city || filters.neighbourhood) {
      const locationTerms = [filters.city, filters.neighbourhood]
        .filter((value): value is string => Boolean(value?.trim()))
        .flatMap((value) => locationAliases(value.trim()))
        .map((value) => quoteForOr(value));
      // Values go inside double quotes so a `,` `(` `)` in a (possibly
      // LLM-produced) term can't inject extra PostgREST filter clauses.
      const locationClauses = locationTerms.flatMap((term) => [
        `city.ilike."%${term}%"`,
        `neighbourhood.ilike."%${term}%"`,
      ]);
      query = query.or(locationClauses.join(","));
    }
    const normalizedType = normalizePropertyTypeForQuery(filters.property_type);
    if (studio) {
      query = query.ilike("property_type", "%شقق%");
      query = query.or(STUDIO_TITLE_TERMS.map((t) => `representative_title.ilike."%${t}%"`).join(","));
    } else if (normalizedType) {
      query = query.ilike("property_type", `%${escapeIlike(normalizedType.trim())}%`);
    }
    const maxBudget = filters.maxBudget || filters.budget;
    if (maxBudget && maxBudget > 0) query = query.lte("price_egp", maxBudget);
    if (filters.minBudget && filters.minBudget > 0) query = query.gte("price_egp", filters.minBudget);
    if (filters.rooms && filters.rooms > 0) query = query.gte("rooms", filters.rooms);
    if (filters.minArea && filters.minArea > 0) query = query.gte("area_m2", filters.minArea);

    const { data, error } = await query
      .order("price_egp", { ascending: true, nullsFirst: false })
      .limit(limit);

    if (error) {
      // If property_features view does not exist, try properties table
      console.warn("[DB] property_features query error, trying properties table:", error.message);
      const fallbackQuery = supabase
        .from("properties")
        .select(
          "id, property_type, rooms, baths, area_m2, current_price_egp, price_per_m2"
        )
        .limit(limit);
      const res = await fallbackQuery;
      if (res.error) throw res.error;
      return (res.data || []).map(mapDbRow);
    }

    return rankCandidates(
      (data || []).map(mapDbRow).filter((property) => matchesHardFilters(property, filters)),
      filters,
    ).slice(0, limit);
  } catch (err) {
    console.error("[DB] All search attempts failed:", err);
    return [];
  }
}

function locationAliases(value: string): string[] {
  const normalized = value.toLocaleLowerCase("ar");
  if (normalized.includes("القاهرة")) return ["القاهرة", "cairo", "new cairo", "التجمع", "مدينة نصر"];
  if (normalized.includes("الساحل")) return ["الساحل الشمالي", "north coast", "الساحل"];
  if (normalized.includes("الشيخ زايد") || normalized === "زايد") return ["الشيخ زايد", "sheikh zayed", "زايد"];
  if (normalized.includes("أكتوبر")) return ["6 أكتوبر", "october", "أكتوبر"];
  return [value];
}

function matchesLocation(value: string | null, requested: string): boolean {
  if (!value) return false;
  const normalizedValue = value.toLocaleLowerCase("ar");
  return locationAliases(requested).some((alias) => normalizedValue.includes(alias.toLocaleLowerCase("ar")));
}

function rankCandidates(properties: CandidateProperty[], filters: ListingFilters): CandidateProperty[] {
  const maxBudget = filters.maxBudget || filters.budget;
  return [...properties].sort((a, b) => candidateScore(b, filters, maxBudget) - candidateScore(a, filters, maxBudget));
}

function candidateScore(property: CandidateProperty, filters: ListingFilters, maxBudget?: number): number {
  let score = 0;
  if (filters.city && (matchesLocation(property.city, filters.city) || matchesLocation(property.neighbourhood, filters.city))) score += 40;
  if (filters.neighbourhood && (matchesLocation(property.neighbourhood, filters.neighbourhood) || matchesLocation(property.city, filters.neighbourhood))) score += 35;
  if (filters.property_type && matchesPropertyType(property.property_type, filters.property_type)) score += 25;
  if (filters.rooms && property.rooms != null) score += Math.max(0, 20 - Math.abs(property.rooms - filters.rooms) * 5);
  if (maxBudget && property.price_egp != null) score += property.price_egp <= maxBudget ? 15 : Math.max(0, 15 - ((property.price_egp - maxBudget) / maxBudget) * 15);
  if (filters.minArea && property.area_m2 != null) score += property.area_m2 >= filters.minArea ? 10 : 0;
  return score;
}

/** Studios are stored as شقق whose title mentions the word (see assistant.nlu.ts). */
const STUDIO_TITLE_TERMS = ["استوديو", "ستوديو", "استديو", "studio"];

function isStudioRequest(requested: string | undefined | null): boolean {
  return canonicalPropertyType(requested) === "استوديو";
}

function titleMentionsStudio(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.toLocaleLowerCase("ar");
  return STUDIO_TITLE_TERMS.some((term) => t.includes(term));
}

function normalizePropertyTypeForQuery(requested: string | undefined | null): string | null {
  // Single source of truth lives in assistant.nlu (Arabic + English, singular +
  // plural -> the value stored in property_features.property_type).
  return canonicalPropertyType(requested);
}

function matchesPropertyType(actual: string | null, requested: string): boolean {
  if (!actual) return false;
  const normalize = (value: string) => value.toLocaleLowerCase("ar").replace(/[أةإآ]/g, "ا").replace(/ة/g, "ه").trim();
  const actualType = normalize(actual);
  const requestedType = normalize(requested);
  const aliases: Record<string, string[]> = {
    شقه: ["شقه", "شقق", "apartment"],
    فيلا: ["فيلا", "فلل", "villa"],
    شاليه: ["شاليه", "شاليهات", "chalet"],
    استوديو: ["استوديو", "استديو", "studio"],
  };
  return (aliases[requestedType] || [requestedType]).some((alias) => actualType.includes(normalize(alias)));
}

function matchesHardFilters(property: CandidateProperty, filters: ListingFilters): boolean {
  const maxBudget = filters.maxBudget || filters.budget;
  if (filters.city && !matchesLocation(property.city, filters.city) && !matchesLocation(property.neighbourhood, filters.city)) return false;
  if (filters.neighbourhood && !matchesLocation(property.neighbourhood, filters.neighbourhood) && !matchesLocation(property.city, filters.neighbourhood)) return false;
  if (filters.property_type) {
    if (isStudioRequest(filters.property_type)) {
      if (!matchesPropertyType(property.property_type, "شقق") || !titleMentionsStudio(property.representative_title)) return false;
    } else if (!matchesPropertyType(property.property_type, filters.property_type)) return false;
  }
  if (filters.rooms && (property.rooms == null || property.rooms < filters.rooms)) return false;
  if (filters.minBudget && (property.price_egp == null || property.price_egp < filters.minBudget)) return false;
  if (maxBudget && (property.price_egp == null || property.price_egp > maxBudget)) return false;
  if (filters.minArea && (property.area_m2 == null || property.area_m2 < filters.minArea)) return false;
  return true;
}

/** Escape LIKE wildcards so user text is matched literally (for `.ilike()`). */
function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * For values embedded in a PostgREST `.or()` string: LIKE-escape, then escape
 * for the double-quoted PostgREST value syntax (`\` and `"`), then the caller
 * wraps the result in quotes.
 */
function quoteForOr(value: string): string {
  return escapeIlike(value).replace(/[\\"]/g, "\\$&");
}

function mapDbRow(row: any): CandidateProperty {
  return {
    property_id: Number(row.property_id || row.id),
    city: row.city ?? null,
    neighbourhood: row.neighbourhood ?? null,
    property_type: row.property_type ?? null,
    rooms: row.rooms !== null ? Number(row.rooms) : null,
    baths: row.baths !== null ? Number(row.baths) : null,
    area_m2: row.area_m2 !== null ? Number(row.area_m2) : null,
    price_egp: row.price_egp ?? row.current_price_egp ?? null,
    price_per_m2: row.price_per_m2 !== null ? Number(row.price_per_m2) : null,
    representative_title: row.representative_title ?? null,
    url: row.url ?? null,
  };
}

/**
 * Save chat message to database for persistence and auditing.
 */
export async function saveChatMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  propertyIds: number[] = [],
  filters: ListingFilters = {}
): Promise<void> {
  try {
    const supabase = getAccountsSupabase();
    if (!supabase) return;
    const { error } = await supabase.from("chat_messages").insert({
      session_id: sessionId,
      role,
      content,
      property_ids: propertyIds,
      filters,
    });

    if (error) {
      console.warn("[DB] chat_messages insert failed:", error.message);
    }
  } catch (err) {
    console.warn("[DB] Failed to save chat message to DB:", err);
  }
}

/**
 * Fetch recent chat history by session_id.
 */
export async function getChatHistory(sessionId: string, limit: number = 6): Promise<ChatMessage[]> {
  try {
    const supabase = getAccountsSupabase();
    if (!supabase) return [];
    const { data, error } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error || !data) return [];
    return data.map((d: any) => ({
      role: d.role === "assistant" ? "assistant" : "user",
      content: String(d.content || ""),
    }));
  } catch (err) {
    return [];
  }
}

/**
 * Retrieve the accumulated session filters from the latest assistant turn.
 */
export async function getSessionFilters(sessionId: string): Promise<ListingFilters> {
  try {
    const supabase = getAccountsSupabase();
    if (!supabase) return {};
    const { data, error } = await supabase
      .from("chat_messages")
      .select("filters")
      .eq("session_id", sessionId)
      .eq("role", "assistant")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !data || !data.filters) return {};
    return data.filters as ListingFilters;
  } catch {
    return {};
  }
}


/* ------------------------------------------------------------------ */
/* Resilient search: spelling variants + transparent relaxation        */
/* ------------------------------------------------------------------ */

/**
 * ILIKE is accent-sensitive: "أكتوبر" does not match "اكتوبر", "الإسكندرية"
 * does not match "الاسكندريه". area_02 (6 أكتوبر) returned 0 rows for exactly
 * this reason. We try the common orthographic variants (original first).
 */
export function arabicVariants(term: string, cap = 6): string[] {
  const out = new Set<string>([term]);
  const add = (t: string) => { if (out.size < cap) out.add(t); };
  const alef = term.replace(/[أإآ]/g, "ا");
  const hamza = term.replace(/(?<=\s|^)ا(?!ل)/g, "أ").replace(/ا(?=كتوبر)/g, "أ");
  const ta = term.replace(/ة(?=\s|$)/g, "ه");
  const ya = term.replace(/ى/g, "ي");
  [alef, hamza, ta, ya, alef.replace(/ة(?=\s|$)/g, "ه")].forEach(add);
  return [...out];
}

export interface SearchOutcome {
  candidates: CandidateProperty[];
  /** Human-readable notes about constraints that were loosened to find results. */
  relaxed: string[];
}

/**
 * Hard constraints stay hard (type, budget, rooms). Only LOCATION precision is
 * relaxed (neighbourhood -> city) and the response says so, so the user is never
 * silently shown something they did not ask for.
 */
export async function searchWithRelaxation(
  queryEmbedding: number[] | null,
  filters: ListingFilters,
  limit = 6,
): Promise<SearchOutcome> {
  const attempts: Array<{ f: ListingFilters; note?: string }> = [{ f: filters }];
  if (filters.neighbourhood && filters.city) {
    attempts.push({
      f: { ...filters, neighbourhood: undefined },
      note: `no exact matches in ${filters.neighbourhood}; showing ${filters.city} instead`,
    });
  }

  for (const { f, note } of attempts) {
    const loc = f.neighbourhood || f.city;
    const variants = loc ? arabicVariants(loc) : [undefined];
    for (const v of variants) {
      const attemptFilters: ListingFilters = v === undefined ? f : { ...f, city: v, neighbourhood: undefined };
      const candidates = await searchProperties(queryEmbedding, attemptFilters, limit);
      if (candidates.length > 0) return { candidates, relaxed: note ? [note] : [] };
    }
  }
  return { candidates: [], relaxed: [] };
}
