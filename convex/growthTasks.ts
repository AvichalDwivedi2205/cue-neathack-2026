import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
export async function journey(ctx: MutationCtx, o: Doc<"growthOpportunities">) {
  const key = "growth-journey:" + o._id;
  const old = await ctx.db
    .query("agentTasks")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (old) return old;
  const id = await ctx.db.insert("agentTasks", {
    key,
    appId: o.appId,
    agent: "growth",
    action: "recommendation",
    opportunityId: o._id,
    title: "Recommendation · " + o.author,
    state: "blocked",
    stage: "Qualification not requested",
    blocker: "Original source saved. Product must request qualification.",
    attempts: 0,
    cancel: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return (await ctx.db.get("agentTasks", id))!;
}
export async function transition(
  ctx: MutationCtx,
  id: Id<"growthOpportunities">,
  who: string,
  state: Doc<"agentTasks">["state"],
  stage: string,
  text: string,
  reviewer?: string,
) {
  const o = await ctx.db.get("growthOpportunities", id);
  if (!o) return;
  const t = await journey(ctx, o);
  if (t.cancel) return;
  await ctx.db.patch("agentTasks", t._id, {
    state,
    stage,
    blocker: ["blocked", "awaiting"].includes(state) ? text : undefined,
    reviewer,
    dependencies: o.capabilityId
      ? ["Verified deployed capability " + o.capabilityId]
      : [],
    updatedAt: Date.now(),
  });
  await ctx.db.insert("agentTaskEvents", {
    taskId: t._id,
    actor: who,
    kind:
      state === "running"
        ? "started"
        : state === "failed"
          ? "failed"
          : ["blocked", "awaiting"].includes(state)
            ? "pending"
            : "completed",
    text,
    createdAt: Date.now(),
    evidence: "#/growth/" + o._id,
  });
}
