import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

export type VerifiedUser = { id: string; email: string };

/**
 * Validates the Supabase access token sent by the frontend and returns the user
 * only if their email is confirmed. The email comes from the verified token,
 * never from the request body.
 *
 * Tokens must be checked against the Supabase project the FRONTEND signs users into.
 * Here that is the properties project (SUPABASE_URL). Override with AUTH_SUPABASE_URL /
 * AUTH_SUPABASE_SERVICE_ROLE_KEY if the frontend ever moves to another project.
 */
export async function getVerifiedUser(request: NextRequest): Promise<VerifiedUser | null> {
  const url = (process.env.AUTH_SUPABASE_URL || process.env.SUPABASE_URL)?.trim();
  const key = (process.env.AUTH_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!url || !key || !token) return null;
  try {
    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await supabase.auth.getUser(token);
    const user = data.user;
    if (error || !user?.email || !user.email_confirmed_at) return null;
    return { id: user.id, email: user.email };
  } catch {
    return null;
  }
}
