import { getSignInUrl, withAuth } from "@workos-inc/authkit-nextjs";
import { NextResponse } from "next/server";
import { workosRedirectUri } from "@/lib/auth-config";
export async function GET(request: Request) {
  const { user } = await withAuth();
  if (user) return NextResponse.redirect(new URL("/cue#/inbox", request.url));
  return NextResponse.redirect(
    await getSignInUrl({ returnTo: "/cue", redirectUri: workosRedirectUri() }),
  );
}
