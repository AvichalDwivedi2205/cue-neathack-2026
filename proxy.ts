import { authkitProxy } from "@workos-inc/authkit-nextjs";
import { NextRequest, NextResponse, NextFetchEvent } from "next/server";
import { workosRedirectUri } from "@/lib/auth-config";
export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (
    !process.env.WORKOS_API_KEY ||
    !process.env.WORKOS_CLIENT_ID ||
    !process.env.WORKOS_COOKIE_PASSWORD
  )
    return NextResponse.next();
  return authkitProxy({ redirectUri: workosRedirectUri() })(request, event);
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
