import { v, ConvexError } from "convex/values";
import { vOnCompleteArgs } from "@convex-dev/workpool";
import { mutation, query, internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { authorize } from "./cue";
import { actor } from "./workspaceValidators";
import schema from "./schema";
import { pool } from "./triageQueue";
import { journey, transition } from "./growthTasks";
import { sourcePolicy, growthDraftSupported } from "./growthPolicy";
const growthAction = v.union(
  v.literal("discover"),
  v.literal("qualify"),
  v.literal("draft"),
);
const QUALIFICATION_POLICY_VERSION = 3;
export const growthAgent = {
  id: "growth-agent",
  name: "Growth agent",
  role: "product" as const,
};
function permit(role: string, allowed: string[]) {
  if (!allowed.includes(role))
    throw new ConvexError("Saved role cannot perform this Growth action");
}
async function log(
  ctx: MutationCtx,
  taskId: Id<"agentTasks">,
  who: string,
  text: string,
  kind = "completed",
) {
  await ctx.db.insert("agentTaskEvents", {
    taskId,
    actor: who,
    kind,
    text: text.slice(0, 1200),
    createdAt: Date.now(),
  });
}
async function capability(
  ctx: QueryCtx | MutationCtx,
  id: Id<"growthCapabilities">,
  release: string,
) {
  const cap = await ctx.db.get("growthCapabilities", id);
  if (!cap?.valid || cap.release !== release)
    throw new ConvexError(
      "Capability needs current deployed acceptance evidence",
    );
  return cap;
}
export const snapshot = query({
  args: { secret: v.string(), appId: v.string() },
  returns: v.object({
    capabilities: v.array(schema.doc("growthCapabilities")),
    campaigns: v.array(schema.doc("growthCampaigns")),
    opportunities: v.array(schema.doc("growthOpportunities")),
    drafts: v.array(schema.doc("growthDrafts")),
    touches: v.array(schema.doc("growthTouches")),
    browsers: v.array(schema.doc("growthBrowsers")),
    events: v.array(schema.doc("growthEvents")),
    reviewDeliveries: v.array(
      v.object({
        draftId: v.id("growthDrafts"),
        status: v.string(),
        receipt: v.optional(v.string()),
        createdAt: v.number(),
      }),
    ),
  }),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const opportunities = await ctx.db
      .query("growthOpportunities")
      .withIndex("by_appId", (q) => q.eq("appId", a.appId))
      .order("desc")
      .take(100);
    const touches = await ctx.db
      .query("growthTouches")
      .withIndex("by_appId", (q) => q.eq("appId", a.appId))
      .order("desc")
      .take(100);
    const drafts = (
      await Promise.all(
        opportunities.map((o) =>
          ctx.db
            .query("growthDrafts")
            .withIndex("by_opportunityId", (q) => q.eq("opportunityId", o._id))
            .order("desc")
            .take(10),
        ),
      )
    ).flat();
    const reviewDeliveries = (
      await Promise.all(
        opportunities.map(async (o) => {
          const latest = drafts.find((d) => d.opportunityId === o._id);
          if (!latest) return null;
          const r = await ctx.db
            .query("deliveries")
            .withIndex("by_key", (q) =>
              q.eq("key", "growth-review:" + latest._id),
            )
            .unique();
          return r
            ? {
                draftId: latest._id,
                status: r.status,
                receipt: r.receipt,
                createdAt: r.createdAt,
              }
            : null;
        }),
      )
    ).filter((r) => r !== null);
    return {
      reviewDeliveries,
      capabilities: await ctx.db
        .query("growthCapabilities")
        .withIndex("by_appId", (q) => q.eq("appId", a.appId))
        .take(20),
      campaigns: await ctx.db
        .query("growthCampaigns")
        .withIndex("by_appId", (q) => q.eq("appId", a.appId))
        .take(20),
      opportunities,
      drafts,
      touches,
      browsers: await ctx.db
        .query("growthBrowsers")
        .withIndex("by_appId", (q) => q.eq("appId", a.appId))
        .order("desc")
        .take(1000),
      events: await ctx.db
        .query("growthEvents")
        .withIndex("by_appId", (q) => q.eq("appId", a.appId))
        .order("desc")
        .take(1000),
    };
  },
});
export const verifyCapability = mutation({
  args: {
    secret: v.string(),
    actor,
    appId: v.string(),
    release: v.string(),
    name: v.string(),
    need: v.string(),
    claims: v.array(v.string()),
    evidence: v.string(),
  },
  returns: v.id("growthCapabilities"),
  handler: async (ctx, a) => {
    authorize(a.secret);
    permit(a.actor.role, ["owner", "engineering"]);
    if (
      !/^[a-f0-9]{40}$/.test(a.release) ||
      a.evidence.length > 12000 ||
      !a.name.trim() ||
      a.name.length > 200 ||
      !a.need.trim() ||
      a.need.length > 500 ||
      a.claims.length === 0 ||
      a.claims.length > 8 ||
      a.claims.some((c) => c.length > 300)
    )
      throw new ConvexError("Invalid capability evidence");
    const evidence = JSON.parse(a.evidence);
    if (
      evidence.appId !== a.appId ||
      evidence.release !== a.release ||
      evidence.passed !== true ||
      !Array.isArray(evidence.checks) ||
      evidence.checks.length < 3 ||
      typeof evidence.origin !== "string" ||
      !evidence.origin.startsWith("https://")
    )
      throw new ConvexError(
        "Acceptance evidence must match deployed app and release",
      );
    const old = (
      await ctx.db
        .query("growthCapabilities")
        .withIndex("by_appId", (q) => q.eq("appId", a.appId))
        .take(20)
    ).find((c) => c.name === a.name);
    if (old?.release === a.release && old.evidence === a.evidence && old.valid)
      return old._id;
    const data = {
      appId: a.appId,
      name: a.name,
      need: a.need,
      claims: a.claims,
      release: a.release,
      evidence: a.evidence,
      version: old ? old.version + 1 : 1,
      valid: true,
      checkedAt: Date.now(),
      verifiedBy: a.actor.id,
    };
    if (old) {
      await ctx.db.replace("growthCapabilities", old._id, data);
      return old._id;
    }
    return ctx.db.insert("growthCapabilities", data);
  },
});
export const observeRelease = mutation({
  args: { secret: v.string(), appId: v.string(), release: v.string() },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    for (const c of await ctx.db
      .query("growthCapabilities")
      .withIndex("by_appId", (q) => q.eq("appId", a.appId))
      .take(20))
      if (c.release !== a.release && c.valid)
        await ctx.db.patch("growthCapabilities", c._id, { valid: false });
    return null;
  },
});
export const createCampaign = mutation({
  args: {
    secret: v.string(),
    actor,
    appId: v.string(),
    capabilityId: v.id("growthCapabilities"),
    release: v.string(),
    query: v.string(),
  },
  returns: v.id("growthCampaigns"),
  handler: async (ctx, a) => {
    authorize(a.secret);
    permit(a.actor.role, ["owner", "product"]);
    const cap = await capability(ctx, a.capabilityId, a.release);
    if (cap.appId !== a.appId || !a.query.trim() || a.query.length > 500)
      throw new ConvexError("Campaign app or query rejected");
    const old = (
      await ctx.db
        .query("growthCampaigns")
        .withIndex("by_appId", (q) => q.eq("appId", a.appId))
        .take(20)
    ).find((c) => c.capabilityId === cap._id);
    if (old) return old._id;
    return ctx.db.insert("growthCampaigns", {
      appId: a.appId,
      capabilityId: cap._id,
      name: "Find older memories by caption",
      query: a.query,
      paused: true,
      dailyLimit: 20,
      used: 0,
      budgetDay: new Date().toISOString().slice(0, 10),
    });
  },
});
export const updateQuery = mutation({
  args: {
    secret: v.string(),
    actor,
    appId: v.string(),
    campaignId: v.id("growthCampaigns"),
    release: v.string(),
    query: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    permit(a.actor.role, ["owner", "product"]);
    const c = await ctx.db.get("growthCampaigns", a.campaignId);
    const query = a.query.trim();
    if (c?.appId !== a.appId)
      throw new ConvexError("Campaign belongs to another app");
    await capability(ctx, c.capabilityId, a.release);
    if (
      !query ||
      query.length > 500 ||
      [...query].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new ConvexError("Use a single discovery query of 1–500 characters");
    if (query === c.query) return null;
    const pending = await ctx.db
      .query("growthReceipts")
      .withIndex("by_key", (q) => q.eq("key", `${a.appId}:discover:${c._id}`))
      .order("desc")
      .first();
    if ((c.leaseUntil || 0) > Date.now() || pending?.status === "queued")
      throw new ConvexError(
        "Wait for current discovery work before changing its query",
      );
    // A provider cursor belongs to one query. Keep spend, cooldown and all
    // previously captured evidence; pause scheduling until explicitly enabled.
    await ctx.db.patch("growthCampaigns", c._id, {
      query,
      paused: true,
      sinceId: undefined,
      nextToken: undefined,
      pendingSinceId: undefined,
      lastRunAt: undefined,
    });
    return null;
  },
});
export const capture = mutation({
  args: {
    secret: v.string(),
    appId: v.string(),
    campaignId: v.id("growthCampaigns"),
    sourceKey: v.string(),
    sourceUrl: v.string(),
    channel: v.union(v.literal("x"), v.literal("reddit")),
    author: v.string(),
    text: v.string(),
    sourceAt: v.number(),
    provenance: v.string(),
    controlled: v.boolean(),
    automatic: v.optional(v.boolean()),
  },
  returns: v.id("growthOpportunities"),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const campaign = await ctx.db.get("growthCampaigns", a.campaignId);
    if (
      campaign?.appId !== a.appId ||
      a.text.length > 12000 ||
      !a.text.trim() ||
      a.author.length > 100 ||
      !a.sourceUrl.startsWith("https://")
    )
      throw new ConvexError("Source context rejected");
    const old = await ctx.db
      .query("growthOpportunities")
      .withIndex("by_appId_and_sourceKey", (q) =>
        q.eq("appId", a.appId).eq("sourceKey", a.sourceKey),
      )
      .unique();
    const { secret: _secret, automatic: _automatic, ...data } = a;
    void _secret;
    void _automatic;
    const id =
      old?._id ||
      (await ctx.db.insert("growthOpportunities", {
        ...data,
        eligible: false,
        reasons: [],
        status: "discovered",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));
    const opportunity = (await ctx.db.get("growthOpportunities", id))!;
    const task = await journey(ctx, opportunity);
    const cap = await ctx.db.get("growthCapabilities", campaign.capabilityId);
    if (
      a.automatic !== false &&
      opportunity.status === "discovered" &&
      !task.cancel &&
      cap?.valid
    )
      await ctx.runMutation(api.growth.request, {
        secret: a.secret,
        actor: growthAgent,
        appId: a.appId,
        campaignId: campaign._id,
        opportunityId: id,
        release: cap.release,
        action: "qualify",
        automatic: true,
      });
    return id;
  },
});
export const request = mutation({
  args: {
    secret: v.string(),
    actor,
    appId: v.string(),
    action: growthAction,
    campaignId: v.id("growthCampaigns"),
    opportunityId: v.optional(v.id("growthOpportunities")),
    release: v.string(),
    revision: v.optional(v.boolean()),
    automatic: v.optional(v.boolean()),
  },
  returns: v.id("agentTasks"),
  handler: async (ctx, a): Promise<Id<"agentTasks">> => {
    authorize(a.secret);
    permit(a.actor.role, ["owner", "product"]);
    const campaign = await ctx.db.get("growthCampaigns", a.campaignId);
    if (campaign?.appId !== a.appId)
      throw new ConvexError("Campaign belongs to another app");
    const currentCapability = await capability(
      ctx,
      campaign.capabilityId,
      a.release,
    );
    const o = a.opportunityId
      ? await ctx.db.get("growthOpportunities", a.opportunityId)
      : null;
    if (
      a.action !== "discover" &&
      (!o || o.appId !== a.appId || o.campaignId !== campaign._id)
    )
      throw new ConvexError("Opportunity context rejected");
    if (
      a.action === "draft" &&
      (!o?.eligible ||
        !o.capabilityId ||
        !["qualified", "drafted", "awaiting-review", "approved"].includes(
          o.status,
        ))
    )
      throw new ConvexError(
        "Only eligible needs with verified capabilities can be drafted",
      );
    if (o && (await journey(ctx, o)).cancel)
      throw new ConvexError(
        "Recommendation canceled. Restore through Growth before requesting more work.",
      );
    const key = `${a.appId}:${a.action}:${a.opportunityId || a.campaignId}`;
    const old = await ctx.db
      .query("growthReceipts")
      .withIndex("by_key", (q) => q.eq("key", key))
      .order("desc")
      .first();
    if (old?.status === "queued") {
      if (a.automatic && !old.automatic)
        await ctx.db.patch("growthReceipts", old._id, { automatic: true });
      return old.taskId;
    }
    const latestDraft =
      o &&
      (await ctx.db
        .query("growthDrafts")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", o._id))
        .order("desc")
        .first());
    if (
      !a.revision &&
      old?.status === "completed" &&
      old.capabilityVersion === currentCapability.version &&
      ((a.action === "qualify" &&
        old.qualificationPolicyVersion === QUALIFICATION_POLICY_VERSION) ||
        (a.action === "draft" && latestDraft?._id === old.resultDraftId))
    )
      return old.taskId;
    if (
      a.action === "qualify" &&
      o &&
      !["discovered", "qualified", "needs-feature", "dismissed"].includes(
        o.status,
      )
    )
      throw new ConvexError(
        "Reviewed or published evidence is retained; qualification cannot restart this recommendation",
      );
    const taskId = await ctx.db.insert("agentTasks", {
      appId: a.appId,
      agent: "growth",
      action: a.action,
      campaignId: campaign._id,
      key,
      title: `${a.action} · ${o?.author || campaign.name}`,
      ...(o
        ? {
            opportunityId: o._id,
            parentId: (await journey(ctx, o))._id,
            dependencies: ["Verified capability " + campaign.capabilityId],
          }
        : {}),
      state: "queued",
      stage: "Waiting for reasoning slot",
      attempts: 0,
      cancel: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const receiptId = await ctx.db.insert("growthReceipts", {
      appId: a.appId,
      taskId,
      actor: a.actor,
      action: a.action,
      campaignId: campaign._id,
      ...(o ? { opportunityId: o._id } : {}),
      key,
      capabilityVersion: currentCapability.version,
      automatic: a.automatic ?? a.action === "discover",
      ...(a.action === "qualify"
        ? { qualificationPolicyVersion: QUALIFICATION_POLICY_VERSION }
        : {}),
      status: "queued",
      ...(o
        ? {
            baseDraftId: (
              await ctx.db
                .query("growthDrafts")
                .withIndex("by_opportunityId", (q) =>
                  q.eq("opportunityId", o._id),
                )
                .order("desc")
                .first()
            )?._id,
          }
        : {}),
    });
    const workId = await pool.enqueueAction(
      ctx,
      internal.hosted.growth,
      { receiptId },
      { onComplete: internal.growth.completed, context: { receiptId } },
    );
    await ctx.db.patch("growthReceipts", receiptId, { workId });
    await ctx.db.patch("agentTasks", taskId, { workId });
    await log(
      ctx,
      taskId,
      a.actor.name,
      "Growth instruction saved atomically with bounded workpool receipt.",
      "pending",
    );
    return taskId;
  },
});
export const job = query({
  args: { secret: v.string(), receiptId: v.id("growthReceipts") },
  returns: v.union(
    v.null(),
    v.object({
      receipt: schema.doc("growthReceipts"),
      campaign: schema.doc("growthCampaigns"),
      capability: schema.doc("growthCapabilities"),
      opportunity: v.union(v.null(), schema.doc("growthOpportunities")),
    }),
  ),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const receipt = await ctx.db.get("growthReceipts", a.receiptId);
    if (!receipt) return null;
    const task = await ctx.db.get("agentTasks", receipt.taskId);
    if (task?.cancel) return null;
    const campaign = await ctx.db.get("growthCampaigns", receipt.campaignId);
    const cap =
      campaign &&
      (await ctx.db.get("growthCapabilities", campaign.capabilityId));
    if (!campaign || !cap) return null;
    return {
      receipt,
      campaign,
      capability: cap,
      opportunity: receipt.opportunityId
        ? await ctx.db.get("growthOpportunities", receipt.opportunityId)
        : null,
    };
  },
});
export const qualify = mutation({
  args: {
    secret: v.string(),
    receiptId: v.id("growthReceipts"),
    token: v.string(),
    release: v.string(),
    need: v.string(),
    eligible: v.boolean(),
    fit: v.union(v.literal("High"), v.literal("Medium"), v.literal("Low")),
    reasons: v.array(v.string()),
    matched: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const receipt = await ctx.db.get("growthReceipts", a.receiptId);
    if (
      receipt?.status !== "queued" ||
      !receipt.opportunityId ||
      receipt.leaseToken !== a.token ||
      (receipt.leaseUntil || 0) < Date.now()
    )
      throw new ConvexError("Stale qualification worker");
    const task = await ctx.db.get("agentTasks", receipt.taskId);
    if (task?.cancel) return null;
    const o = await ctx.db.get("growthOpportunities", receipt.opportunityId);
    const campaign = o && (await ctx.db.get("growthCampaigns", o.campaignId));
    if (!o || !campaign) throw new ConvexError("Opportunity missing");
    const cap = await capability(ctx, campaign.capabilityId, a.release);
    if (receipt.capabilityVersion !== cap.version)
      throw new ConvexError("Capability changed during qualification");
    const {
      unsupported,
      explicit,
      promotional,
      matched: sourceMatched,
    } = sourcePolicy(o.text);
    const stale =
      o.sourceAt < Date.now() - 7 * 86400000 ||
      o.sourceAt > Date.now() + 300000;
    const matched =
      a.matched && sourceMatched && !unsupported && !promotional && !stale;
    const eligible = a.eligible && explicit;
    const gateReason = stale
      ? "Historical or invalid source date; outside the current seven-day discovery window"
      : unsupported
        ? "Unsupported need: no verified export, sync or collaboration capability"
        : promotional
          ? "Promotional source; no consumer recommendation is authorized"
          : !explicit
            ? "Source contains no explicit consumer request for a recommendation or help"
            : !sourceMatched
              ? "Source does not ask to find or search photo-journal memories"
              : null;
    await ctx.db.patch("growthOpportunities", o._id, {
      // The deterministic source gate also owns the explanation. Model-supplied
      // fit or need text cannot contradict the gate that rejected eligibility.
      need: (gateReason ? o.text : a.need).slice(0, 500),
      eligible: eligible && matched,
      fit: gateReason ? "Low" : a.fit,
      reasons: gateReason
        ? [gateReason]
        : a.reasons.slice(0, 8).map((r) => r.slice(0, 300)),
      capabilityId: matched ? cap._id : undefined,
      status:
        matched && eligible
          ? "qualified"
          : unsupported && !stale
            ? "needs-feature"
            : "dismissed",
      updatedAt: Date.now(),
    });
    await ctx.db.patch("growthReceipts", receipt._id, { status: "completed" });
    await transition(
      ctx,
      o._id,
      "Growth",
      matched && eligible
        ? receipt.automatic
          ? "running"
          : "blocked"
        : "completed",
      matched && eligible
        ? receipt.automatic
          ? "Preparing reply"
          : "Draft not requested"
        : "Qualification finished",
      matched && eligible
        ? receipt.automatic
          ? "Eligible need matched. Growth is preparing an exact draft for review."
          : "Eligible need matched. Product can request a reviewed draft."
        : "Unmet or ineligible need recorded. No recommendation promised.",
      matched && eligible && !receipt.automatic ? "Product" : undefined,
    );
    await ctx.db.patch("agentTasks", receipt.taskId, {
      state: "completed",
      stage: "Qualification recorded",
      updatedAt: Date.now(),
    });
    await log(
      ctx,
      receipt.taskId,
      "Growth",
      matched
        ? "Qualification recorded from source and verified capability. No public message sent."
        : "Unmet need recorded. Unsupported feature not promised.",
    );
    if (matched && eligible && receipt.automatic)
      await ctx.runMutation(api.growth.request, {
        secret: a.secret,
        actor: receipt.actor,
        appId: o.appId,
        campaignId: campaign._id,
        opportunityId: o._id,
        release: cap.release,
        action: "draft",
        automatic: true,
      });
    return null;
  },
});
export const saveDraft = mutation({
  args: {
    secret: v.string(),
    actor,
    appId: v.string(),
    opportunityId: v.id("growthOpportunities"),
    release: v.string(),
    text: v.string(),
    hash: v.string(),
  },
  returns: v.id("growthDrafts"),
  handler: async (ctx, a) => {
    authorize(a.secret);
    permit(a.actor.role, ["owner", "product"]);
    const o = await ctx.db.get("growthOpportunities", a.opportunityId);
    if (!o || o.appId !== a.appId || !o.eligible || !o.capabilityId)
      throw new ConvexError("Opportunity cannot support a recommendation");
    const cap = await capability(ctx, o.capabilityId, a.release);
    const touch = await ctx.db
      .query("growthTouches")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", o._id))
      .order("desc")
      .first();
    if (!touch || touch.expiresAt < Date.now() || !a.text.includes(touch.link))
      throw new ConvexError(
        "Draft must include its current campaign link before review",
      );
    if (
      !growthDraftSupported(a.text, touch.link) ||
      !/^[a-f0-9]{64}$/.test(a.hash) ||
      a.text !== a.text.trim()
    )
      throw new ConvexError(
        "Draft contains unsupported claims or invalid content",
      );
    const old = await ctx.db
      .query("growthDrafts")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", o._id))
      .order("desc")
      .first();
    if (
      old?.hash === a.hash &&
      old.text === a.text.trim() &&
      old.capabilityVersion === cap.version
    )
      return old._id;
    const id = await ctx.db.insert("growthDrafts", {
      opportunityId: o._id,
      capabilityId: cap._id,
      capabilityVersion: cap.version,
      release: cap.release,
      text: a.text.trim(),
      hash: a.hash,
      version: (old?.version || 0) + 1,
      status: "draft",
      createdAt: Date.now(),
    });
    await ctx.db.patch("growthOpportunities", o._id, {
      status: "drafted",
      updatedAt: Date.now(),
    });
    await transition(
      ctx,
      o._id,
      a.actor.name,
      "blocked",
      "Draft ready; review not requested",
      "Exact draft saved. Request Product review before publication.",
      "Product",
    );
    return id;
  },
});
export const requestReview = mutation({
  args: {
    secret: v.string(),
    actor,
    appId: v.string(),
    draftId: v.id("growthDrafts"),
    hash: v.string(),
    release: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    permit(a.actor.role, ["owner", "product"]);
    const draft = await ctx.db.get("growthDrafts", a.draftId);
    const o =
      draft && (await ctx.db.get("growthOpportunities", draft.opportunityId));
    if (!draft || o?.appId !== a.appId || draft.hash !== a.hash)
      throw new ConvexError("Draft version changed");
    const latest = await ctx.db
      .query("growthDrafts")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", draft.opportunityId),
      )
      .order("desc")
      .first();
    const cap = await capability(ctx, draft.capabilityId, a.release);
    if (
      latest?._id !== draft._id ||
      cap.version !== draft.capabilityVersion ||
      draft.status !== "draft"
    )
      throw new ConvexError("Refresh exact draft and capability version");
    if ((await journey(ctx, o)).cancel)
      throw new ConvexError("Recommendation canceled. Restore first.");
    await ctx.db.patch("growthDrafts", draft._id, {
      status: "requested",
      requestedAt: Date.now(),
    });
    await transition(
      ctx,
      o._id,
      a.actor.name,
      "awaiting",
      "Exact draft review",
      "Product review requested for draft " +
        draft.hash +
        ". Slack delivery is a separate receipt.",
      "Product",
    );
    await ctx.db.patch("growthOpportunities", o._id, {
      status: "awaiting-review",
      updatedAt: Date.now(),
    });
    return null;
  },
});
export const decide = mutation({
  args: {
    secret: v.string(),
    actor,
    appId: v.string(),
    draftId: v.id("growthDrafts"),
    hash: v.string(),
    release: v.string(),
    approve: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    permit(a.actor.role, ["owner", "product"]);
    const draft = await ctx.db.get("growthDrafts", a.draftId);
    const o =
      draft && (await ctx.db.get("growthOpportunities", draft.opportunityId));
    if (
      !draft ||
      o?.appId !== a.appId ||
      draft.status !== "requested" ||
      draft.hash !== a.hash
    )
      throw new ConvexError("Pending exact draft required");
    const latest = await ctx.db
      .query("growthDrafts")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", draft.opportunityId),
      )
      .order("desc")
      .first();
    const cap = await capability(ctx, draft.capabilityId, a.release);
    if (latest?._id !== draft._id || cap.version !== draft.capabilityVersion)
      throw new ConvexError(
        "Draft or capability changed; approval invalidated",
      );
    await ctx.db.patch("growthDrafts", draft._id, {
      status: a.approve ? "approved" : "rejected",
      reviewer: a.actor.id,
      reviewedAt: Date.now(),
    });
    await transition(
      ctx,
      o._id,
      a.actor.name,
      "blocked",
      a.approve ? "Manual publication" : "Changes requested",
      a.approve
        ? "Exact draft approved. Owner must publish manually and record independently verified evidence."
        : "Reviewer requested changes. New text requires a new review.",
      a.approve ? "Owner" : "Product",
    );
    await ctx.db.patch("growthOpportunities", o._id, {
      status: a.approve ? "approved" : "drafted",
      updatedAt: Date.now(),
    });
    return null;
  },
});
export const completed = internalMutation({
  args: vOnCompleteArgs(
    v.object({ receiptId: v.id("growthReceipts") }),
    v.null(),
  ),
  returns: v.null(),
  handler: async (ctx, a) => {
    const receipt = await ctx.db.get("growthReceipts", a.context.receiptId);
    if (!receipt || receipt.workId !== a.workId || receipt.status !== "queued")
      return null;
    const task = await ctx.db.get("agentTasks", receipt.taskId);
    if (a.result.kind === "success" && task?.cancel) {
      await ctx.db.patch("agentTasks", receipt.taskId, {
        state: "canceled",
        updatedAt: Date.now(),
      });
      await ctx.db.patch("growthReceipts", receipt._id, {
        status: "completed",
      });
      return null;
    }
    await ctx.db.patch("growthReceipts", receipt._id, { status: "failed" });
    await ctx.db.patch("agentTasks", receipt.taskId, {
      state: "failed",
      stage: "Attempts exhausted",
      blocker:
        "Growth work ended without completion evidence. Review provider access and retry.",
      updatedAt: Date.now(),
    });
    await log(
      ctx,
      receipt.taskId,
      "Coordinator",
      "Bounded work ended without successful persisted completion.",
      "failed",
    );
    return null;
  },
});
