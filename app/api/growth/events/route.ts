import { z } from "zod";
import { api, db, secret } from "@/lib/server-store";
import {
  hash,
  validEventSignature,
  validGrowthToken,
} from "@/lib/growth-links";
import { workspaceApp } from "@/lib/workspace";
import type { Id } from "@/convex/_generated/dataModel";
export const runtime = "nodejs";
const signed = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("exchange"),
      appId: z.string().max(100),
      token: z.string().max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal("event"),
      appId: z.string().max(100),
      touchId: z.string().max(100),
      browser: z.string().regex(/^[a-f0-9]{64}$/),
      eventId: z.string().min(1).max(200),
      type: z.enum([
        "session_confirmed",
        "memory_created",
        "caption_search_match",
      ]),
      occurredAt: z.number().finite(),
      internal: z.boolean(),
      returning: z.boolean(),
    })
    .strict(),
]);
export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length") || 0) > 4000)
      throw new Error("Too large");
    const raw = await request.text();
    if (raw.length > 4000) throw new Error("Too large");
    const body = signed.parse(JSON.parse(raw));
    if (
      !validEventSignature(
        body.appId,
        raw,
        request.headers.get("x-cue-timestamp") || "",
        request.headers.get("x-cue-signature") || "",
      )
    )
      throw new Error("Invalid signature");
    const { app } = await workspaceApp(body.appId);
    if (body.action === "exchange") {
      if (!validGrowthToken(body.token)) throw new Error("Modified token");
      const t = await db().query(api.growthAttribution.lookup, {
        secret: secret(),
        tokenHash: hash(body.token),
        now: Date.now(),
      });
      if (!t || t.appId !== app.id || !app.origins.includes(t.destination))
        throw new Error("Wrong app or expired touch");
      const o = (
        await db().query(api.growth.snapshot, {
          secret: secret(),
          appId: app.id,
        })
      ).opportunities.find((o) => o._id === t.opportunityId);
      return Response.json(
        { touchId: t._id, expiresAt: t.expiresAt, internal: !!o?.controlled },
        { headers: { "cache-control": "no-store" } },
      );
    }
    const { action: _action, ...event } = body;
    void _action;
    const inserted = await db().mutation(api.growthAttribution.ingest, {
      secret: secret(),
      ...event,
      touchId: event.touchId as Id<"growthTouches">,
    });
    return Response.json({ ok: true, duplicate: !inserted });
  } catch {
    return Response.json(
      { error: "Signed app event rejected" },
      { status: 403 },
    );
  }
}
