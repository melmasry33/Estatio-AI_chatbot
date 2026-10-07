import { NextRequest, NextResponse } from "next/server";
import { handleChatRequest } from "../../../.source/estatio_chatbot/src/lib/assistant.server";
import { getVerifiedUser } from "@/lib/auth";
import { LIMITS, QuotaUnavailableError, consume, ipBucket, isDisposableEmail, normalizeEmail, refund, remaining, type Rule } from "@/lib/quota";

export const runtime = "nodejs";

/**
 * CORS: needed only when the frontend is hosted on a different origin than this API.
 * List the allowed origins in ALLOWED_ORIGINS (comma-separated), e.g.
 *   ALLOWED_ORIGINS=https://estatio.com,https://www.estatio.com,http://localhost:5173
 * Same-origin requests need nothing. Unlisted origins get no CORS headers (the browser blocks them).
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);

function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = { Vary: "Origin" };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const response = await handle(request);
  for (const [key, value] of Object.entries(corsHeaders(request))) response.headers.set(key, value);
  return response;
}

async function handle(request: NextRequest): Promise<NextResponse> {
  // A malformed / empty body is a client error, not a 500.
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    // On Cloudflare, `cf-connecting-ip` is set by Cloudflare itself and cannot be spoofed by the client.
    // x-forwarded-for is only a fallback for local dev.
    const ip = ipBucket(
      request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip"),
    );

    const user = await getVerifiedUser(request);
    if (user && isDisposableEmail(user.email)) {
      return NextResponse.json({ error: "الإيميل ده مؤقت ومش مقبول. سجّل بإيميل حقيقي.", code: "disposable_email" }, { status: 403 });
    }

    const emailId = user ? `u:${normalizeEmail(user.email)}` : null;
    const rules: Rule[] = user
      ? [{ id: emailId!, limit: LIMITS.userPerEmail }, { id: `ip:${ip}`, limit: LIMITS.userPerIp }]
      : [{ id: `ip:${ip}`, limit: LIMITS.anonPerIp }];
    rules.push({ id: "global", limit: LIMITS.globalPerDay });

    let taken;
    try {
      taken = await consume(rules);
    } catch (err) {
      // Fail CLOSED: without a working counter, anyone could burn the LLM keys.
      console.error("[quota] unavailable:", err instanceof QuotaUnavailableError ? err.message : err);
      return NextResponse.json({ error: "الخدمة مش متاحة دلوقتي. جرّب بعد شوية." }, { status: 503, headers: { "Retry-After": "30" } });
    }

    if (!taken.ok) {
      const global = taken.blockedBy === "global";
      const error = global
        ? "الخدمة التجريبية وصلت للحد الأقصى النهارده. ارجع بكرة 🙏"
        : user
          ? "خلصت رسايلك التجريبية النهارده. ارجع بكرة 🙏"
          : "خلصت رسايل التجربة المجانية. سجّل دخولك بإيميلك عشان تكمل.";
      return NextResponse.json(
        { error, code: global ? "global_limit" : user ? "daily_limit" : "login_required", quota: { remaining: 0, limit: user ? LIMITS.userPerEmail : LIMITS.anonPerIp, signedIn: !!user } },
        { status: 429, headers: { "Retry-After": "3600" } },
      );
    }

    // Per-minute burst limiter inside the handler is keyed by user, or by IP for visitors.
    const result = await handleChatRequest(payload, user?.id ?? ip);

    // A failed/limited turn must not cost the person one of their daily messages.
    if (result.status !== 200) await refund(taken.keys);

    const limit = user ? LIMITS.userPerEmail : LIMITS.anonPerIp;
    const left = await remaining(emailId ?? `ip:${ip}`, limit).catch(() => undefined);
    return NextResponse.json(
      { ...result.body, quota: { remaining: left, limit, signedIn: !!user } },
      { status: result.status, headers: result.status === 503 ? { "Retry-After": "5" } : result.status === 429 ? { "Retry-After": "15" } : undefined },
    );
  } catch (error) {
    console.error("[chat] unhandled error:", error);
    return NextResponse.json({ error: "تعذر الاتصال بالمساعد حالياً. حاول مرة أخرى." }, { status: 500 });
  }
}
