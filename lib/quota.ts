import { Redis } from "@upstash/redis";

/** Daily trial limits. Override with env vars if needed. */
export const LIMITS = {
  anonPerIp: Number(process.env.QUOTA_ANON_PER_IP ?? 5),        // visitors without an account: 5/day per IP
  userPerEmail: Number(process.env.QUOTA_USER_PER_EMAIL ?? 5),  // verified email: 5/day
  userPerIp: Number(process.env.QUOTA_USER_PER_IP ?? 20),       // cap across many fake emails from one IP
  globalPerDay: Number(process.env.QUOTA_GLOBAL_PER_DAY ?? 300), // hard stop for the whole project (protects LLM keys)
};

const TTL_SECONDS = 60 * 60 * 30;

/** The day rolls over at midnight Cairo time. */
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());

const DISPOSABLE = new Set([
  "mailinator.com", "10minutemail.com", "guerrillamail.com", "tempmail.com", "temp-mail.org",
  "yopmail.com", "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com", "maildrop.cc",
]);

export function isDisposableEmail(email: string) {
  return DISPOSABLE.has(email.split("@")[1]?.toLowerCase() ?? "");
}

/** a.b+x@gmail.com and ab@gmail.com are the same mailbox. */
export function normalizeEmail(email: string) {
  let [user, domain] = email.toLowerCase().trim().split("@");
  user = user.split("+")[0];
  if (domain === "gmail.com" || domain === "googlemail.com") {
    user = user.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${user}@${domain}`;
}

/** IPv6 users own a whole /64, so bucket by its first 4 groups. */
export function ipBucket(ip: string | null | undefined) {
  if (!ip) return "unknown";
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip;
}

/* ------------------------------- storage -------------------------------- */

let redis: Redis | null = null;
function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

// Dev-only fallback. It does NOT work across serverless instances, so production fails closed.
const memory = new Map<string, number>();

export class QuotaUnavailableError extends Error {}

async function incr(key: string): Promise<number> {
  const r = getRedis();
  if (r) {
    const [used] = await r.multi().incr(key).expire(key, TTL_SECONDS).exec<[number, number]>();
    return used;
  }
  if (process.env.NODE_ENV === "production") throw new QuotaUnavailableError("Upstash is not configured");
  const used = (memory.get(key) ?? 0) + 1;
  memory.set(key, used);
  return used;
}

async function decr(key: string) {
  const r = getRedis();
  if (r) await r.decr(key);
  else memory.set(key, Math.max(0, (memory.get(key) ?? 1) - 1));
}

/* -------------------------------- public -------------------------------- */

export type Rule = { id: string; limit: number };

/**
 * Consume one unit from every rule atomically-enough: if any rule is exhausted,
 * everything taken so far is returned and `ok` is false.
 */
export async function consume(rules: Rule[]): Promise<{ ok: boolean; keys: string[]; blockedBy?: string }> {
  const day = today();
  const keys: string[] = [];
  for (const rule of rules) {
    const key = `estatio:q:${day}:${rule.id}`;
    const used = await incr(key);
    if (used > rule.limit) {
      await decr(key);
      await refund(keys);
      return { ok: false, keys: [], blockedBy: rule.id };
    }
    keys.push(key);
  }
  return { ok: true, keys };
}

export async function refund(keys: string[]) {
  await Promise.allSettled(keys.map(decr));
}

/** Remaining messages for this identity (for the UI counter). */
export async function remaining(id: string, limit: number): Promise<number> {
  const key = `estatio:q:${today()}:${id}`;
  const r = getRedis();
  const used = r ? Number((await r.get<number>(key)) ?? 0) : memory.get(key) ?? 0;
  return Math.max(0, limit - used);
}
