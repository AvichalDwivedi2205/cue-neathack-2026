import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";
import { vOnCompleteArgs } from "@convex-dev/workpool";
import { currentHits, hitValidator } from "./knowledge";
export const hydrate = internalQuery({
  args: {
    workspaceId: v.string(),
    appId: v.string(),
    ids: v.array(v.id("knowledgeChunks")),
    audience: v.union(v.literal("customer"), v.literal("staff")),
  },
  returns: v.array(hitValidator),
  handler: (ctx, a) =>
    currentHits(ctx, a.ids, a.workspaceId, a.appId, a.audience),
});
export const completed = internalMutation({
  args: vOnCompleteArgs(
    v.object({
      sourceId: v.id("knowledgeSources"),
      versionId: v.id("knowledgeVersions"),
    }),
  ),
  returns: v.null(),
  handler: async (ctx, a) => {
    if (a.result.kind === "success") return null;
    const s = await ctx.db.get("knowledgeSources", a.context.sourceId);
    if (s?.pendingVersionId === a.context.versionId)
      await ctx.db.patch("knowledgeSources", s._id, {
        indexStatus: "failed",
        pendingVersionId: undefined,
        error:
          "The import worker could not finish. Retry Publish to resume indexing.",
      });
    return null;
  },
});
