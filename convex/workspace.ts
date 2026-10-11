import { createThread, listMessages, saveMessages } from "@convex-dev/agent";
import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v, ConvexError } from "convex/values";
import { api, components, internal } from "./_generated/api";
import { mutation, query, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authorize } from "./cue";
import schema from "./schema";
import { actor, agentId, commandAction } from "./workspaceValidators";
import { pool } from "./triageQueue";

const ref = (t: Doc<"agentTasks">) => `#/agents/${t.agent}/${t._id}`;
const active = [
  "queued",
  "running",
  "retrying",
  "awaiting",
  "blocked",
  "canceling",
];
// One-time additive projection of genuine existing runs. It queues no work.
export const importRuns = mutation({
  args: { secret: v.string() },
  returns: v.number(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    let imported = 0;
    for (const run of await ctx.db.query("runs").order("desc").take(100)) {
      const issue = await ctx.db.get("issues", run.issueId);
      if (!issue) continue;
      const action =
        run.kind === "feature"
          ? ("delegate" as const)
          : ("investigate" as const);
      const key = `${issue.appId || "bloom"}:engineering:${action}:${issue._id}`;
      if (
        await ctx.db
          .query("agentTasks")
          .withIndex("by_key", (q) => q.eq("key", key))
          .first()
      )
        continue;
      const taskId = await ctx.db.insert("agentTasks", {
        appId: issue.appId || "bloom",
        agent: "engineering",
        action,
        key,
        title: issue.title,
        issueId: issue._id,
        runId: run._id,
        state: "queued",
        stage: run.phase,
        attempts: 0,
        cancel: false,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
      await event(
        ctx,
        taskId,
        "Coordinator",
        "completed",
        "Existing execution linked. This import starts no new coding run.",
        run._id,
      );
      imported++;
    }
    return imported;
  },
});
async function event(
  ctx: MutationCtx,
  taskId: Id<"agentTasks">,
  who: string,
  kind: string,
  text: string,
  evidence?: string,
) {
  await ctx.db.insert("agentTaskEvents", {
    taskId,
    actor: who,
    kind,
    text,
    createdAt: Date.now(),
    ...(evidence ? { evidence } : {}),
  });
}
export async function taskView(ctx: MutationCtx, task: Doc<"agentTasks">) {
  if (!task.runId)
    return task.state === "running" &&
      task.leaseUntil &&
      task.leaseUntil < Date.now()
      ? {
          ...task,
          state: "blocked" as const,
          blocker:
            "Worker lease expired. Await bounded retry or request recovery; saved effects retained.",
        }
      : task;
  const run = await ctx.db.get("runs", task.runId);
  if (!run)
    return {
      ...task,
      state: "failed" as const,
      blocker: "Linked run is unavailable",
    };
  const job = (await ctx.db.query("jobs").order("desc").take(100)).find(
    (j) => j.runId === run._id,
  );
  const state =
    run.status === "resolved" && run.verified && run.deployed
      ? "completed"
      : run.status === "awaiting_approval"
        ? "awaiting"
        : ["failed", "canceled"].includes(run.status)
          ? run.status
          : run.status === "approved"
            ? "blocked"
            : run.status === "rejected"
              ? "blocked"
              : job?.status === "queued"
                ? "queued"
                : "running";
  return {
    ...task,
    state: state as Doc<"agentTasks">["state"],
    stage: run.phase,
    blocker:
      run.error ||
      (run.status === "approved"
        ? "Commit approved. Deployment and release verification still required."
        : run.status === "rejected"
          ? "Commit rejected. Review feedback before starting new work."
          : undefined),
    updatedAt: run.updatedAt,
    run,
  };
}
export const snapshot = query({
  args: { secret: v.string(), appId: v.string(), participant: v.string() },
  returns: v.object({
    tasks: v.array(schema.doc("agentTasks")),
    events: v.array(schema.doc("agentTaskEvents")),
    conversations: v.array(
      v.object({
        agent: agentId,
        messages: v.array(
          v.object({
            id: v.string(),
            role: v.string(),
            text: v.string(),
            at: v.number(),
            via: v.string(),
            context: v.optional(v.string()),
            answerStatus: v.optional(v.string()),
          }),
        ),
      }),
    ),
  }),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const tasks = await ctx.db
      .query("agentTasks")
      .withIndex("by_appId", (q) => q.eq("appId", a.appId))
      .order("desc")
      .take(100);
    const events = (
      await Promise.all(
        tasks.map((t) =>
          ctx.db
            .query("agentTaskEvents")
            .withIndex("by_taskId", (q) => q.eq("taskId", t._id))
            .order("desc")
            .take(100),
        ),
      )
    ).flat();
    const conversations = [];
    for (const agent of ["x", "reddit", "growth", "engineering"] as const) {
      const c = await ctx.db
        .query("agentConversations")
        .withIndex("by_appId_and_agent_and_participant", (q) =>
          q
            .eq("appId", a.appId)
            .eq("agent", agent)
            .eq("participant", a.participant),
        )
        .unique();
      if (!c) continue;
      const messages = await listMessages(ctx, components.agent, {
        threadId: c.threadId,
        paginationOpts: { numItems: 100, cursor: null },
        excludeToolMessages: true,
      });
      const commands = await ctx.db
        .query("agentCommands")
        .withIndex("by_conversationId", (q) => q.eq("conversationId", c._id))
        .order("desc")
        .take(100);
      conversations.push({
        agent,
        messages: messages.page.reverse().map((m) => {
          const command = commands.find(
            (c) => c.promptId === m._id || c.replyId === m._id,
          );
          return {
            id: m._id,
            role: m.message?.role || "assistant",
            text:
              typeof m.message?.content === "string" ? m.message.content : "",
            at: m._creationTime,
            via: command?.via || "Q",
            ...(command?.contextTask ? { context: command.contextTask } : {}),
            ...(command?.replyId === m._id && command.answerStatus
              ? { answerStatus: command.answerStatus }
              : {}),
          };
        }),
      });
    }
    return { tasks, events, conversations };
  },
});
export const thread = query({
  args: { secret: v.string(), key: v.string() },
  returns: v.union(v.null(), schema.doc("agentSlackThreads")),
  handler: async (ctx, a) => {
    authorize(a.secret);
    return ctx.db
      .query("agentSlackThreads")
      .withIndex("by_key", (q) => q.eq("key", a.key))
      .unique();
  },
});
export const post = mutation({
  args: {
    secret: v.string(),
    appId: v.string(),
    agent: agentId,
    actor,
    key: v.string(),
    text: v.string(),
    via: v.string(),
    taskId: v.optional(v.id("agentTasks")),
    issueId: v.optional(v.id("issues")),
    action: v.optional(commandAction),
    growthAction: v.optional(
      v.union(v.literal("discover"), v.literal("qualify"), v.literal("draft")),
    ),
    campaignId: v.optional(v.id("growthCampaigns")),
    growthRevision: v.optional(v.boolean()),
    opportunityId: v.optional(v.id("growthOpportunities")),
    release: v.optional(v.string()),
    repository: v.optional(v.string()),
    threadKey: v.optional(v.string()),
    queueAnswer: v.optional(v.boolean()),
  },
  returns: v.object({
    response: v.string(),
    duplicate: v.boolean(),
    taskId: v.union(v.null(), v.id("agentTasks")),
  }),
  handler: async (
    ctx,
    a,
  ): Promise<{
    response: string;
    duplicate: boolean;
    taskId: Id<"agentTasks"> | null;
  }> => {
    authorize(a.secret);
    if (
      !a.text.trim() ||
      a.text.length > 4000 ||
      a.key.length > 200 ||
      a.via.length > 150
    )
      throw new ConvexError("Invalid instruction");
    const old = await ctx.db
      .query("agentCommands")
      .withIndex("by_key", (q) => q.eq("key", a.key))
      .unique();
    const requestContext = JSON.stringify({
      taskId: a.taskId || null,
      issueId: a.issueId || null,
      action: a.action || null,
      repository: a.repository || null,
      growthAction: a.growthAction || null,
      growthRevision: a.growthRevision || false,
      campaignId: a.campaignId || null,
      opportunityId: a.opportunityId || null,
    });
    if (old) {
      const c = await ctx.db.get("agentConversations", old.conversationId);
      if (
        c?.appId !== a.appId ||
        c.agent !== a.agent ||
        c.participant !== a.actor.id ||
        old.promptText !== a.text ||
        (old.requestContext && old.requestContext !== requestContext) ||
        (!old.requestContext &&
          (old.contextTask || null) !== (a.taskId || null))
      )
        throw new ConvexError(
          "Command belongs to another context or content version",
        );
      return {
        response: old.response,
        duplicate: true,
        taskId: old.taskId || null,
      };
    }
    let task = a.taskId ? await ctx.db.get("agentTasks", a.taskId) : null;
    if (a.taskId && (!task || task.appId !== a.appId || task.agent !== a.agent))
      throw new ConvexError("Task context rejected");
    const issue = a.issueId ? await ctx.db.get("issues", a.issueId) : null;
    if (a.issueId && (!issue || (issue.appId || "bloom") !== a.appId))
      throw new ConvexError("Issue belongs to another app");
    let response: string;
    if (a.growthAction) {
      if (a.agent !== "growth" || !a.campaignId || !a.release)
        throw new ConvexError("Growth action context missing");
      const id = await ctx.runMutation(api.growth.request, {
        secret: a.secret,
        actor: a.actor,
        appId: a.appId,
        action: a.growthAction,
        revision: a.growthRevision,
        campaignId: a.campaignId,
        opportunityId: a.opportunityId,
        release: a.release,
        automatic: true,
      });
      task = await ctx.db.get("agentTasks", id);
      response = `Growth work saved: ${id} · ${task!.state}. No public message sent.\n${ref(task!)}`;
    } else if (a.action) {
      const permitted =
        a.action === "collect"
          ? a.agent === "x" &&
            ["owner", "support", "engineering"].includes(a.actor.role)
          : a.agent === "engineering" &&
            ["owner", "engineering"].includes(a.actor.role);
      if (!permitted)
        response =
          "Your saved role cannot request this action. No work queued.";
      else if (a.action !== "collect" && !issue)
        response =
          "Select an issue or supply its exact issue ID. No work queued.";
      else {
        const key = `${a.appId}:${a.agent}:${a.action}:${issue?._id || "collector"}`;
        const previous = await ctx.db
          .query("agentTasks")
          .withIndex("by_key", (q) => q.eq("key", key))
          .order("desc")
          .take(20);
        task = null;
        for (const candidate of previous) {
          const view = await taskView(ctx, candidate);
          if (
            a.action === "collect"
              ? active.includes(view.state)
              : !["failed", "canceled"].includes(view.state)
          ) {
            task = candidate;
            break;
          }
        }
        if (!task) {
          let runId: Id<"runs"> | undefined;
          let blocker: string | undefined;
          if (issue) {
            const existing = await ctx.db
              .query("runs")
              .withIndex("by_issueId_and_createdAt", (q) =>
                q.eq("issueId", issue._id),
              )
              .order("desc")
              .first();
            if (
              existing &&
              ["running", "awaiting_approval", "approved", "resolved"].includes(
                existing.status,
              )
            )
              runId = existing._id;
            else if (
              a.action === "delegate" &&
              (!issue.specApprovedAt ||
                !issue.spec ||
                issue.status !== "approved" ||
                !a.repository)
            )
              blocker =
                "Current Product-approved specification and app repository policy required.";
            else if (
              a.action === "investigate" &&
              issue.fingerprint !== "bloom:upload:413"
            )
              blocker =
                "Generic bug execution is unsupported. Use scoped investigation policy.";
            else {
              runId =
                a.action === "delegate"
                  ? await ctx.runMutation(api.cue.startFeature, {
                      secret: a.secret,
                      issueId: issue._id,
                      expectedSpec: issue.spec!,
                      targetId: a.appId,
                      repository: a.repository!,
                    })
                  : await ctx.runMutation(api.cue.startRun, {
                      secret: a.secret,
                      issueId: issue._id,
                    });
            }
          }
          const taskId = await ctx.db.insert("agentTasks", {
            appId: a.appId,
            agent: a.agent,
            action: a.action,
            key,
            title: issue?.title || "Collect X mentions",
            state: blocker ? "blocked" : "queued",
            stage: blocker ? "Eligibility" : "Waiting for worker",
            ...(issue ? { issueId: issue._id } : {}),
            ...(runId ? { runId } : {}),
            ...(blocker ? { blocker } : {}),
            attempts: 0,
            cancel: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          await event(
            ctx,
            taskId,
            a.actor.name,
            blocker ? "pending" : "pending",
            blocker ||
              "Instruction accepted. Durable work queued; no completion claimed.",
            runId,
          );
          if (a.action === "collect") {
            const workId = await pool.enqueueAction(
              ctx,
              internal.hosted.workspace,
              { taskId },
              { onComplete: internal.workspace.completed, context: { taskId } },
            );
            await ctx.db.patch("agentTasks", taskId, { workId });
          }
          task = (await ctx.db.get("agentTasks", taskId))!;
        }
        const view = await taskView(ctx, task);
        response = `${task._id}: ${view.state} · ${view.stage}. ${view.blocker || "Existing work attached; one implementation per issue."}\n${ref(task)}`;
      }
    } else if (/\b(approve|lgtm|looks good|publish|ship it)\b/i.test(a.text)) {
      response =
        "Use exact-version review controls. Conversation text cannot approve or publish anything.";
    } else if (issue) {
      const run = await ctx.db
        .query("runs")
        .withIndex("by_issueId_and_createdAt", (q) =>
          q.eq("issueId", issue._id),
        )
        .order("desc")
        .first();
      response =
        `${issue._id}: ${issue.status}. ${run ? `Run ${run._id}: ${run.status} · ${run.phase}.` : "No implementation run exists."}` +
        (run?.commit ? `\nCommit: ${run.commit}` : "") +
        (run?.prUrl ? `\nPR: ${run.prUrl}` : "") +
        (run?.releaseEvidence
          ? `\nRelease evidence: ${run.releaseEvidence}`
          : "\nNo deployed release evidence recorded for this run.");
    } else {
      const tasks = task
        ? [task]
        : await ctx.db
            .query("agentTasks")
            .withIndex("by_appId", (q) => q.eq("appId", a.appId))
            .order("desc")
            .take(30);
      const relevant = tasks.filter((t) => t.agent === a.agent).slice(0, 8);
      response = relevant.length
        ? (
            await Promise.all(
              relevant.map(async (t) => {
                const v = await taskView(ctx, t);
                return `${t._id}: ${v.state} · ${v.stage}. ${v.blocker || ""}\n${ref(t)}`;
              }),
            )
          ).join("\n\n")
        : a.agent === "reddit"
          ? "Reddit supports notification intake and supplied-source capture. General API discovery is unavailable. No agent tasks recorded."
          : a.agent === "growth"
            ? "No Growth tasks recorded. Only current deployed capabilities can support recommendations. PDF export remains unsupported."
            : "No agent tasks recorded in this app. Select an existing issue to inspect its execution evidence.";
    }
    let conversation = await ctx.db
      .query("agentConversations")
      .withIndex("by_appId_and_agent_and_participant", (q) =>
        q
          .eq("appId", a.appId)
          .eq("agent", a.agent)
          .eq("participant", a.actor.id),
      )
      .unique();
    if (!conversation) {
      const threadId = await createThread(ctx, components.agent, {
        userId: a.actor.id,
        title: `${a.agent} · ${a.appId}`,
      });
      const id = await ctx.db.insert("agentConversations", {
        appId: a.appId,
        agent: a.agent,
        participant: a.actor.id,
        threadId,
        createdAt: Date.now(),
      });
      conversation = (await ctx.db.get("agentConversations", id))!;
    }
    const saved = await saveMessages(ctx, components.agent, {
      threadId: conversation.threadId,
      userId: a.actor.id,
      agentName: a.agent,
      messages: [
        { role: "user", content: a.text },
        { role: "assistant", content: response },
      ],
    });
    const commandId = await ctx.db.insert("agentCommands", {
      key: a.key,
      promptText: a.text,
      requestContext,
      conversationId: conversation._id,
      actor: a.actor.name,
      via: a.via,
      ...(task ? { taskId: task._id } : {}),
      ...(a.taskId ? { contextTask: a.taskId } : {}),
      promptId: saved.messages[0]._id,
      replyId: saved.messages[1]._id,
      response,
      createdAt: Date.now(),
      ...(a.queueAnswer && !a.action && !a.growthAction
        ? { answerStatus: "queued" as const }
        : {}),
    });
    if (a.queueAnswer && !a.action && !a.growthAction)
      await pool.enqueueAction(
        ctx,
        internal.hosted.workspaceAnswer,
        { commandId },
        {
          onComplete: internal.workspaceAnswers.completed,
          context: { commandId },
        },
      );
    if (a.threadKey) {
      const old = await ctx.db
        .query("agentSlackThreads")
        .withIndex("by_key", (q) => q.eq("key", a.threadKey!))
        .unique();
      const data = {
        key: a.threadKey,
        appId: a.appId,
        agent: a.agent,
        participant: a.actor.id,
        ...(task ? { taskId: task._id } : {}),
      };
      if (old) await ctx.db.replace("agentSlackThreads", old._id, data);
      else await ctx.db.insert("agentSlackThreads", data);
    }
    return { response, duplicate: false, taskId: task?._id || null };
  },
});
export const begin = mutation({
  args: { secret: v.string(), taskId: v.id("agentTasks"), token: v.string() },
  returns: v.union(v.null(), schema.doc("agentTasks")),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const t = await ctx.db.get("agentTasks", a.taskId);
    if (
      !t ||
      t.agent !== "x" ||
      t.action !== "collect" ||
      t.cancel ||
      ["completed", "canceled", "failed"].includes(t.state)
    )
      return null;
    if (t.leaseUntil && t.leaseUntil > Date.now())
      throw new ConvexError("Task already leased");
    const patch = {
      state: "running" as const,
      stage: "Official X collection",
      leaseToken: a.token,
      leaseUntil: Date.now() + 60000,
      attempts: t.attempts + 1,
      updatedAt: Date.now(),
    };
    await ctx.db.patch("agentTasks", t._id, patch);
    await event(
      ctx,
      t._id,
      "X",
      "started",
      `Attempt ${patch.attempts} started from shared checkpoint.`,
    );
    return { ...t, ...patch };
  },
});
export const finish = mutation({
  args: {
    secret: v.string(),
    taskId: v.id("agentTasks"),
    token: v.string(),
    ok: v.boolean(),
    detail: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const t = await ctx.db.get("agentTasks", a.taskId);
    if (
      !t ||
      t.leaseToken !== a.token ||
      !["running", "canceling"].includes(t.state)
    )
      return null;
    await ctx.db.patch("agentTasks", t._id, {
      state: t.cancel ? "canceled" : a.ok ? "completed" : "retrying",
      stage: a.ok ? "Collection checked" : "Provider retry",
      blocker: a.ok ? undefined : a.detail,
      leaseUntil: 0,
      updatedAt: Date.now(),
    });
    await event(
      ctx,
      t._id,
      "X",
      a.ok ? "completed" : "failed",
      a.detail.slice(0, 1000),
    );
    return null;
  },
});
export const completed = internalMutation({
  args: vOnCompleteArgs(v.object({ taskId: v.id("agentTasks") }), v.null()),
  returns: v.null(),
  handler: async (ctx, a) => {
    const t = await ctx.db.get("agentTasks", a.context.taskId);
    if (
      !t ||
      t.workId !== a.workId ||
      a.result.kind === "success" ||
      ["completed", "canceled"].includes(t.state)
    )
      return null;
    await ctx.db.patch("agentTasks", t._id, {
      state: t.cancel ? "canceled" : "failed",
      stage: "Attempts exhausted",
      blocker:
        "Provider attempts exhausted. Review connection and retry explicitly.",
      leaseUntil: 0,
      updatedAt: Date.now(),
    });
    await event(
      ctx,
      t._id,
      "Coordinator",
      "failed",
      "Bounded attempts exhausted; saved instruction and evidence retained.",
    );
    return null;
  },
});
export const cancel = mutation({
  args: {
    secret: v.string(),
    appId: v.string(),
    taskId: v.id("agentTasks"),
    actor,
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const t = await ctx.db.get("agentTasks", a.taskId);
    if (
      !t ||
      t.appId !== a.appId ||
      !(
        a.actor.role === "owner" ||
        (a.actor.role === "engineering" && t.agent === "engineering") ||
        (a.actor.role === "product" && t.agent === "growth") ||
        (a.actor.role === "support" && t.agent === "x")
      )
    )
      throw new ConvexError("Cancellation not authorized");
    if (["completed", "canceled"].includes(t.state))
      throw new ConvexError("Task already ended");
    if (t.runId)
      await ctx.runMutation(api.jobs.cancel, {
        secret: a.secret,
        runId: t.runId,
      });
    await ctx.db.patch("agentTasks", t._id, {
      cancel: true,
      state: t.state === "running" ? "canceling" : "canceled",
      updatedAt: Date.now(),
    });
    const children = await ctx.db
      .query("agentTasks")
      .withIndex("by_appId", (q) => q.eq("appId", a.appId))
      .order("desc")
      .take(100);
    for (const child of children.filter(
      (c) =>
        c.parentId === t._id && !["completed", "canceled"].includes(c.state),
    ))
      await ctx.db.patch("agentTasks", child._id, {
        cancel: true,
        state: child.state === "running" ? "canceling" : "canceled",
        updatedAt: Date.now(),
      });
    await event(
      ctx,
      t._id,
      a.actor.name,
      "pending",
      "Cancellation requested. Already completed external effects remain recorded.",
    );
    return null;
  },
});
export const retry = mutation({
  args: {
    secret: v.string(),
    actor,
    appId: v.string(),
    taskId: v.id("agentTasks"),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const t = await ctx.db.get("agentTasks", a.taskId);
    if (
      !t ||
      t.appId !== a.appId ||
      t.agent !== "x" ||
      t.action !== "collect" ||
      !["owner", "support", "engineering"].includes(a.actor.role)
    )
      throw new ConvexError(
        "Retry this supported task through its original action",
      );
    if (
      !["failed", "canceled", "retrying"].includes(t.state) ||
      (t.leaseUntil || 0) > Date.now()
    )
      throw new ConvexError("Task not eligible for retry");
    await ctx.db.patch("agentTasks", t._id, {
      state: "queued",
      stage: "Explicit retry queued",
      blocker: undefined,
      cancel: false,
      leaseToken: undefined,
      leaseUntil: undefined,
      updatedAt: Date.now(),
    });
    const workId = await pool.enqueueAction(
      ctx,
      internal.hosted.workspace,
      { taskId: t._id },
      { onComplete: internal.workspace.completed, context: { taskId: t._id } },
    );
    await ctx.db.patch("agentTasks", t._id, { workId });
    await event(
      ctx,
      t._id,
      a.actor.name,
      "pending",
      "Explicit bounded retry queued. Existing collector checkpoint retained.",
    );
    return null;
  },
});
