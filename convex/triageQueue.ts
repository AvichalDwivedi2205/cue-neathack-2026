import { Workpool, vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { env, internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authorize } from "./cue";
import schema from "./schema";

export const pool = new Workpool(components.triagePool, {
  maxParallelism: 2,
  retryActionsByDefault: true,
  defaultRetryBehavior: { maxAttempts: 5, initialBackoffMs: 2000, base: 2 },
});

async function enqueueLatest(ctx: MutationCtx, caseId: Id<"cases">) {
  if (!env.CUE_BACKGROUND_ORIGIN) return null;
  const message = await ctx.db
    .query("messages")
    .withIndex("by_caseId_and_role_and_createdAt", (q) =>
      q.eq("caseId", caseId).eq("role", "customer"),
    )
    .order("desc")
    .first();
  if (!message) return null;
  const old = await ctx.db
    .query("triageReceipts")
    .withIndex("by_messageId", (q) => q.eq("messageId", message._id))
    .unique();
  if (old && old.status !== "failed") return old._id;
  const receiptId =
    old?._id ||
    (await ctx.db.insert("triageReceipts", {
      caseId,
      messageId: message._id,
      status: "queued",
      updatedAt: Date.now(),
    }));
  const workId = await pool.enqueueAction(
    ctx,
    internal.hosted.triage,
    { receiptId },
    {
      onComplete: internal.triageQueue.completed,
      context: { receiptId },
    },
  );
  await ctx.db.patch("triageReceipts", receiptId, {
    status: "queued",
    workId,
    updatedAt: Date.now(),
  });
  return receiptId;
}

// Called in the intake transaction, so acknowledgment cannot lose the AI work.
export const enqueue = internalMutation({
  args: { caseId: v.id("cases") },
  returns: v.union(v.null(), v.id("triageReceipts")),
  handler: async (ctx, a) => enqueueLatest(ctx, a.caseId),
});

export const request = mutation({
  args: { secret: v.string(), caseId: v.id("cases") },
  returns: v.union(v.null(), v.id("triageReceipts")),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (!(await ctx.db.get("cases", a.caseId)))
      throw new Error("Case not found");
    return enqueueLatest(ctx, a.caseId);
  },
});

export const receipt = query({
  args: { secret: v.string(), receiptId: v.id("triageReceipts") },
  returns: v.union(
    v.null(),
    schema.doc("triageReceipts").extend({ latest: v.boolean() }),
  ),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const receipt = await ctx.db.get("triageReceipts", a.receiptId);
    if (!receipt) return null;
    const message = await ctx.db
      .query("messages")
      .withIndex("by_caseId_and_role_and_createdAt", (q) =>
        q.eq("caseId", receipt.caseId).eq("role", "customer"),
      )
      .order("desc")
      .first();
    return { ...receipt, latest: message?._id === receipt.messageId };
  },
});

export const supersede = mutation({
  args: { secret: v.string(), receiptId: v.id("triageReceipts") },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const row = await ctx.db.get("triageReceipts", a.receiptId);
    if (row?.status === "queued")
      await ctx.db.patch("triageReceipts", row._id, {
        status: "superseded",
        updatedAt: Date.now(),
      });
    return null;
  },
});

export const completed = internalMutation({
  args: vOnCompleteArgs(v.object({ receiptId: v.id("triageReceipts") }), v.null()),
  returns: v.null(),
  handler: async (ctx, { workId, context, result }) => {
    const row = await ctx.db.get("triageReceipts", context.receiptId);
    if (
      !row ||
      row.workId !== workId ||
      row.status !== "queued" ||
      result.kind === "success"
    )
      return null;
    await ctx.db.patch("triageReceipts", row._id, {
      status: "failed",
      updatedAt: Date.now(),
    });
    const report = await ctx.db.get("cases", row.caseId);
    if (report)
      await ctx.db.insert("events", {
        issueId: report.issueId,
        kind: "failure",
        title: "AI triage needs review",
        detail:
          "The saved report survived repeated AI or service failures. An operator can retry triage; no investigation or release is implied.",
        createdAt: Date.now(),
      });
    return null;
  },
});
