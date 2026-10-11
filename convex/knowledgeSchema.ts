import { defineTable } from "convex/server";
import { v } from "convex/values";
export const visibility = v.union(v.literal("customer"), v.literal("internal"));
export const sourceKind = v.union(
  v.literal("faq"),
  v.literal("text"),
  v.literal("file"),
  v.literal("url"),
  v.literal("github"),
);
export const knowledgeReply = v.object({
  workspaceId: v.string(),
  usedChunkIds: v.array(v.id("knowledgeChunks")),
  citedChunkIds: v.array(v.id("knowledgeChunks")),
  status: v.string(),
  provider: v.string(),
  model: v.string(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  retrieval: v.optional(v.string()),
});
export const knowledgeTables = {
  knowledgeSources: defineTable({
    workspaceId: v.string(),
    appId: v.string(),
    title: v.string(),
    kind: sourceKind,
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("withdrawn"),
    ),
    visibility,
    revision: v.number(),
    latestVersionId: v.optional(v.id("knowledgeVersions")),
    activeVersionId: v.optional(v.id("knowledgeVersions")),
    pendingVersionId: v.optional(v.id("knowledgeVersions")),
    indexStatus: v.union(
      v.literal("idle"),
      v.literal("queued"),
      v.literal("indexing"),
      v.literal("failed"),
    ),
    error: v.optional(v.string()),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspaceId_and_appId", ["workspaceId", "appId"]),
  knowledgeVersions: defineTable({
    sourceId: v.id("knowledgeSources"),
    workspaceId: v.string(),
    appId: v.string(),
    revision: v.number(),
    title: v.string(),
    visibility,
    text: v.string(),
    hash: v.string(),
    question: v.optional(v.string()),
    answer: v.optional(v.string()),
    alternatives: v.optional(v.array(v.string())),
    url: v.optional(v.string()),
    fileId: v.optional(v.id("_storage")),
    fileName: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.string(),
  }).index("by_sourceId", ["sourceId"]),
  knowledgeChunks: defineTable({
    sourceId: v.id("knowledgeSources"),
    versionId: v.id("knowledgeVersions"),
    workspaceId: v.string(),
    appId: v.string(),
    scopeKey: v.string(),
    text: v.string(),
    heading: v.string(),
    page: v.optional(v.number()),
    ordinal: v.number(),
    embedding: v.optional(v.array(v.float64())),
    embeddingModel: v.optional(v.string()),
  })
    .index("by_versionId", ["versionId"])
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["scopeKey"],
    })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 768,
      filterFields: ["scopeKey"],
    }),
  knowledgeEvidence: defineTable({
    messageId: v.id("messages"),
    caseId: v.id("cases"),
    workspaceId: v.string(),
    appId: v.string(),
    chunkIds: v.array(v.id("knowledgeChunks")),
    usedChunkIds: v.optional(v.array(v.id("knowledgeChunks"))),
    retrieval: v.optional(v.string()),
    status: v.string(),
    provider: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    createdAt: v.number(),
  })
    .index("by_messageId", ["messageId"])
    .index("by_caseId", ["caseId"])
    .index("by_workspaceId_and_appId", ["workspaceId", "appId"]),
};
