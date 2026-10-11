import { ConvexError, v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { authorize } from "./cue";
import schema from "./schema";

const key = v.union(
  v.literal("integrations"),
  v.literal("worker"),
  v.literal("background"),
  v.literal("x-checkpoint"),
);
export const read = query({
  args: { secret: v.string(), key },
  returns: v.union(v.null(), schema.doc("serverState")),
  handler: async (ctx, a) => {
    authorize(a.secret);
    return await ctx.db
      .query("serverState")
      .withIndex("by_key", (q) => q.eq("key", a.key))
      .unique();
  },
});
export const write = mutation({
  args: {
    secret: v.string(),
    key,
    value: v.string(),
    expectedVersion: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (
      a.value.length > 128000 ||
      !Number.isSafeInteger(a.expectedVersion) ||
      a.expectedVersion < 0
    )
      throw new ConvexError("Invalid server state");
    const old = await ctx.db
      .query("serverState")
      .withIndex("by_key", (q) => q.eq("key", a.key))
      .unique();
    if ((old?.version ?? 0) !== a.expectedVersion) return false;
    const fields = {
      value: a.value,
      version: a.expectedVersion + 1,
      updatedAt: Date.now(),
    };
    if (old) await ctx.db.patch("serverState", old._id, fields);
    else await ctx.db.insert("serverState", { key: a.key, ...fields });
    return true;
  },
});
