"use node";
import { randomUUID, createHmac } from "node:crypto";
import { internalAction, env } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
export const deliver = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (
      !env.BLOOM_GROWTH_EVENT_SECRET ||
      !env.CUE_PUBLIC_URL ||
      !env.CUE_WIDGET_APP_ID
    )
      return null;
    const origin = new URL(env.CUE_PUBLIC_URL);
    if (origin.protocol !== "https:" || origin.origin !== env.CUE_PUBLIC_URL)
      throw new Error("Trusted event origin required");
    const lease = randomUUID(),
      rows = await ctx.runMutation(internal.growth.claim, { lease });
    for (const r of rows) {
      let ok = false;
      try {
        const body = JSON.stringify({
          action: "event",
          appId: env.CUE_WIDGET_APP_ID,
          touchId: r.touchId,
          browser: r.browser,
          eventId: "bloom:" + r._id,
          type: r.type,
          occurredAt: r.occurredAt,
          internal: r.internal,
          returning: r.returning,
        });
        const stamp = String(Date.now()),
          signature = createHmac("sha256", env.BLOOM_GROWTH_EVENT_SECRET)
            .update(stamp + "." + body)
            .digest("hex");
        const result = await fetch(origin.origin + "/api/growth/events", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-cue-timestamp": stamp,
            "x-cue-signature": signature,
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        ok = result.ok && (await result.json()).ok === true;
      } catch {}
      await ctx.runMutation(internal.growth.finish, { id: r._id, lease, ok });
    }
    return null;
  },
});
