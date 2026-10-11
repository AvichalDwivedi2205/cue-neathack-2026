import { api, db, secret } from "@/lib/server-store";
import { hash, validGrowthToken } from "@/lib/growth-links";
import { workspaceApp } from "@/lib/workspace";
export const runtime = "nodejs";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;
    if (!validGrowthToken(token)) throw new Error("Invalid link");
    const touch = await db().query(api.growthAttribution.lookup, {
      secret: secret(),
      tokenHash: hash(token),
      now: Date.now(),
    });
    if (!touch) throw new Error("Link unavailable");
    const { app } = await workspaceApp(touch.appId);
    if (!app.origins.includes(touch.destination))
      throw new Error("Destination no longer registered");
    const destination = new URL(touch.destination);
    destination.searchParams.set("cue_campaign", token);
    await db().mutation(api.growthAttribution.click, {
      secret: secret(),
      touchId: touch._id,
    });
    return Response.redirect(destination, 302);
  } catch {
    return new Response("Campaign link unavailable or expired.", {
      status: 410,
      headers: { "cache-control": "no-store" },
    });
  }
}
