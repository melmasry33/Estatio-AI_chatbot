import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

process.env.GROQ_API_KEY = "x"; process.env.OPENROUTER_API_KEY = "x"; process.env.NVIDIA_API_KEY = "x";
const load = () => import("../.source/estatio_chatbot/src/lib/assistant.providers");

const calls: string[] = [];
const completion = (content: string) =>
  new Response(JSON.stringify({ id: "1", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("groq.com")) { calls.push("groq"); return new Response(JSON.stringify({ error: { message: "Rate limit reached ... Please try again in 2s.", type: "tokens", code: "rate_limit_exceeded" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "2" } }); }
  if (url.includes("openrouter.ai")) { calls.push("openrouter"); return new Response(JSON.stringify({ error: { message: "This model is unavailable for free.", code: 404 } }), { status: 404, headers: { "content-type": "application/json" } }); }
  if (url.includes("nvidia.com")) { calls.push("nvidia"); return completion('```json\n{"text":"مرحبا","propertyIds":[1]}\n```'); }
  throw new Error("unexpected " + url);
}) as typeof fetch;

const schema = z.object({ text: z.string(), propertyIds: z.array(z.number()).optional() });
const run = async () => (await load()).runStructured({ stage: "synthesis", schema, prompt: "hi", jsonShapeHint: "{}", maxOutputTokens: 100, deadlineMs: 10_000 });

test("fails over groq(429) -> openrouter(404) -> nvidia, then SKIPS the dead providers", async () => {
  const t0 = Date.now();
  const first = await run();
  assert.equal(first?.provider, "nvidia");
  assert.deepEqual(calls, ["groq", "openrouter", "nvidia"]); // maxRetries:0 => one attempt each
  assert.ok(Date.now() - t0 < 2000, "no SDK back-off sleeping");
  const { providerIsOpen } = await load();
  assert.ok(providerIsOpen("groq") && providerIsOpen("openrouter") && !providerIsOpen("nvidia"));

  calls.length = 0;
  const second = await run();
  assert.equal(second?.provider, "nvidia");
  assert.deepEqual(calls, ["nvidia"]); // previously: 2 wasted round-trips per request
});

test("returns null (caller degrades to template) when everything is down", async () => {
  process.env.NVIDIA_API_KEY = "";
  assert.equal(await run(), null);
});
