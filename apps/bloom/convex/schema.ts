import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({
  growthAttributions: defineTable({
    owner: v.string(),
    touchId: v.string(),
    expiresAt: v.number(),
    browser: v.string(),
    internal: v.boolean(),
    returning: v.boolean(),
    firstMemoryId: v.optional(v.id("memories")),
    savedAt: v.optional(v.number()),
    searchedAt: v.optional(v.number()),
  }).index("by_owner", ["owner"]),
  growthOutbox: defineTable({
    touchId: v.string(),
    browser: v.string(),
    type: v.union(
      v.literal("session_confirmed"),
      v.literal("memory_created"),
      v.literal("caption_search_match"),
    ),
    occurredAt: v.number(),
    internal: v.boolean(),
    returning: v.boolean(),
    state: v.union(
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    retryAt: v.number(),
    lease: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
  }).index("by_state_and_retryAt", ["state", "retryAt"]),
  memories: defineTable({
    owner: v.string(),
    fileId: v.id("_storage"),
    title: v.string(),
    caption: v.string(),
    date: v.string(),
    w: v.number(),
    h: v.number(),
    deleted: v.boolean(),
  }).index("by_owner_and_deleted", ["owner", "deleted"]),
  photoUploads: defineTable({
    owner: v.string(),
    fileId: v.id("_storage"),
    verified: v.boolean(),
    used: v.boolean(),
    expiresAt: v.number(),
    w: v.optional(v.number()),
    h: v.optional(v.number()),
  })
    .index("by_fileId", ["fileId"])
    .index("by_used_and_expiresAt", ["used", "expiresAt"]),
  uploadTickets: defineTable({
    owner: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
    claimed: v.boolean(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_expiresAt", ["expiresAt"]),
  supportLinks: defineTable({
    owner: v.string(),
    token: v.string(),
    expiresAt: v.number(),
  }).index("by_owner", ["owner"]),
});
