import { v, ConvexError } from "convex/values";
import { mutation, internalMutation, env } from "./_generated/server";
import schema from "./schema";
import { api } from "./_generated/api";
import { authorize } from "./cue";
import type { Id } from "./_generated/dataModel";
import { actor } from "./workspaceValidators";
import { journey, transition } from "./growthTasks";
import { growthAgent } from "./growth";
export const begin = mutation({
  args: {
    secret: v.string(),
    receiptId: v.id("growthReceipts"),
    token: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const r = await ctx.db.get("growthReceipts", a.receiptId);
    if (!r || r.status !== "queued" || (r.leaseUntil || 0) > Date.now())
      return false;
    const t = await ctx.db.get("agentTasks", r.taskId);
    if (t?.cancel) return false;
    await ctx.db.patch("growthReceipts", r._id, {
      leaseToken: a.token,
      leaseUntil: Date.now() + 90000,
    });
    await ctx.db.patch("agentTasks", r.taskId, {
      state: "running",
      stage: r.action,
      attempts: (t?.attempts || 0) + 1,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("agentTaskEvents", {
      taskId: r.taskId,
      actor: "Growth",
      kind: "started",
      text: `${r.action} started with bounded lease.`,
      createdAt: Date.now(),
    });
    return true;
  },
});
export const finish = mutation({
  args: {
    secret: v.string(),
    receiptId: v.id("growthReceipts"),
    token: v.string(),
    ok: v.boolean(),
    detail: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const r = await ctx.db.get("growthReceipts", a.receiptId);
    if (!r || r.leaseToken !== a.token || r.status !== "queued") return null;
    const t = await ctx.db.get("agentTasks", r.taskId);
    await ctx.db.patch("growthReceipts", r._id, {
      status: a.ok || t?.cancel ? "completed" : "queued",
      leaseUntil: undefined,
      leaseToken: undefined,
    });
    await ctx.db.patch("agentTasks", r.taskId, {
      state: t?.cancel ? "canceled" : a.ok ? "completed" : "retrying",
      stage: a.ok ? "Evidence recorded" : "Provider retry pending",
      blocker: a.ok ? undefined : a.detail.slice(0, 500),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("agentTaskEvents", {
      taskId: r.taskId,
      actor: "Growth",
      kind: a.ok ? "completed" : "failed",
      text: a.detail.slice(0, 1200),
      createdAt: Date.now(),
    });
    return null;
  },
});
export const reservePage = mutation({
  args: {
    secret: v.string(),
    campaignId: v.id("growthCampaigns"),
    token: v.string(),
  },
  returns: v.union(v.null(), schema.doc("growthCampaigns")),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const c = await ctx.db.get("growthCampaigns", a.campaignId);
    if (!c) throw new ConvexError("Campaign missing");
    const day = new Date().toISOString().slice(0, 10),
      used = c.budgetDay === day ? c.used : 0;
    if ((c.leaseUntil || 0) > Date.now() || (c.retryAt || 0) > Date.now())
      return null;
    if (used + 10 > c.dailyLimit)
      throw new ConvexError("Daily discovery budget exhausted");
    await ctx.db.patch("growthCampaigns", c._id, {
      leaseToken: a.token,
      leaseUntil: Date.now() + 30000,
      used: used + 10,
      budgetDay: day,
    });
    return { ...c, used: used + 10, budgetDay: day };
  },
});
export const page = mutation({
  args: {
    secret: v.string(),
    campaignId: v.id("growthCampaigns"),
    token: v.string(),
    nextToken: v.optional(v.string()),
    newestId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const c = await ctx.db.get("growthCampaigns", a.campaignId);
    if (!c || c.leaseToken !== a.token) return null;
    const newest = a.newestId || c.pendingSinceId;
    await ctx.db.patch("growthCampaigns", c._id, {
      leaseToken: undefined,
      leaseUntil: undefined,
      ...(a.error
        ? { lastError: a.error.slice(0, 500), retryAt: Date.now() + 300000 }
        : {
            lastError: undefined,
            retryAt: undefined,
            lastRunAt: Date.now(),
            nextToken: a.nextToken,
            pendingSinceId: a.nextToken ? newest : undefined,
            sinceId: a.nextToken ? c.sinceId : newest || c.sinceId,
          }),
    });
    return null;
  },
});
export const pause = mutation({
  args: {
    secret: v.string(),
    actor,
    appId: v.string(),
    campaignId: v.id("growthCampaigns"),
    paused: v.boolean(),
    release: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (!["owner", "product"].includes(a.actor.role))
      throw new ConvexError("Product role required");
    const c = await ctx.db.get("growthCampaigns", a.campaignId);
    if (c?.appId !== a.appId) throw new ConvexError("Campaign app mismatch");
    if (!a.paused) {
      const cap = await ctx.db.get("growthCapabilities", c.capabilityId);
      if (!cap?.valid || cap.release !== a.release)
        throw new ConvexError(
          "Current verified capability required to start Growth",
        );
      // Resume unfinished reasoning without touching reviewed or published work.
      for (const o of await ctx.db
        .query("growthOpportunities")
        .withIndex("by_appId", (q) => q.eq("appId", a.appId))
        .order("desc")
        .take(100)) {
        if (
          o.campaignId !== c._id ||
          !["discovered", "qualified"].includes(o.status)
        )
          continue;
        if ((await journey(ctx, o)).cancel) continue;
        await ctx.runMutation(api.growth.request, {
          secret: a.secret,
          actor: growthAgent,
          appId: a.appId,
          campaignId: c._id,
          opportunityId: o._id,
          release: a.release,
          action: o.status === "discovered" ? "qualify" : "draft",
          automatic: true,
        });
      }
      const day = new Date().toISOString().slice(0, 10);
      const used = c.budgetDay === day ? c.used : 0;
      if (used + 10 <= c.dailyLimit && (c.retryAt || 0) <= Date.now()) {
        await ctx.runMutation(api.growth.request, {
          secret: a.secret,
          actor: growthAgent,
          appId: a.appId,
          campaignId: c._id,
          release: a.release,
          action: "discover",
        });
        await ctx.db.patch("growthCampaigns", c._id, {
          lastScheduledAt: Date.now(),
        });
      }
    }
    await ctx.db.patch("growthCampaigns", c._id, { paused: a.paused });
    return null;
  },
});
export const dismiss = mutation({
  args: {
    secret: v.string(),
    actor,
    appId: v.string(),
    opportunityId: v.id("growthOpportunities"),
    restore: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (!["owner", "product"].includes(a.actor.role))
      throw new ConvexError("Product role required");
    const o = await ctx.db.get("growthOpportunities", a.opportunityId);
    if (o?.appId !== a.appId) throw new ConvexError("Opportunity app mismatch");
    if (!a.restore && ["published", "publication-recorded"].includes(o.status))
      throw new ConvexError("Publication evidence must be retained");
    if (
      a.restore &&
      o.status !== "dismissed" &&
      !(await journey(ctx, o)).cancel
    )
      throw new ConvexError(
        "Only dismissed or canceled recommendations can be restored",
      );
    if (a.restore)
      await ctx.db.patch("agentTasks", (await journey(ctx, o))._id, {
        cancel: false,
      });
    await ctx.db.patch("growthOpportunities", o._id, {
      status: a.restore
        ? o.eligible
          ? "qualified"
          : "discovered"
        : "dismissed",
      updatedAt: Date.now(),
    });
    await transition(
      ctx,
      o._id,
      a.actor.name,
      a.restore ? "blocked" : "completed",
      a.restore ? "Restored for Product review" : "Dismissed",
      a.restore
        ? "Restored. Prior drafts remain evidence; request current qualification or draft."
        : "Product dismissed recommendation. No public action authorized.",
      a.restore ? "Product" : undefined,
    );
    return null;
  },
});
export const commitDraft = mutation({
  args: {
    secret: v.string(),
    receiptId: v.id("growthReceipts"),
    token: v.string(),
    release: v.string(),
    text: v.string(),
    hash: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const r = await ctx.db.get("growthReceipts", a.receiptId);
    if (
      !r ||
      r.status !== "queued" ||
      r.action !== "draft" ||
      !r.opportunityId ||
      r.leaseToken !== a.token ||
      (r.leaseUntil || 0) < Date.now()
    )
      throw new ConvexError("Stale drafting worker");
    const task = await ctx.db.get("agentTasks", r.taskId);
    if (task?.cancel) return null;
    const latest = await ctx.db
      .query("growthDrafts")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", r.opportunityId!),
      )
      .order("desc")
      .first();
    if (latest?._id !== r.baseDraftId)
      throw new ConvexError(
        "Draft edited during generation; saved edit preserved",
      );
    const campaign = await ctx.db.get("growthCampaigns", r.campaignId);
    const cap =
      campaign &&
      (await ctx.db.get("growthCapabilities", campaign.capabilityId));
    if (
      !cap?.valid ||
      cap.release !== a.release ||
      cap.version !== r.capabilityVersion
    )
      throw new ConvexError("Capability changed during drafting");
    const resultDraftId = await ctx.runMutation(api.growth.saveDraft, {
      secret: a.secret,
      actor: r.actor,
      appId: r.appId,
      opportunityId: r.opportunityId,
      release: a.release,
      text: a.text,
      hash: a.hash,
    });
    if (r.automatic)
      await ctx.runMutation(api.growth.requestReview, {
        secret: a.secret,
        actor: r.actor,
        appId: r.appId,
        draftId: resultDraftId,
        hash: a.hash,
        release: a.release,
      });
    await ctx.db.patch("growthReceipts", r._id, {
      status: "completed",
      resultDraftId,
      leaseToken: undefined,
      leaseUntil: undefined,
    });
    await ctx.db.patch("agentTasks", r.taskId, {
      state: "completed",
      stage: r.automatic
        ? "Awaiting exact draft review in Cue"
        : "Draft saved; review required",
      updatedAt: Date.now(),
    });
    await ctx.db.insert("agentTaskEvents", {
      taskId: r.taskId,
      actor: "Growth",
      kind: "completed",
      text: "Exact draft saved. Product review and manual publication remain separate.",
      createdAt: Date.now(),
    });
    return null;
  },
});
export const schedule = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (!env.CUE_BACKGROUND_ORIGIN || !env.CUE_DEMO_SECRET) return null;
    const campaigns = await ctx.db
      .query("growthCampaigns")
      .withIndex("by_paused", (q) => q.eq("paused", false))
      .take(20);
    for (const c of campaigns) {
      const day = new Date().toISOString().slice(0, 10);
      const used = c.budgetDay === day ? c.used : 0;
      if (
        used + 10 > c.dailyLimit ||
        (c.retryAt || 0) > Date.now() ||
        (c.leaseUntil || 0) > Date.now() ||
        (c.lastScheduledAt &&
          new Date(c.lastScheduledAt).toISOString().slice(0, 10) === day) ||
        (c.lastRunAt &&
          new Date(c.lastRunAt).toISOString().slice(0, 10) === day)
      )
        continue;
      const cap = await ctx.db.get("growthCapabilities", c.capabilityId);
      if (!cap?.valid) continue;
      await ctx.db.patch("growthCampaigns", c._id, {
        lastScheduledAt: Date.now(),
      });
      await ctx.runMutation(api.growth.request, {
        secret: env.CUE_DEMO_SECRET,
        actor: growthAgent,
        appId: c.appId,
        campaignId: c._id,
        release: cap.release,
        action: "discover",
      });
    }
    return null;
  },
});
export const feature = mutation({
  args: {
    secret: v.string(),
    actor,
    appId: v.string(),
    opportunityId: v.id("growthOpportunities"),
  },
  returns: v.id("issues"),
  handler: async (ctx, a): Promise<Id<"issues">> => {
    authorize(a.secret);
    if (!["owner", "product"].includes(a.actor.role))
      throw new ConvexError("Product role required");
    const o = await ctx.db.get("growthOpportunities", a.opportunityId);
    if (o?.appId !== a.appId || o.status !== "needs-feature")
      throw new ConvexError("Unsupported need required");
    if (o.featureIssueId) return o.featureIssueId;
    const caseId: Id<"cases"> = await ctx.runMutation(api.cue.createCase, {
      secret: a.secret,
      appId: a.appId,
      title: (o.need || o.text).slice(0, 160),
      body: o.text,
      customer: o.author,
      channel: o.channel,
      sourceUrl: o.sourceUrl,
      sourceKey: "growth-feature:" + o._id,
      feature: true,
      owner: "Product",
      ack: "Feature candidate recorded from explicit source. No feature availability, delivery date or marketing consent is implied.",
    });
    const report = await ctx.db.get("cases", caseId);
    if (!report?.issueId) throw new ConvexError("Feature candidate missing");
    await ctx.db.patch("growthOpportunities", o._id, {
      featureIssueId: report.issueId,
    });
    const task = await ctx.db
      .query("agentTasks")
      .withIndex("by_key", (q) => q.eq("key", "growth-journey:" + o._id))
      .unique();
    if (task)
      await ctx.db.insert("agentTaskEvents", {
        taskId: task._id,
        actor: a.actor.name,
        kind: "pending",
        text: "Handoff to Product: unsupported need becomes a feature candidate; nothing promised.",
        evidence: "#/features/" + report.issueId,
        createdAt: Date.now(),
      });
    return report.issueId;
  },
});
