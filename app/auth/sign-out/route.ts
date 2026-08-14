import { NextResponse, type NextRequest } from "next/server";

import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Sign-out is a POST so it cannot be triggered by a link, an image, or a prefetch.
 * It is best-effort by design: the cookies are cleared either way, and access was never granted by
 * the session alone.
 */
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();

  const url = request.nextUrl.clone();
  url.pathname = "/sign-in";
  url.search = "";
  return NextResponse.redirect(url, { status: 303 });
}
