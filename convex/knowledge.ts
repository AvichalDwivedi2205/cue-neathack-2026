import { v } from "convex/values";
import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api";
import { mutation, query, action } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authorize } from "./cue";
import schema from "./schema";
import { sourceKind, visibility } from "./knowledgeSchema";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  knowledgeScope,
  MAX_KNOWLEDGE_TEXT,
} from "../lib/knowledge-policy";

const scopeArgs = {
  secret: v.string(),
  workspaceId: v.string(),
  appId: v.string(),
};
const passage = v.object({
  text: v.string(),
  heading: v.string(),
  page: v.optional(v.number()),
});
export const hitValidator = v.object({
  _id: v.id("knowledgeChunks"),
  sourceId: v.id("knowledgeSources"),
  versionId: v.id("knowledgeVersions"),
  title: v.string(),
  text: v.string(),
  heading: v.string(),
  page: v.optional(v.number()),
  question: v.optional(v.string()),
  answer: v.optional(v.string()),
  alternatives: v.optional(v.array(v.string())),
});
export const pool = new Workpool(components.knowledgePool, {
  maxParallelism: 1,
  retryActionsByDefault: false,
});
async function ownedSource(
  ctx: QueryCtx,
  id: Id<"knowledgeSources">,
  workspace: string,
  app: string,
) {
  const source = await ctx.db.get("knowledgeSources", id);
  if (!source || source.workspaceId !== workspace || source.appId !== app)
    throw new Error("Knowledge source not found");
  return source;
}
export async function currentHits(
  ctx: QueryCtx,
  ids: Id<"knowledgeChunks">[],
  workspace: string,
  app: string,
  audience: "customer" | "staff",
) {
  const result = [];
  for (const id of ids.slice(0, 40)) {
    const c = await ctx.db.get("knowledgeChunks", id);
    if (!c || c.workspaceId !== workspace || c.appId !== app) continue;
    const s = await ctx.db.get("knowledgeSources", c.sourceId);
    if (
      !s ||
      s.workspaceId !== workspace ||
      s.appId !== app ||
      s.status !== "published" ||
      s.activeVersionId !== c.versionId ||
      (audience === "customer" && s.visibility !== "customer")
    )
      continue;
    const version = await ctx.db.get("knowledgeVersions", c.versionId);
    if (
      !version ||
      version.sourceId !== s._id ||
      version.workspaceId !== workspace ||
      version.appId !== app
    )
      continue;
    result.push({
      _id: c._id,
      sourceId: s._id,
      versionId: version._id,
      title: version.title,
      text: c.text,
      heading: c.heading,
      ...(c.page !== undefined ? { page: c.page } : {}),
      ...(version.question
        ? {
            question: version.question,
            answer: version.answer,
            alternatives: version.alternatives || [],
          }
        : {}),
    });
  }
  return result;
}
export const snapshot = query({
  args: scopeArgs,
  returns: v.array(schema.doc("knowledgeSources")),
  handler: async (ctx, a) => {
    authorize(a.secret);
    return ctx.db
      .query("knowledgeSources")
      .withIndex("by_workspaceId_and_appId", (q) =>
        q.eq("workspaceId", a.workspaceId).eq("appId", a.appId),
      )
      .order("desc")
      .take(100);
  },
});
export const detail = query({
  args: { ...scopeArgs, sourceId: v.id("knowledgeSources") },
  returns: v.object({
    source: schema.doc("knowledgeSources"),
    version: v.union(v.null(), schema.doc("knowledgeVersions")),
    passages: v.array(passage),
  }),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const source = await ownedSource(ctx, a.sourceId, a.workspaceId, a.appId);
    const version = source.latestVersionId
      ? await ctx.db.get("knowledgeVersions", source.latestVersionId)
      : null;
    const chunks = version
      ? await ctx.db
          .query("knowledgeChunks")
          .withIndex("by_versionId", (q) => q.eq("versionId", version._id))
          .take(161)
      : [];
    return {
      source,
      version,
      passages: chunks
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((c) => ({
          text: c.text,
          heading: c.heading,
          ...(c.page !== undefined ? { page: c.page } : {}),
        })),
    };
  },
});
export const save = mutation({
  args: {
    ...scopeArgs,
    sourceId: v.optional(v.id("knowledgeSources")),
    expectedRevision: v.optional(v.number()),
    title: v.string(),
    kind: sourceKind,
    visibility,
    text: v.string(),
    hash: v.string(),
    passages: v.array(passage),
    actor: v.string(),
    question: v.optional(v.string()),
    answer: v.optional(v.string()),
    alternatives: v.optional(v.array(v.string())),
    url: v.optional(v.string()),
    fileId: v.optional(v.id("_storage")),
    fileName: v.optional(v.string()),
  },
  returns: v.id("knowledgeSources"),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (
      !a.title.trim() ||
      a.title.length > 160 ||
      !a.text.trim() ||
      a.text.length > MAX_KNOWLEDGE_TEXT ||
      !a.passages.length ||
      a.passages.length > 160 ||
      a.passages.some((p) => !p.text.trim() || p.text.length > 5000)
    )
      throw new Error("Invalid knowledge document");
    if (a.kind === "faq" && (!a.question?.trim() || !a.answer?.trim()))
      throw new Error("FAQ needs a question and answer");
    const existing = a.sourceId
      ? await ownedSource(ctx, a.sourceId, a.workspaceId, a.appId)
      : null;
    if (existing && a.expectedRevision !== existing.revision)
      throw new Error("Source changed; reload before saving");
    if (!existing) {
      const count = await ctx.db
        .query("knowledgeSources")
        .withIndex("by_workspaceId_and_appId", (q) =>
          q.eq("workspaceId", a.workspaceId).eq("appId", a.appId),
        )
        .take(100);
      if (count.length >= 100)
        throw new Error("This app supports up to 100 knowledge sources");
    }
    const sourceId =
      existing?._id ||
      (await ctx.db.insert("knowledgeSources", {
        workspaceId: a.workspaceId,
        appId: a.appId,
        title: a.title,
        kind: a.kind,
        visibility: a.visibility,
        status: "draft",
        revision: 0,
        indexStatus: "idle",
        createdBy: a.actor,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));
    const revision = (existing?.revision || 0) + 1;
    const oldVersion = existing?.latestVersionId
      ? await ctx.db.get("knowledgeVersions", existing.latestVersionId)
      : null;
    const reusable =
      oldVersion?.title === a.title
        ? await ctx.db
            .query("knowledgeChunks")
            .withIndex("by_versionId", (q) => q.eq("versionId", oldVersion._id))
            .take(161)
        : [];
    const versionId = await ctx.db.insert("knowledgeVersions", {
      sourceId,
      workspaceId: a.workspaceId,
      appId: a.appId,
      revision,
      title: a.title,
      text: a.text,
      hash: a.hash,
      visibility: a.visibility,
      createdBy: a.actor,
      createdAt: Date.now(),
      ...(a.question
        ? {
            question: a.question,
            answer: a.answer,
            alternatives: a.alternatives || [],
          }
        : {}),
      ...(a.url || oldVersion?.url ? { url: a.url || oldVersion?.url } : {}),
      ...(a.fileId || oldVersion?.fileId
        ? { fileId: a.fileId || oldVersion?.fileId }
        : {}),
      ...(a.fileName || oldVersion?.fileName
        ? { fileName: a.fileName || oldVersion?.fileName }
        : {}),
    });
    for (const [ordinal, p] of a.passages.entries()) {
      const cached = reusable.find(
        (c) =>
          c.text === p.text &&
          c.heading === p.heading &&
          c.embeddingModel === EMBEDDING_MODEL &&
          c.embedding?.length === EMBEDDING_DIMENSIONS,
      );
      await ctx.db.insert("knowledgeChunks", {
        ...p,
        sourceId,
        versionId,
        workspaceId: a.workspaceId,
        appId: a.appId,
        ordinal,
        scopeKey: "draft:" + versionId,
        ...(cached
          ? {
              embedding: cached.embedding,
              embeddingModel: cached.embeddingModel,
            }
          : {}),
      });
    }
    await ctx.db.patch("knowledgeSources", sourceId, {
      latestVersionId: versionId,
      revision,
      indexStatus: "idle",
      pendingVersionId: undefined,
      error: undefined,
      updatedAt: Date.now(),
    });
    return sourceId;
  },
});
export const publish = mutation({
  args: {
    ...scopeArgs,
    sourceId: v.id("knowledgeSources"),
    expectedRevision: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const s = await ownedSource(ctx, a.sourceId, a.workspaceId, a.appId);
    if (s.revision !== a.expectedRevision)
      throw new Error("Source changed; reload before publishing");
    if (!s.latestVersionId) throw new Error("Save a draft first");
    if (
      s.pendingVersionId === s.latestVersionId &&
      ["queued", "indexing"].includes(s.indexStatus)
    )
      return null;
    await ctx.db.patch("knowledgeSources", s._id, {
      pendingVersionId: s.latestVersionId,
      indexStatus: "queued",
      error: undefined,
      updatedAt: Date.now(),
    });
    await pool.enqueueAction(
      ctx,
      internal.hosted.knowledge,
      { sourceId: s._id, versionId: s.latestVersionId },
      {
        onComplete: internal.knowledgeInternal.completed,
        context: { sourceId: s._id, versionId: s.latestVersionId },
      },
    );
    return null;
  },
});
export const withdraw = mutation({
  args: { ...scopeArgs, sourceId: v.id("knowledgeSources") },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const s = await ownedSource(ctx, a.sourceId, a.workspaceId, a.appId);
    if (s.activeVersionId)
      for (const c of await ctx.db
        .query("knowledgeChunks")
        .withIndex("by_versionId", (q) => q.eq("versionId", s.activeVersionId!))
        .take(161))
        await ctx.db.patch("knowledgeChunks", c._id, {
          scopeKey: "withdrawn:" + c.versionId,
        });
    await ctx.db.patch("knowledgeSources", s._id, {
      status: "withdrawn",
      indexStatus: "idle",
      pendingVersionId: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});
export const beginIndex = mutation({
  args: {
    secret: v.string(),
    sourceId: v.id("knowledgeSources"),
    versionId: v.id("knowledgeVersions"),
  },
  returns: v.union(
    v.null(),
    v.object({
      version: schema.doc("knowledgeVersions"),
      chunks: v.array(schema.doc("knowledgeChunks")),
    }),
  ),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const s = await ctx.db.get("knowledgeSources", a.sourceId);
    if (
      !s ||
      s.pendingVersionId !== a.versionId ||
      s.latestVersionId !== a.versionId
    )
      return null;
    const version = await ctx.db.get("knowledgeVersions", a.versionId);
    if (!version) return null;
    await ctx.db.patch("knowledgeSources", s._id, { indexStatus: "indexing" });
    return {
      version,
      chunks: await ctx.db
        .query("knowledgeChunks")
        .withIndex("by_versionId", (q) => q.eq("versionId", a.versionId))
        .take(161),
    };
  },
});
export const vectors = mutation({
  args: {
    secret: v.string(),
    sourceId: v.id("knowledgeSources"),
    versionId: v.id("knowledgeVersions"),
    vectors: v.array(
      v.object({
        id: v.id("knowledgeChunks"),
        embedding: v.array(v.float64()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const s = await ctx.db.get("knowledgeSources", a.sourceId);
    if (
      !s ||
      s.pendingVersionId !== a.versionId ||
      s.latestVersionId !== a.versionId
    )
      return null;
    if (a.vectors.length > 8) throw new Error("Batch is too large");
    for (const item of a.vectors) {
      const c = await ctx.db.get("knowledgeChunks", item.id);
      if (
        !c ||
        c.sourceId !== s._id ||
        c.versionId !== a.versionId ||
        item.embedding.length !== EMBEDDING_DIMENSIONS ||
        item.embedding.some((n) => !Number.isFinite(n))
      )
        throw new Error("Invalid embedding");
      await ctx.db.patch("knowledgeChunks", c._id, {
        embedding: item.embedding,
        embeddingModel: EMBEDDING_MODEL,
      });
    }
    return null;
  },
});
export const commit = mutation({
  args: {
    secret: v.string(),
    sourceId: v.id("knowledgeSources"),
    versionId: v.id("knowledgeVersions"),
    error: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const s = await ctx.db.get("knowledgeSources", a.sourceId);
    if (
      !s ||
      s.pendingVersionId !== a.versionId ||
      s.latestVersionId !== a.versionId
    )
      return false;
    if (a.error) {
      await ctx.db.patch("knowledgeSources", s._id, {
        indexStatus: "failed",
        error: a.error.slice(0, 250),
        pendingVersionId: undefined,
      });
      return false;
    }
    const version = await ctx.db.get("knowledgeVersions", a.versionId);
    const chunks = await ctx.db
      .query("knowledgeChunks")
      .withIndex("by_versionId", (q) => q.eq("versionId", a.versionId))
      .take(161);
    if (
      !version ||
      !chunks.length ||
      chunks.some(
        (c) =>
          c.embedding?.length !== EMBEDDING_DIMENSIONS ||
          c.embeddingModel !== EMBEDDING_MODEL,
      )
    )
      throw new Error("Index is incomplete");
    if (s.activeVersionId && s.activeVersionId !== a.versionId)
      for (const old of await ctx.db
        .query("knowledgeChunks")
        .withIndex("by_versionId", (q) => q.eq("versionId", s.activeVersionId!))
        .take(161))
        await ctx.db.patch("knowledgeChunks", old._id, {
          scopeKey: "retired:" + old.versionId,
        });
    for (const c of chunks)
      await ctx.db.patch("knowledgeChunks", c._id, {
        scopeKey: knowledgeScope(s.workspaceId, s.appId, version.visibility),
      });
    await ctx.db.patch("knowledgeSources", s._id, {
      activeVersionId: version._id,
      visibility: version.visibility,
      title: version.title,
      status: "published",
      indexStatus: "idle",
      pendingVersionId: undefined,
      error: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});
export const keyword = query({
  args: {
    ...scopeArgs,
    text: v.string(),
    audience: v.union(v.literal("customer"), v.literal("staff")),
  },
  returns: v.array(hitValidator),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (!a.text.trim()) return [];
    const audiences =
      a.audience === "staff" ? ["customer", "internal"] : ["customer"];
    const lists = await Promise.all(
      audiences.map((audience) =>
        ctx.db
          .query("knowledgeChunks")
          .withSearchIndex("search_text", (q) =>
            q
              .search("text", a.text)
              .eq("scopeKey", knowledgeScope(a.workspaceId, a.appId, audience)),
          )
          .take(10),
      ),
    );
    return currentHits(
      ctx,
      lists.flat().map((c) => c._id),
      a.workspaceId,
      a.appId,
      a.audience,
    );
  },
});
export const hydrate = query({
  args: {
    ...scopeArgs,
    ids: v.array(v.id("knowledgeChunks")),
    audience: v.union(v.literal("customer"), v.literal("staff")),
  },
  returns: v.array(hitValidator),
  handler: async (ctx, a) => {
    authorize(a.secret);
    return currentHits(ctx, a.ids, a.workspaceId, a.appId, a.audience);
  },
});
export const semantic = action({
  args: {
    ...scopeArgs,
    embedding: v.array(v.float64()),
    audience: v.union(v.literal("customer"), v.literal("staff")),
  },
  returns: v.array(hitValidator),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (a.embedding.length !== EMBEDDING_DIMENSIONS)
      throw new Error("Embedding dimensions mismatch");
    const scopes = (
      a.audience === "staff" ? ["customer", "internal"] : ["customer"]
    ).map((v) => knowledgeScope(a.workspaceId, a.appId, v));
    const hits = await ctx.vectorSearch("knowledgeChunks", "by_embedding", {
      vector: a.embedding,
      limit: 10,
      filter: (q) =>
        scopes.length === 1
          ? q.eq("scopeKey", scopes[0])
          : q.or(...scopes.map((s) => q.eq("scopeKey", s))),
    });
    const hydrated: Array<typeof hitValidator.type> = await ctx.runQuery(
      internal.knowledgeInternal.hydrate,
      {
        workspaceId: a.workspaceId,
        appId: a.appId,
        ids: hits.filter((h) => h._score >= 0.4).map((h) => h._id),
        audience: a.audience,
      },
    );
    return hydrated;
  },
});
export const uploadUrl = mutation({
  args: { secret: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    return ctx.storage.generateUploadUrl();
  },
});
export const fileUrl = query({
  args: { ...scopeArgs, sourceId: v.id("knowledgeSources") },
  returns: v.union(v.null(), v.object({ url: v.string(), name: v.string() })),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const s = await ownedSource(ctx, a.sourceId, a.workspaceId, a.appId);
    const version = s.latestVersionId
      ? await ctx.db.get("knowledgeVersions", s.latestVersionId)
      : null;
    const url = version?.fileId
      ? await ctx.storage.getUrl(version.fileId)
      : null;
    return url ? { url, name: version?.fileName || "document" } : null;
  },
});
export const widgetEvidence = query({
  args: { ...scopeArgs, owner: v.string(), caseId: v.id("cases") },
  returns: v.array(
    v.object({
      messageId: v.id("messages"),
      status: v.string(),
      citations: v.array(
        v.object({
          title: v.string(),
          heading: v.string(),
          page: v.optional(v.number()),
          excerpt: v.string(),
        }),
      ),
    }),
  ),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const c = await ctx.db.get("cases", a.caseId);
    if (
      !c ||
      c.owner !== a.owner ||
      c.appId !== a.appId ||
      !a.owner.startsWith("widget:" + a.appId + ":")
    )
      throw new Error("Wrong app conversation");
    const records = await ctx.db
      .query("knowledgeEvidence")
      .withIndex("by_caseId", (q) => q.eq("caseId", a.caseId))
      .order("desc")
      .take(100);
    return Promise.all(
      records
        .filter((r) => r.workspaceId === a.workspaceId && r.appId === a.appId)
        .map(async (r) => ({
          messageId: r.messageId,
          status: r.status,
          citations: (
            await currentHits(
              ctx,
              r.chunkIds,
              a.workspaceId,
              a.appId,
              "customer",
            )
          ).map((h) => ({
            title: h.title,
            heading: h.heading,
            ...(h.page !== undefined ? { page: h.page } : {}),
            excerpt: h.text.slice(0, 1600),
          })),
        })),
    );
  },
});
