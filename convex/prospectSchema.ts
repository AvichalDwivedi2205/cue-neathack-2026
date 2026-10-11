import { defineTable } from "convex/server";
import { v } from "convex/values";
export const prospectFields = {
  companyId: v.number(),
  name: v.string(),
  domain: v.string(),
  description: v.string(),
  employees: v.union(v.number(), v.null()),
  country: v.union(v.string(), v.null()),
  enriched: v.boolean(),
  fit: v.union(v.literal("potential"), v.literal("review"), v.literal("low")),
  reasons: v.array(v.string()),
  gaps: v.array(v.string()),
};
export const prospectDisposition = v.union(
  v.literal("candidate"),
  v.literal("shortlisted"),
  v.literal("dismissed"),
);
export const prospectTables = {
  prospectRuns: defineTable({
    scope: v.literal("cue"),
    key: v.string(),
    query: v.string(),
    limit: v.number(),
    actor: v.string(),
    state: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
    reservedCredits: v.number(),
    usedCredits: v.union(v.number(), v.null()),
    count: v.number(),
    warning: v.union(v.string(), v.null()),
    traceId: v.union(v.string(), v.null()),
  })
    .index("by_key", ["key"])
    .index("by_scope_and_createdAt", ["scope", "createdAt"]),
  prospectCompanies: defineTable({
    ...prospectFields,
    scope: v.literal("cue"),
    runId: v.id("prospectRuns"),
    query: v.string(),
    disposition: prospectDisposition,
    firstFoundAt: v.number(),
    lastFoundAt: v.number(),
    reviewedAt: v.union(v.number(), v.null()),
  })
    .index("by_scope_and_companyId", ["scope", "companyId"])
    .index("by_scope_and_lastFoundAt", ["scope", "lastFoundAt"]),
};
