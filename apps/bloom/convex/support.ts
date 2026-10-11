import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { authorize } from "./access";
export const get = query({
  args: { secret: v.string(), owner: v.string(), now: v.number() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const link = await ctx.db
      .query("supportLinks")
      .withIndex("by_owner", (q) => q.eq("owner", a.owner))
      .unique();
    return link && link.expiresAt > a.now ? link.token : null;
  },
});
export const attach = mutation({
  args: { secret: v.string(), owner: v.string(), token: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const link = await ctx.db
      .query("supportLinks")
      .withIndex("by_owner", (q) => q.eq("owner", a.owner))
      .unique();
    if (link && link.expiresAt > Date.now()) return link.token;
    const fields = { token: a.token, expiresAt: Date.now() + 29 * 86400000 };
    if (link) await ctx.db.patch("supportLinks", link._id, fields);
    else await ctx.db.insert("supportLinks", { ...fields, owner: a.owner });
    return a.token;
  },
});
