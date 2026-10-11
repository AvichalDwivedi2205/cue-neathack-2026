import { handleAuth } from "@workos-inc/authkit-nextjs";
import { NextRequest } from "next/server";
import { workosRedirectUri } from "@/lib/auth-config";
const callbackOrigin = workosRedirectUri()
  ? new URL(workosRedirectUri()!).origin
  : undefined;
const callback = handleAuth({
  returnPathname: "/cue",
  baseURL: callbackOrigin,
});
export async function GET(request: NextRequest) {
  const response = await callback(request);
  const location = response.headers.get("location");
  if (location) {
    const target = new URL(location, request.url);
    // Finish the callback document before opening the hash-based workspace.
    // This also avoids carrying the cross-site OAuth redirect chain into Cue.
    if (
      target.origin === (callbackOrigin || new URL(request.url).origin) &&
      target.pathname === "/cue"
    ) {
      const headers = new Headers(response.headers);
      headers.delete("location");
      headers.set("content-type", "text/html; charset=utf-8");
      headers.set("x-content-type-options", "nosniff");
      headers.set(
        "content-security-policy",
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/cue#/inbox"><title>Signed in to Cue</title></head><body><p>Signed in. <a href="/cue#/inbox">Continue to Cue</a></p></body></html>',
        { status: 200, headers },
      );
    }
  }
  return response;
}
