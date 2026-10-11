import schema from "./schema";
import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { authorize } from "./cue";
export const memories = query({
  args: { secret: v.string(), owner: v.string() },
  returns: v.array(
    schema
      .doc("memories")
      .extend({ id: v.id("memories"), src: v.union(v.string(), v.null()) }),
  ),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_owner", (q) => q.eq("owner", a.owner))
      .take(200);
    return await Promise.all(
      rows
        .filter((m) => !m.deleted)
        .map(async (m) => ({
          ...m,
          id: m._id,
          src: m.fileId ? await ctx.storage.getUrl(m.fileId) : null,
        })),
    );
  },
});
export const uploadUrl = mutation({
  args: { secret: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    return await ctx.storage.generateUploadUrl();
  },
});
export const recordPhoto = mutation({
  args: { secret: v.string(), owner: v.string(), fileId: v.id("_storage") },
  returns: v.id("photoUploads"),
  handler: async (ctx, a) => {
    authorize(a.secret);
    return await ctx.db.insert("photoUploads", {
      owner: a.owner,
      fileId: a.fileId,
      createdAt: Date.now(),
    });
  },
});
export const seed = mutation({
  args: {
    secret: v.string(),
    owner: v.string(),
    memories: v.array(
      v.object({
        title: v.string(),
        caption: v.string(),
        date: v.string(),
        w: v.number(),
        h: v.number(),
        seed: v.string(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (
      await ctx.db
        .query("memories")
        .withIndex("by_owner", (q) => q.eq("owner", a.owner))
        .first()
    )
      return null;
    for (const m of a.memories.slice(0, 20))
      await ctx.db.insert("memories", {
        ...m,
        owner: a.owner,
        deleted: false,
        createdAt: Date.now(),
      });
    return null;
  },
});
export const save = mutation({
  args: {
    secret: v.string(),
    owner: v.string(),
    id: v.optional(v.id("memories")),
    title: v.string(),
    caption: v.string(),
    date: v.string(),
    w: v.number(),
    h: v.number(),
    fileId: v.optional(v.id("_storage")),
  },
  returns: v.id("memories"),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (
      !a.title.trim() ||
      a.title.length > 80 ||
      a.caption.length > 280 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(a.date) ||
      !Number.isFinite(Date.parse(a.date)) ||
      new Date(a.date).toISOString().slice(0, 10) !== a.date ||
      a.w <= 0 ||
      a.h <= 0
    )
      throw new ConvexError("Invalid memory");
    const fields = {
      title: a.title.trim(),
      caption: a.caption,
      date: a.date,
      w: a.w,
      h: a.h,
    };
    if (a.id) {
      const m = await ctx.db.get("memories", a.id);
      if (!m || m.owner !== a.owner) throw new ConvexError("Memory not found");
      await ctx.db.patch("memories", m._id, fields);
      return m._id;
    }
    if (!a.fileId) throw new ConvexError("Upload a photo first");
    const upload = await ctx.db
      .query("photoUploads")
      .withIndex("by_fileId", (q) => q.eq("fileId", a.fileId!))
      .unique();
    if (!upload || upload.owner !== a.owner)
      throw new ConvexError("Photo not found in your uploads");
    return await ctx.db.insert("memories", {
      ...fields,
      owner: a.owner,
      fileId: a.fileId,
      deleted: false,
      createdAt: Date.now(),
    });
  },
});
export const remove = mutation({
  args: {
    secret: v.string(),
    owner: v.string(),
    id: v.id("memories"),
    undo: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const m = await ctx.db.get("memories", a.id);
    if (!m || m.owner !== a.owner) throw new ConvexError("Memory not found");
    await ctx.db.patch("memories", m._id, { deleted: !a.undo });
    return null;
  },
});
export const conversation = query({
  args: { secret: v.string(), owner: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      case: schema.doc("cases"),
      messages: v.array(schema.doc("messages")),
      attachments: v.array(
        v.object({ name: v.string(), url: v.union(v.string(), v.null()) }),
      ),
      issue: v.union(schema.doc("issues"), v.null()),
      run: v.union(schema.doc("runs"), v.null()),
    }),
  ),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const c = await ctx.db
      .query("cases")
      .withIndex("by_owner", (q) => q.eq("owner", a.owner))
      .order("desc")
      .first();
    if (!c) return null;
    return {
      case: c,
      messages: (
        await ctx.db
          .query("messages")
          .withIndex("by_caseId_and_createdAt", (q) => q.eq("caseId", c._id))
          .order("desc")
          .take(100)
      ).reverse(),
      attachments: await Promise.all(
        (
          await ctx.db
            .query("attachments")
            .withIndex("by_caseId", (q) => q.eq("caseId", c._id))
            .order("desc")
            .take(20)
        )
          .filter((a) => a.owner === c.owner)
          .map(async (a) => ({
            name: a.name,
            url: await ctx.storage.getUrl(a.fileId),
          })),
      ),
      issue: c.issueId ? await ctx.db.get("issues", c.issueId) : null,
      run: c.issueId
        ? await ctx.db
            .query("runs")
            .withIndex("by_issueId_and_createdAt", (q) =>
              q.eq("issueId", c.issueId!),
            )
            .order("desc")
            .first()
        : null,
    };
  },
});
export const attachment = mutation({
  args: {
    secret: v.string(),
    owner: v.string(),
    caseId: v.optional(v.id("cases")),
    fileId: v.id("_storage"),
    name: v.string(),
  },
  returns: v.id("attachments"),
  handler: async (ctx, a) => {
    authorize(a.secret);
    return await ctx.db.insert("attachments", {
      owner: a.owner,
      caseId: a.caseId,
      fileId: a.fileId,
      name: a.name,
      createdAt: Date.now(),
    });
  },
});
