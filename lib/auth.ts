import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

export type VerifiedUser = { id: string; email: string };

/**
 * Validates the Supabase access token sent by the browser and returns the user
 * only if their email is confirmed. The email is taken from the verified token,
 * never from the request body.
 */
export async function getVerifiedUser(request: NextRequest): Promise<VerifiedUser | null> {
  const url = process.env.ACCOUNTS_SUPABASE_URL;
  const key = process.env.ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY;
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
