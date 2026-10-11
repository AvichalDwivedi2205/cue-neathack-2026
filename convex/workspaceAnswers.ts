import { listMessages } from "@convex-dev/agent";
import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { mutation, internalMutation } from "./_generated/server";
import { components } from "./_generated/api";
import { authorize } from "./cue";
import { taskView } from "./workspace";
export const begin = mutation({
  args: {
    secret: v.string(),
    commandId: v.id("agentCommands"),
    token: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      prompt: v.string(),
      agent: v.string(),
      appId: v.string(),
      context: v.string(),
    }),
  ),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const cmd = await ctx.db.get("agentCommands", a.commandId);
    if (
      !cmd ||
      cmd.answerStatus !== "queued" ||
      (cmd.answerLeaseUntil || 0) > Date.now()
    )
      return null;
    const convo = await ctx.db.get("agentConversations", cmd.conversationId);
    if (!convo) return null;
    const messages = await listMessages(ctx, components.agent, {
      threadId: convo.threadId,
      paginationOpts: { numItems: 20, cursor: null },
      excludeToolMessages: true,
    });
    const history = messages.page
      .filter((m) => m._creationTime <= cmd.createdAt)
      .reverse()
      .slice(-10)
      .map((m) => ({
        role: m.message?.role,
        text:
          typeof m.message?.content === "string"
            ? m.message.content.slice(0, 1800)
            : "",
      }));
    const task = cmd.contextTask
      ? await ctx.db.get(
          "agentTasks",
          cmd.contextTask as import("./_generated/dataModel").Id<"agentTasks">,
        )
      : null;
    const tasks = task
      ? [task]
      : await ctx.db
          .query("agentTasks")
          .withIndex("by_appId", (q) => q.eq("appId", convo.appId))
          .order("desc")
          .take(20);
    const state = await Promise.all(
      tasks
        .filter((t) => t.appId === convo.appId && t.agent === convo.agent)
        .slice(0, 8)
        .map(async (t) => {
          const view = await taskView(ctx, t);
          const run = "run" in view ? view.run : undefined;
          return {
            id: t._id,
            title: t.title,
            state: view.state,
            stage: view.stage,
            blocker: view.blocker,
            run: run
              ? {
                  commit: run.commit,
                  tests: run.after?.slice(0, 1200),
                  pr: run.prUrl,
                  release: run.releaseEvidence?.slice(0, 1200),
                }
              : undefined,
          };
        }),
    );
    const growth =
      convo.agent === "growth"
        ? {
            capabilities: await ctx.db
              .query("growthCapabilities")
              .withIndex("by_appId", (q) => q.eq("appId", convo.appId))
              .take(10),
            opportunities: await ctx.db
              .query("growthOpportunities")
              .withIndex("by_appId", (q) => q.eq("appId", convo.appId))
              .order("desc")
              .take(10),
            browsers: await ctx.db
              .query("growthBrowsers")
              .withIndex("by_appId", (q) => q.eq("appId", convo.appId))
              .take(100),
          }
        : undefined;
    const growthContext = growth && {
      capabilities: growth.capabilities.map((c) => ({
        id: c._id,
        claims: c.claims,
        valid: c.valid,
        release: c.release,
        evidence: c.evidence,
      })),
      opportunities: await Promise.all(
        growth.opportunities
          .filter((o) => !task?.opportunityId || task.opportunityId === o._id)
          .map(async (o) => {
            const draft = await ctx.db
              .query("growthDrafts")
              .withIndex("by_opportunityId", (q) =>
                q.eq("opportunityId", o._id),
              )
              .order("desc")
              .first();
            const delivery =
              draft &&
              (await ctx.db
                .query("deliveries")
                .withIndex("by_key", (q) =>
                  q.eq("key", "growth-review:" + draft._id),
                )
                .unique());
            const touches = await ctx.db
              .query("growthTouches")
              .withIndex("by_opportunityId", (q) =>
                q.eq("opportunityId", o._id),
              )
              .order("desc")
              .take(3);
            return {
              id: o._id,
              source: o.sourceUrl,
              need: o.need,
              status: o.status,
              reasons: o.reasons,
              controlled: o.controlled,
              draft: draft && {
                id: draft._id,
                text: draft.text,
                status: draft.status,
                hash: draft.hash,
                reviewer: draft.reviewer,
                requestedAt: draft.requestedAt,
                reviewedAt: draft.reviewedAt,
              },
              reviewDelivery: delivery && {
                status: delivery.status,
                receipt: delivery.receipt,
              },
              touches: touches.map((t) => ({
                status: t.status,
                publication: t.publicationUrl,
                evidence: t.verification,
                clicks: t.clicks,
              })),
              browsers: growth.browsers
                .filter((b) => touches.some((t) => t._id === b.touchId))
                .map((b) => ({
                  internal: b.internal,
                  returning: b.returning,
                  confirmedAt: b.confirmedAt,
                  savedAt: b.savedAt,
                  activatedAt: b.activatedAt,
                })),
            };
          }),
      ),
    };
    await ctx.db.patch("agentCommands", cmd._id, {
      answerLease: a.token,
      answerLeaseUntil: Date.now() + 45000,
    });
    return {
      prompt: cmd.promptText,
      agent: convo.agent,
      appId: convo.appId,
      context: JSON.stringify({
        history,
        state,
        growth: growthContext,
        recordedAnswer: cmd.response,
      }),
    };
  },
});
export const finish = mutation({
  args: {
    secret: v.string(),
    commandId: v.id("agentCommands"),
    token: v.string(),
    answer: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const c = await ctx.db.get("agentCommands", a.commandId);
    if (!c || c.answerStatus !== "queued" || c.answerLease !== a.token)
      return null;
    if (!a.answer.trim() || a.answer.length > 4000)
      throw new Error("Invalid bounded answer");
    await ctx.runMutation(components.agent.messages.updateMessage, {
      messageId: c.replyId,
      patch: {
        message: { role: "assistant", content: a.answer },
        provider: "google",
        model: "gemini",
      },
    });
    await ctx.db.patch("agentCommands", c._id, {
      response: a.answer,
      answerStatus: "completed",
      answerLease: undefined,
      answerLeaseUntil: undefined,
    });
    return null;
  },
});
export const completed = internalMutation({
  args: vOnCompleteArgs(
    v.object({ commandId: v.id("agentCommands") }),
    v.null(),
  ),
  returns: v.null(),
  handler: async (ctx, a) => {
    const c = await ctx.db.get("agentCommands", a.context.commandId);
    if (c?.answerStatus === "queued")
      await ctx.db.patch("agentCommands", c._id, {
        answerStatus: "failed",
        answerLease: undefined,
        answerLeaseUntil: undefined,
      });
    return null;
  },
});
