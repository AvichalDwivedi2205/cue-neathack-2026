import { mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { authorize } from "./cue";
export const reserve = mutation({
  args: {
    secret: v.string(),
    key: v.string(),
    channel: v.string(),
    destination: v.string(),
    body: v.string(),
    actor: v.string(),
  },
  returns: v.id("deliveries"),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const previous = await ctx.db
      .query("deliveries")
      .withIndex("by_key", (q) => q.eq("key", a.key))
      .unique();
    if (previous)
      throw new ConvexError(
        `Delivery already ${previous.status}. Review its receipt before retrying.`,
      );
    return await ctx.db.insert("deliveries", {
      key: a.key,
      channel: a.channel,
      destination: a.destination,
      body: a.body,
      actor: a.actor,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});
export const finish = mutation({
  args: {
    secret: v.string(),
    id: v.id("deliveries"),
    status: v.union(v.literal("sent"), v.literal("unknown")),
    receipt: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    await ctx.db.patch("deliveries", a.id, {
      status: a.status,
      receipt: a.receipt,
    });
    return null;
  },
});
