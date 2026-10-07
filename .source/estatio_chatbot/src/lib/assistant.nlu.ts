/**
 * Deterministic language layer (no network, no LLM, no runtime deps).
 *
 * Why this exists: the LLM router is slow (0.6–11 s in the logs), rate limited
 * and — when every provider fails — used to fail CLOSED to "out_of_scope",
 * which made English/general/follow-up messages look like refusals. Anything
 * this module can decide with confidence never needs a model.
 *
 * Everything here is pure so it can be unit-tested (see tests/nlu.test.ts).
 */
import type { ListingFilters } from "./assistant.schemas";

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Canonical form used for MATCHING only (never shown to users):
 * Arabic-Indic/Persian digits -> ASCII, diacritics/tatweel stripped,
 * أإآٱ -> ا, ى -> ي, ة -> ه, lower-cased, whitespace collapsed.
 *
 * The original code only handled ASCII digits (`\d`) and only normalised
 * hamza/ta-marbuta for property types, so "٣ غرف" or "أكتوبر"/"اكتوبر"
 * silently failed to match.
 */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKC") // also folds "م²" -> "م2"
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function isArabicText(text: string): boolean {
  return /[\u0600-\u06ff]/.test(text);
}

/**
 * JS `\b` only understands ASCII word characters, so `\bأرض\b` can NEVER
 * match (the original strongPropertySignal had exactly that bug). Use Unicode
 * look-arounds instead, and allow the common Arabic one-letter prefixes
 * (و ب ل ف ك, ال, لل, بال, وال) in front of a term.
 */
function term(alts: string[]): RegExp {
  const body = alts.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:[وبلفك]?ال|لل|[وبلفك])?(?:${body})(?![\\p{L}\\p{N}])`, "u");
}

/* ------------------------------------------------------------------ */
/* Property types                                                      */
/* ------------------------------------------------------------------ */

/**
 * `db` is the value as STORED in property_features.property_type, verified against
 * the live data (select property_type, count(*) ... group by 1):
 *   شقق 19869 · شاليهات 7651 · فيلات 6982 · تاون هاوس 2781 · توين هاوس 1803 ·
 *   دوبليكس 1321 · بنتهاوس 896 · اي فيلا 435 · شقق فندقية 259 · أراضي 175 · ...
 * There is NO "استوديو" type: studios are stored as شقق with "استوديو" in the title.
 * "استوديو" below is therefore a LOGICAL type; assistant.db.ts translates it into
 * property_type=شقق + a title match.
 */
const PROPERTY_TYPES: Array<{ db: string; alts: string[] }> = [
  { db: "شقق", alts: ["شقه", "شقق", "apartment", "apartments", "flat", "flats", "apt"] },
  { db: "فيلات", alts: ["فيلا", "فيلات", "فلل", "villa", "villas"] },
  { db: "شاليهات", alts: ["شاليه", "شاليهات", "chalet", "chalets"] },
  { db: "استوديو", alts: ["استوديو", "استديو", "ستوديو", "studio", "studios"] },
  { db: "دوبليكس", alts: ["دوبلكس", "دوبليكس", "duplex", "duplexes"] },
  { db: "بنتهاوس", alts: ["بنتهاوس", "بنت هاوس", "penthouse", "penthouses"] },
  { db: "تاون هاوس", alts: ["تاون هاوس", "تاونهاوس", "town house", "townhouse", "townhouses"] },
  { db: "توين هاوس", alts: ["توين هاوس", "توينهاوس", "twin house", "twinhouse", "twin houses"] },
  { db: "أراضي", alts: ["ارض", "اراضي", "land", "plot", "plots"] },
];

const TYPE_MATCHERS = PROPERTY_TYPES.map((t) => ({ db: t.db, re: term(t.alts.map(normalizeText)) }));

/** Map any spelling/language (Arabic, English, singular/plural) to the DB value. */
export function canonicalPropertyType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const n = normalizeText(raw);
  for (const t of TYPE_MATCHERS) if (t.re.test(n)) return t.db;
  return raw.trim() || null; // unknown: pass through rather than silently drop
}

/* ------------------------------------------------------------------ */
/* Places                                                              */
/* ------------------------------------------------------------------ */

interface Place {
  names: string[];
  city: string;
  neighbourhood?: string;
}

/**
 * Longest matching name wins. The original code mapped "مدينة نصر" and
 * "المعادي" to the whole city "القاهرة" (or to NO location at all for Maadi),
 * so those queries returned listings from anywhere in Cairo / Egypt.
 * Values are matched with ILIKE '%…%' against city OR neighbourhood.
 */
const PLACES: Place[] = [
  { names: ["التجمع الخامس", "التجمع", "fifth settlement", "5th settlement", "tagamoa", "tagamo3"], city: "القاهرة", neighbourhood: "التجمع" },
  { names: ["القاهرة الجديدة", "new cairo"], city: "القاهرة" },
  { names: ["مدينة نصر", "nasr city"], city: "القاهرة", neighbourhood: "مدينة نصر" },
  { names: ["المعادي", "maadi"], city: "القاهرة", neighbourhood: "المعادي" },
  { names: ["الشروق", "el shorouk", "shorouk"], city: "القاهرة", neighbourhood: "الشروق" },
  { names: ["الرحاب", "rehab"], city: "القاهرة", neighbourhood: "الرحاب" },
  { names: ["مدينتي", "madinaty"], city: "القاهرة", neighbourhood: "مدينتي" },
  { names: ["العاصمة الإدارية", "العاصمه الاداريه", "new capital", "administrative capital"], city: "العاصمة الإدارية" },
  { names: ["القاهرة", "cairo"], city: "القاهرة" },
  { names: ["الشيخ زايد", "sheikh zayed", "sheikh zayd", "zayed"], city: "الشيخ زايد" },
  { names: ["السادس من أكتوبر", "6 أكتوبر", "6 october", "6th of october", "october city", "أكتوبر", "october"], city: "أكتوبر" },
  { names: ["الساحل الشمالي", "north coast", "الساحل"], city: "الساحل الشمالي" },
  { names: ["العين السخنة", "ain sokhna", "sokhna"], city: "العين السخنة" },
  { names: ["الغردقة", "hurghada"], city: "الغردقة" },
  { names: ["الجونة", "el gouna", "gouna"], city: "الجونة" },
  { names: ["الإسكندرية", "اسكندرية", "alexandria"], city: "الإسكندرية" },
  { names: ["الجيزة", "giza"], city: "الجيزة" },
];

const PLACE_MATCHERS = PLACES.flatMap((p) =>
  p.names.map((n) => {
    const nn = normalizeText(n);
    return { place: p, len: nn.length, re: term([nn]) };
  }),
).sort((a, b) => b.len - a.len);

export function extractPlace(normalized: string): { city?: string; neighbourhood?: string } {
  for (const m of PLACE_MATCHERS) {
    if (m.re.test(normalized)) return { city: m.place.city, neighbourhood: m.place.neighbourhood };
  }
  return {};
}

/* ------------------------------------------------------------------ */
/* Numbers: budget, rooms, area                                        */
/* ------------------------------------------------------------------ */

const MAX_CUES = /(اقل من|تحت|حد اقصي|بحد اقصي|اقصي|لحد|لغايه|حدود|ميزانيه|ميزانيتي|under|below|less than|max|up to|within|budget|around|about|upto)/;
const MIN_CUES = /(اكتر من|اكثر من|فوق|over|above|more than|at least|min(?:imum)?|starting)/;
const RANGE_CUES = /(من .* (?:الي|ل|لحد|to)|بين|between|from .* to|\d\s*-\s*\d)/;

interface MoneyToken {
  value: number;
  index: number;
}

function findMoneyTokens(n: string): MoneyToken[] {
  const out: MoneyToken[] = [];
  const unit = /(\d+(?:[.,]\d+)?)\s*(مليون|ملايين|million|mil|m|الف|k|thousand)(?![a-z\p{L}])/gu;
  let m: RegExpExecArray | null;
  while ((m = unit.exec(n))) {
    const num = Number(m[1].replace(",", "."));
    const u = m[2];
    let value = u === "الف" || u === "k" || u === "thousand" ? num * 1_000 : num * 1_000_000;
    // "٢ مليون ونص" / "2 million and a half"
    const tail = n.slice(m.index + m[0].length, m.index + m[0].length + 14);
    if (value >= 1_000_000 && /^\s*(?:و\s?نص|and a half)/.test(tail)) value += 500_000;
    out.push({ value, index: m.index });
  }
  const dual = /(?<![\p{L}])(?:[وبلفك]?ال|لل|[وبلفك])?مليونين(?![\p{L}])/u.exec(n);
  if (dual) out.push({ value: 2_000_000, index: dual.index });
  // Bare "مليون" / "مليون ونص" with no digit ("بمليون ونص" = 1.5M)
  const bare = /(?<![\d\p{L}])(?:[وبلفك]?ال|لل|[وبلفك])?مليون(?![\p{L}])(\s*و\s?نص)?/u.exec(n);
  if (bare && !out.length) out.push({ value: bare[1] ? 1_500_000 : 1_000_000, index: bare.index });
  // Plain large numbers: 5,000,000 / 5000000 (optionally followed by جنيه/egp)
  const plain = /(?<![\d.,])(\d{1,3}(?:,\d{3}){2,}|\d{6,9})(?![\d])/g;
  while ((m = plain.exec(n))) {
    const value = Number(m[1].replace(/,/g, ""));
    if (!out.some((t) => Math.abs(t.index - m!.index) < 8)) out.push({ value, index: m.index });
  }
  return out.sort((a, b) => a.index - b.index);
}

const WORD_NUMBERS: Record<string, number> = {
  واحد: 1, واحده: 1, اتنين: 2, اثنين: 2, تلات: 3, تلاته: 3, ثلاث: 3, ثلاثه: 3,
  اربع: 4, اربعه: 4, خمس: 5, خمسه: 5, ست: 6, سته: 6,
};

function extractRooms(n: string): number | undefined {
  const digit = /(\d{1,3})\s*\+?\s*(?:غرف نوم|غرف|غرفه|اوض|اوضه|bed(?:room)?s?|br|bd)(?![a-z\p{L}])/u.exec(n);
  if (digit) return Number(digit[1]);
  if (/(غرفتين|اوضتين|غرفتان)/.test(n)) return 2;
  const word = /(واحد|واحده|اتنين|اثنين|تلات|تلاته|ثلاث|ثلاثه|اربع|اربعه|خمس|خمسه|ست|سته)\s*(?:غرف|اوض)/u.exec(n);
  if (word) return WORD_NUMBERS[word[1]];
  return undefined;
}

function extractArea(n: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*(?:متر|م2|sqm|sq ?m|m2|square met(?:er|re)s?)(?![a-z\p{L}])/u.exec(n);
  return m ? Number(m[1]) : undefined;
}

/* ------------------------------------------------------------------ */
/* Filter extraction                                                   */
/* ------------------------------------------------------------------ */

export interface ExtractedFilters {
  filters: ListingFilters;
  /** Problems that should trigger a clarification instead of a search. */
  issues: Array<"zero_budget" | "negative_number" | "rooms_out_of_range">;
}

export function extractFilters(message: string): ExtractedFilters {
  const n = normalizeText(message);
  const filters: ListingFilters = {};
  const issues: ExtractedFilters["issues"] = [];

  const type = TYPE_MATCHERS.find((t) => t.re.test(n));
  if (type) filters.property_type = type.db;

  const place = extractPlace(n);
  if (place.city) filters.city = place.city;
  if (place.neighbourhood) filters.neighbourhood = place.neighbourhood;

  // Nonsense inputs the original code silently turned into an unconstrained search.
  if (/(ميزانيه|budget)\s*(?:صفر|0)(?![\d])|(?<![\d])(?:صفر|0)\s*(?:جنيه|egp)/u.test(n)) issues.push("zero_budget");
  if (/(?:^|\s)-\s*\d+\s*(?:غرف|غرفه|اوض|bed|br)/u.test(n) || /(?:^|\s)-\d/.test(n)) issues.push("negative_number");

  const rooms = extractRooms(n);
  if (rooms !== undefined) {
    if (rooms > 20) issues.push("rooms_out_of_range");
    else if (rooms >= 0 && !issues.includes("negative_number")) filters.rooms = rooms;
  }

  const area = extractArea(n);
  if (area && area > 0) filters.minArea = area;

  // "من 3 الى 5 مليون" / "between 3 and 5 million": one shared unit for both numbers.
  const sharedRange = /(\d+(?:[.,]\d+)?)\s*(?:الي|ل|to|-|و|and)\s*(\d+(?:[.,]\d+)?)\s*(مليون|ملايين|million|m|الف|k)(?![a-z\p{L}])/u.exec(n);
  const money = findMoneyTokens(n).filter((t) => t.value > 0 && t.value <= 500_000_000);
  if (sharedRange) {
    const mult = ["الف", "k"].includes(sharedRange[3]) ? 1_000 : 1_000_000;
    const a = Number(sharedRange[1].replace(",", ".")) * mult;
    const b = Number(sharedRange[2].replace(",", ".")) * mult;
    filters.minBudget = Math.min(a, b);
    filters.maxBudget = Math.max(a, b);
  } else if (money.length >= 2 && RANGE_CUES.test(n)) {
    const values = money.map((t) => t.value);
    filters.minBudget = Math.min(...values);
    filters.maxBudget = Math.max(...values);
  } else if (money.length >= 1) {
    const t = money[0];
    const before = n.slice(Math.max(0, t.index - 24), t.index + 1);
    if (MAX_CUES.test(before)) filters.maxBudget = t.value;
    else if (MIN_CUES.test(before)) filters.minBudget = t.value;
    else filters.maxBudget = t.value; // a lone figure is overwhelmingly a ceiling
  }

  return { filters, issues };
}

/** Follow-up refinements may inherit prior constraints; fresh searches may not. */
export function mergeFilters(prior: ListingFilters | undefined, current: ListingFilters): ListingFilters {
  if (!prior) return current;
  const mentionsNewSearch = Boolean(current.property_type || current.city || current.neighbourhood);
  if (mentionsNewSearch) return current;
  return { ...prior, ...Object.fromEntries(Object.entries(current).filter(([, v]) => v !== undefined)) };
}

/** Rebuild the running search context from earlier USER turns (no DB needed). */
export function inferPriorFromHistory(history: Array<{ role: string; content: string }>): ListingFilters | undefined {
  let acc: ListingFilters | undefined;
  for (const m of history) {
    if (m.role !== "user") continue;
    const f = extractFilters(m.content).filters;
    if (Object.keys(f).length === 0) continue;
    acc = mergeFilters(acc, f);
  }
  return acc && Object.keys(acc).length ? acc : undefined;
}

/* ------------------------------------------------------------------ */
/* Deterministic router                                                */
/* ------------------------------------------------------------------ */

export type RouteType = "in_scope" | "out_of_scope" | "general";
export type GeneralTopic = "identity" | "capabilities" | "how_to_find" | "valuation" | "other";

export interface HeuristicRoute {
  /** null = ambiguous, ask the LLM router. */
  type: RouteType | null;
  topic?: GeneralTopic;
  filters: ListingFilters;
  issues: ExtractedFilters["issues"];
  followUp?: "cheaper" | "more";
  reason: string;
}

const REAL_ESTATE_WORDS = term(
  ["عقار", "عقارات", "بيت", "منزل", "property", "properties", "real estate", "house", "home", "bedroom", "bedrooms", "للبيع", "للايجار", "for sale", "for rent"].map(normalizeText),
);
const INTENT = /(عايز|عاوز|محتاج|ابحث|دور|وريني|اعرض|فيه|رشحلي|ورني|show me|looking for|i want|i need|find me|search|do you have|what .* do you have|any )/;

const INJECTION = /(ignore (?:all |any )?(?:the )?(?:previous|prior|above) (?:instructions|prompts?)|system prompt|reveal your (?:prompt|instructions)|jailbreak|تجاهل (?:كل )?(?:ال)?تعليمات|اظهر (?:ال)?برومبت)/;
const OFF_TOPIC = [
  /(python|javascript|typescript|java|c\+\+|html|css|react|node\.?js|array|algorithm)/,
  /(كود|برمج|بايثون|جافاسكربت|سوفت وير|اله حاسبه)/,
  /(طقس|الجو|weather|temperature|درجه الحراره)/,
  /(كاس العالم|كره القدم|ماتش|مباراه|football|soccer|world cup|premier league)/,
  /(قصيده|شعر|اغنيه|poem|poetry|lyrics|write (?:me )?a (?:story|song))/,
  /(capital of|عاصمه |ترجم|translate|recipe|وصفه|مطعم|مطاعم|كافيه|restaurants?|cafes?|pizza|بيتزا|برجر|burger)/,
];

const META = {
  identity: /(مين انت|انت مين|مين انتي|انتي مين|who are you|what are you|your name|اسمك ايه|ما اسمك)/,
  how_to_find: /(بتدور|بتبحث|بتلاقي|بتشتغل ازاي|ازاي بتشتغل|how do you (?:search|find|work)|how does (?:it|this) work)/,
  valuation: /(تقييم عقاري|قيم(?:لي)? عقاري|اقدر اعرف سعر|valuation|how much is my|worth my)/,
  capabilities: /(تقدر|تقدري|بتعمل ايه|بتعملي ايه|تساعد|what can you|can you help|how can you help)/,
} as const;

const FOLLOW_UP_CHEAPER = /(ارخص|رخيص|cheaper|less expensive|lower price|more affordable)/;
const FOLLOW_UP_MORE = /(غيرها|حاجه تانيه|حاجات تانيه|اختيارات تانيه|خيارات تانيه|more options|something else|other options|another one|show more)/;

export function heuristicRoute(message: string, prior?: ListingFilters): HeuristicRoute {
  const n = normalizeText(message);
  const { filters, issues } = extractFilters(message);
  const hasPrior = Boolean(prior && Object.keys(prior).length > 0);

  const hasType = Boolean(filters.property_type);
  const hasPlace = Boolean(filters.city || filters.neighbourhood);
  const hasNumbers = Boolean(filters.maxBudget || filters.minBudget || filters.rooms || filters.minArea);
  const hasRealEstateWord = REAL_ESTATE_WORDS.test(n);
  const concreteSignal = hasType || hasPlace || hasNumbers;
  const intent = INTENT.test(n);

  // 1. Prompt-injection probes never need a model.
  if (INJECTION.test(n)) return { type: "out_of_scope", filters: {}, issues: [], reason: "injection" };

  // 2. Meta questions about the assistant (before property detection:
  //    "بتدوري على العقارات ازاي؟" mentions عقارات but is not a search).
  if (!concreteSignal) {
    for (const topic of ["identity", "how_to_find", "valuation", "capabilities"] as const) {
      if (META[topic].test(n)) return { type: "general", topic, filters: {}, issues: [], reason: `meta:${topic}` };
    }
  }

  // 3. Off-topic — but ONLY when there is no concrete property signal.
  //    The original guard fired on "شقة قريبة من مطاعم" / "near cafes".
  if (!hasType && !hasRealEstateWord && OFF_TOPIC.some((re) => re.test(n))) {
    return { type: "out_of_scope", filters: {}, issues: [], reason: "off_topic" };
  }

  // 4. Property search.
  const isRequest =
    hasType ||
    hasRealEstateWord ||
    (hasPlace && (intent || hasNumbers)) ||
    (hasNumbers && Boolean(filters.rooms) && Boolean(filters.maxBudget || filters.minBudget));
  if (isRequest) return { type: "in_scope", filters, issues, reason: "property_request" };

  // 5. Follow-ups that only make sense given prior context.
  if (hasPrior) {
    if (FOLLOW_UP_CHEAPER.test(n)) return { type: "in_scope", filters, issues, followUp: "cheaper", reason: "follow_up_cheaper" };
    if (FOLLOW_UP_MORE.test(n)) return { type: "in_scope", filters, issues, followUp: "more", reason: "follow_up_more" };
    if (concreteSignal) return { type: "in_scope", filters, issues, reason: "refinement" };
  }

  return { type: null, filters, issues, reason: "ambiguous" };
}

/* ------------------------------------------------------------------ */
/* Canned, bilingual replies                                           */
/* ------------------------------------------------------------------ */

export const REPLIES = {
  out_of_scope: {
    ar: "أنا متخصص في العقارات في مصر بس: بحث عن شقق وفيلات وشاليهات وأسعار السوق. قولّي بتدور على إيه (المنطقة، الميزانية، عدد الغرف) وأنا أساعدك.",
    en: "I specialise in Egyptian real estate only: property search and market prices. Tell me the area, budget and number of rooms you have in mind and I'll help.",
  },
  general: {
    identity: {
      ar: "أنا مساعد Estatio للعقارات. بساعدك تدور على شقق وفيلات وشاليهات ودوبلكس في مصر حسب المنطقة والميزانية وعدد الغرف.",
      en: "I'm Estatio's property assistant. I help you search apartments, villas, chalets and duplexes across Egypt by area, budget and rooms.",
    },
    capabilities: {
      ar: "أقدر أدورلك على عقارات في القاهرة الجديدة والشيخ زايد وأكتوبر والساحل الشمالي وغيرها، وأرتبها حسب الميزانية وعدد الغرف ونوع العقار.",
      en: "I can search listings in New Cairo, Sheikh Zayed, 6th of October, the North Coast and more, filtered by budget, rooms and property type.",
    },
    how_to_find: {
      ar: "اكتب طلبك عادي، مثلاً: «عايز شقة 3 غرف في التجمع بحد أقصى 5 مليون» وأنا أدور في قاعدة البيانات وأرشحلك أنسب النتائج.",
      en: "Just describe what you want, e.g. “3-bedroom apartment in New Cairo under 5 million EGP”, and I'll search the database and shortlist the best matches.",
    },
    valuation: {
      ar: "تقدر تعرف سعر عقارك التقديري من صفحة التقييم عندنا، وهي بتعتمد على نموذج تسعير متدرّب على السوق المصري.",
      en: "You can estimate your property's fair value on our Valuation page, powered by a model trained on the Egyptian market.",
    },
    other: {
      ar: "أنا مستشارك العقاري في Estatio. قولّي المنطقة والميزانية ونوع العقار وأنا أساعدك.",
      en: "I'm your Estatio property advisor. Tell me the area, budget and property type and I'll help.",
    },
  },
  clarify: {
    zero_budget: {
      ar: "الميزانية صفر مش هتطلّع نتائج. قولّي ميزانيتك التقريبية بالجنيه (مثلاً 3 مليون) وأنا أدورلك.",
      en: "A budget of zero won't match any listing. Tell me your approximate budget in EGP (e.g. 3 million) and I'll search.",
    },
    negative_number: {
      ar: "فيه رقم سالب في طلبك (غرف أو ميزانية). ممكن توضّح العدد المطلوب؟",
      en: "There's a negative number in your request (rooms or budget). Could you confirm the value you want?",
    },
    rooms_out_of_range: {
      ar: "عدد الغرف ده كبير جداً. تقصد كام غرفة تقريباً؟",
      en: "That number of rooms looks too high. How many rooms do you actually need?",
    },
  },
  unavailable: {
    ar: "المساعد مشغول حالياً. جرّب نفس الطلب بعد لحظات.",
    en: "The assistant is busy right now. Please try again in a moment.",
  },
  noResults: {
    ar: "ملقتش عقارات متاحة مطابقة للطلب ده حالياً. جرّب توسّع الميزانية أو ابحث في منطقة قريبة.",
    en: "I couldn't find active listings matching your criteria right now. Try widening your budget or a nearby area.",
  },
} as const;

export function pick(r: { ar: string; en: string }, message: string): string {
  return isArabicText(message) ? r.ar : r.en;
}
