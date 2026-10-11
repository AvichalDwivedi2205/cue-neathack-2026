import { v, ConvexError } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { authorize } from "./access";
export const issue = mutation({
  args: { secret: v.string(), owner: v.string(), tokenHash: v.string() },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (!/^[a-f0-9]{64}$/.test(a.tokenHash))
      throw new ConvexError("Invalid upload ticket");
    await ctx.db.insert("uploadTickets", {
      owner: a.owner,
      tokenHash: a.tokenHash,
      expiresAt: Date.now() + 600000,
      claimed: false,
    });
    return null;
  },
});
export const claim = internalMutation({
  args: { tokenHash: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const ticket = await ctx.db
      .query("uploadTickets")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", a.tokenHash))
      .unique();
    if (!ticket || ticket.claimed || ticket.expiresAt <= Date.now())
      throw new ConvexError("Upload ticket expired or already used");
    await ctx.db.patch("uploadTickets", ticket._id, { claimed: true });
    return ticket.owner;
  },
});
export const record = internalMutation({
  args: { owner: v.string(), fileId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, a) => {
    await ctx.db.insert("photoUploads", {
      ...a,
      verified: false,
      used: false,
      expiresAt: Date.now() + 86400000,
    });
    return null;
  },
});
export const get = query({
  args: { secret: v.string(), owner: v.string(), fileId: v.id("_storage") },
  returns: v.object({ src: v.string(), mime: v.string(), size: v.number() }),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const photo = await ctx.db
      .query("photoUploads")
      .withIndex("by_fileId", (q) => q.eq("fileId", a.fileId))
      .unique();
    if (!photo || photo.owner !== a.owner)
      throw new ConvexError("Photo not found");
    const meta = await ctx.db.system.get("_storage", a.fileId),
      src = await ctx.storage.getUrl(a.fileId);
    if (!meta || !src) throw new ConvexError("Photo not found");
    return { src, mime: meta.contentType || "", size: meta.size };
  },
});
export const verify = mutation({
  args: {
    secret: v.string(),
    owner: v.string(),
    fileId: v.id("_storage"),
    w: v.number(),
    h: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const p = await ctx.db
      .query("photoUploads")
      .withIndex("by_fileId", (q) => q.eq("fileId", a.fileId))
      .unique();
    if (!p || p.owner !== a.owner) throw new ConvexError("Photo not found");
    if (
      !Number.isInteger(a.w) ||
      !Number.isInteger(a.h) ||
      a.w <= 0 ||
      a.h <= 0 ||
      a.w * a.h > 40000000
    )
      throw new ConvexError("Invalid photo dimensions");
    await ctx.db.patch("photoUploads", p._id, {
      verified: true,
      w: a.w,
      h: a.h,
    });
    return null;
  },
});
export const discard = mutation({
  args: { secret: v.string(), owner: v.string(), fileId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const p = await ctx.db
      .query("photoUploads")
      .withIndex("by_fileId", (q) => q.eq("fileId", a.fileId))
      .unique();
    if (!p || p.owner !== a.owner || p.used)
      throw new ConvexError("Photo not found");
    await ctx.storage.delete(p.fileId);
    await ctx.db.delete("photoUploads", p._id);
    return null;
  },
});
export const cleanup = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const tickets = await ctx.db
      .query("uploadTickets")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now()))
      .take(100);
    for (const t of tickets) await ctx.db.delete("uploadTickets", t._id);
    const photos = await ctx.db
      .query("photoUploads")
      .withIndex("by_used_and_expiresAt", (q) =>
        q.eq("used", false).lt("expiresAt", Date.now()),
      )
      .take(20);
    for (const p of photos) {
      await ctx.storage.delete(p.fileId);
      await ctx.db.delete("photoUploads", p._id);
    }
    return null;
  },
});
