import { v, ConvexError } from "convex/values";
import { query, mutation } from "./_generated/server";
import { authorize } from "./access";
import { emit } from "./growth";
export const list = query({
  args: { secret: v.string(), owner: v.string() },
  returns: v.array(
    v.object({
      _id: v.id("memories"),
      id: v.id("memories"),
      title: v.string(),
      caption: v.string(),
      date: v.string(),
      w: v.number(),
      h: v.number(),
      src: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_owner_and_deleted", (q) =>
        q.eq("owner", a.owner).eq("deleted", false),
      )
      .order("desc")
      .take(200);
    return await Promise.all(
      rows.map(async (m) => ({
        _id: m._id,
        id: m._id,
        title: m.title,
        caption: m.caption,
        date: m.date,
        w: m.w,
        h: m.h,
        src: await ctx.storage.getUrl(m.fileId),
      })),
    );
  },
});
export const save = mutation({
  args: {
    secret: v.string(),
    owner: v.string(),
    id: v.optional(v.id("memories")),
    fileId: v.optional(v.id("_storage")),
    title: v.string(),
    caption: v.string(),
    date: v.string(),
    w: v.optional(v.number()),
    h: v.optional(v.number()),
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
      new Date(a.date).toISOString().slice(0, 10) !== a.date
    )
      throw new ConvexError("Invalid memory");
    const fields = { title: a.title.trim(), caption: a.caption, date: a.date };
    if (a.id) {
      const m = await ctx.db.get("memories", a.id);
      if (!m || m.owner !== a.owner || m.deleted)
        throw new ConvexError("Memory not found");
      await ctx.db.patch("memories", m._id, fields);
      return m._id;
    }
    if (!a.fileId) throw new ConvexError("Upload a photo first");
    const upload = await ctx.db
      .query("photoUploads")
      .withIndex("by_fileId", (q) => q.eq("fileId", a.fileId!))
      .unique();
    if (
      !upload ||
      upload.owner !== a.owner ||
      !upload.verified ||
      !upload.w ||
      !upload.h
    )
      throw new ConvexError("Photo not found in your verified uploads");
    await ctx.db.patch("photoUploads", upload._id, { used: true });
    const id = await ctx.db.insert("memories", {
      ...fields,
      owner: a.owner,
      fileId: a.fileId,
      w: upload.w,
      h: upload.h,
      deleted: false,
    });
    const attribution = await ctx.db
      .query("growthAttributions")
      .withIndex("by_owner", (q) => q.eq("owner", a.owner))
      .unique();
    if (attribution && !attribution.firstMemoryId) {
      await ctx.db.patch("growthAttributions", attribution._id, {
        firstMemoryId: id,
        savedAt: Date.now(),
      });
      await emit(ctx, attribution, "memory_created");
    }
    return id;
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
