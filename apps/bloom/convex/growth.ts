import { v, ConvexError } from "convex/values";
import { mutation, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { authorize } from "./access";
import schema from "./schema";
export async function emit(
  ctx: MutationCtx,
  a: Doc<"growthAttributions">,
  type: Doc<"growthOutbox">["type"],
) {
  if (a.expiresAt < Date.now()) return;
  await ctx.db.insert("growthOutbox", {
    touchId: a.touchId,
    browser: a.browser,
    type,
    occurredAt: Date.now(),
    internal: a.internal,
    returning: a.returning,
    state: "pending",
    attempts: 0,
    retryAt: Date.now(),
  });
}
export const attach = mutation({
  args: {
    secret: v.string(),
    owner: v.string(),
    touchId: v.string(),
    expiresAt: v.number(),
    browser: v.string(),
    internal: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (
      !/^[a-f0-9]{64}$/.test(a.browser) ||
      a.expiresAt < Date.now() ||
      a.expiresAt > Date.now() + 8 * 86400000
    )
      throw new ConvexError("Attribution rejected");
    const old = await ctx.db
      .query("growthAttributions")
      .withIndex("by_owner", (q) => q.eq("owner", a.owner))
      .unique();
    if (old) return null;
    const prior = await ctx.db
      .query("memories")
      .withIndex("by_owner_and_deleted", (q) => q.eq("owner", a.owner))
      .first();
    const { secret: _secret, ...fields } = a;
    void _secret;
    const id = await ctx.db.insert("growthAttributions", {
      ...fields,
      returning: !!prior,
    });
    await emit(
      ctx,
      (await ctx.db.get("growthAttributions", id))!,
      "session_confirmed",
    );
    return null;
  },
});
export const search = mutation({
  args: { secret: v.string(), owner: v.string(), query: v.string() },
  returns: v.array(v.id("memories")),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (a.query.length > 280) throw new ConvexError("Search too long");
    const terms = a.query
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const memories = await ctx.db
      .query("memories")
      .withIndex("by_owner_and_deleted", (q) =>
        q.eq("owner", a.owner).eq("deleted", false),
      )
      .order("desc")
      .take(200);
    const ids = memories
      .filter((m) =>
        terms.every((term) => m.caption.toLocaleLowerCase().includes(term)),
      )
      .map((m) => m._id);
    const attribution = await ctx.db
      .query("growthAttributions")
      .withIndex("by_owner", (q) => q.eq("owner", a.owner))
      .unique();
    if (
      terms.length &&
      attribution?.firstMemoryId &&
      attribution.savedAt &&
      !attribution.searchedAt &&
      ids.includes(attribution.firstMemoryId)
    ) {
      await ctx.db.patch("growthAttributions", attribution._id, {
        searchedAt: Date.now(),
      });
      await emit(ctx, attribution, "caption_search_match");
    }
    return ids;
  },
});
export const claim = internalMutation({
  args: { lease: v.string() },
  returns: v.array(schema.doc("growthOutbox")),
  handler: async (ctx, a) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("growthOutbox")
      .withIndex("by_state_and_retryAt", (q) =>
        q.eq("state", "pending").lte("retryAt", now),
      )
      .take(20);
    const eligible = rows.filter((r) => (r.leaseUntil || 0) < now);
    for (const r of eligible)
      await ctx.db.patch("growthOutbox", r._id, {
        lease: a.lease,
        leaseUntil: now + 60000,
        attempts: r.attempts + 1,
      });
    return eligible;
  },
});
export const finish = internalMutation({
  args: { id: v.id("growthOutbox"), lease: v.string(), ok: v.boolean() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const r = await ctx.db.get("growthOutbox", a.id);
    if (!r || r.lease !== a.lease) return null;
    await ctx.db.patch("growthOutbox", r._id, {
      state: a.ok ? "delivered" : r.attempts >= 8 ? "failed" : "pending",
      retryAt: Date.now() + Math.min(3600000, 1000 * 2 ** r.attempts),
      lease: undefined,
      leaseUntil: undefined,
    });
    return null;
  },
});
