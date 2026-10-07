import { z } from "zod";

/**
 * Filter criteria extracted from the user's inquiry.
 * Validates reasonable bounds before querying the database.
 */
export const ListingFiltersSchema = z.object({
  city: z.string().trim().max(100).optional(),
  neighbourhood: z.string().trim().max(100).optional(),
  budget: z
    .number()
    .positive("Budget must be a positive number")
    .max(500_000_000, "Budget exceeds maximum threshold")
    .optional(),
  minBudget: z.number().positive().max(500_000_000).optional(),
  maxBudget: z.number().positive().max(500_000_000).optional(),
  minArea: z.number().positive().max(100_000).optional(),
  finishingStatus: z.array(z.string().trim().max(40)).max(5).optional(),
  /** Set by follow-ups such as "فيه حاجة أرخص؟". */
  sortBy: z.enum(["price_asc"]).optional(),
  property_type: z.string().trim().max(60).optional(),
  rooms: z
    .number()
    .int("Rooms must be an integer")
    .min(0)
    .max(20)
    .optional(),
});

export type ListingFilters = z.infer<typeof ListingFiltersSchema>;

/**
 * 1-pass Router classification output schema.
 */
export const RouterOutputSchema = z.object({
  type: z.enum(["out_of_scope", "general", "in_scope"]),
  topic: z
    .enum(["identity", "capabilities", "how_to_find", "valuation", "other"])
    .optional()
    .describe("Sub-topic when type is general"),
  filters: ListingFiltersSchema.optional().default({}),
});

export type RouterOutput = z.infer<typeof RouterOutputSchema>;

/**
 * Single turn in chat history.
 */
export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * Incoming POST payload for the assistant endpoint.
 */
export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1, "Message cannot be empty").max(2000),
  sessionId: z.string().trim().max(128).optional(),
  history: z.array(ChatMessageSchema).max(20).optional().default([]),
  /**
   * Filters returned by the previous turn. Echoing them back makes follow-ups
   * ("something cheaper") work without depending on the optional accounts DB —
   * getSessionFilters() existed but was never called.
   */
  priorFilters: ListingFiltersSchema.optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/**
 * Candidate property returned by the database layer.
 */
export interface CandidateProperty {
  property_id: number;
  city: string | null;
  neighbourhood: string | null;
  property_type: string | null;
  rooms: number | null;
  baths: number | null;
  area_m2: number | null;
  price_egp: number | null;
  price_per_m2: number | null;
  representative_title: string | null;
  url?: string | null;
  description?: string;
  similarity?: number;
}

/**
 * Synthesis structured result.
 */
export const SynthesisOutputSchema = z.object({
  text: z.string().min(1),
  // No .default([]) on purpose: an explicit empty array from the model means
  // "deliberately no good match" and must stay distinguishable from the
  // field being genuinely absent (the model forgot to include it) — see
  // assistant.server.ts's handling of this field.
  propertyIds: z.array(z.number().int()).optional(),
});

export type SynthesisOutput = z.infer<typeof SynthesisOutputSchema>;

/**
 * Final client response payload.
 */
export interface ChatResponse {
  text: string;
  propertyIds: number[];
  properties?: CandidateProperty[];
  type: RouterOutput["type"];
  filters?: ListingFilters;
  sessionId?: string;
  /** Observability for tests/UI: lets a harness tell "LLM answered" from "degraded template". */
  meta?: {
    source?: "heuristic" | "llm" | "none";
    synthesis?: "llm" | "template" | "none";
    provider?: string;
    relaxed?: string[];
    reason?: string;
  };
}
