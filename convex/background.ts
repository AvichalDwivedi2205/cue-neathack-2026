import { v, ConvexError } from "convex/values";
import { mutation } from "./_generated/server";
import { authorize } from "./cue";
export const acquire = mutation({
  args: { secret: v.string(), token: v.string() },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (a.token.length < 10 || a.token.length > 100)
      throw new ConvexError("Invalid lease token");
    const old = await ctx.db
      .query("backgroundLeases")
      .withIndex("by_name", (q) => q.eq("name", "x"))
      .unique();
    if (old && old.until > Date.now()) return false;
    const value = {
      name: "x" as const,
      token: a.token,
      until: Date.now() + 60000,
    };
    if (old) await ctx.db.replace("backgroundLeases", old._id, value);
    else await ctx.db.insert("backgroundLeases", value);
    return true;
  },
});
export const release = mutation({
  args: { secret: v.string(), token: v.string() },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const old = await ctx.db
      .query("backgroundLeases")
      .withIndex("by_name", (q) => q.eq("name", "x"))
      .unique();
    if (old?.token === a.token)
      await ctx.db.patch("backgroundLeases", old._id, { until: 0 });
    return null;
  },
});
