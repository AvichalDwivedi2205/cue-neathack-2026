import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authorize } from "./cue";
import { actor } from "./workspaceValidators";
import { growthEventType } from "./growthSchema";
import schema from "./schema";
import { transition } from "./growthTasks";
export const prepare = mutation({
  args: {
    secret: v.string(),
    actor,
    appId: v.string(),
    opportunityId: v.id("growthOpportunities"),
    tokenHash: v.string(),
    link: v.string(),
    destination: v.string(),
    expiresAt: v.number(),
  },
  returns: schema.doc("growthTouches"),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (!["owner", "product"].includes(a.actor.role))
      throw new ConvexError("Product role required");
    const o = await ctx.db.get("growthOpportunities", a.opportunityId);
    if (o?.appId !== a.appId || !o.eligible)
      throw new ConvexError("Qualified opportunity required");
    const old = await ctx.db
      .query("growthTouches")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", o._id))
      .order("desc")
      .first();
    if (old && old.expiresAt > Date.now()) return old;
    if (
      !/^[a-f0-9]{64}$/.test(a.tokenHash) ||
      a.expiresAt > Date.now() + 8 * 86400000
    )
      throw new ConvexError("Invalid campaign link");
    const id = await ctx.db.insert("growthTouches", {
      appId: a.appId,
      campaignId: o.campaignId,
      opportunityId: o._id,
      tokenHash: a.tokenHash,
      link: a.link,
      destination: a.destination,
      expiresAt: a.expiresAt,
      status: "unpublished",
      clicks: 0,
      createdAt: Date.now(),
    });
    return (await ctx.db.get("growthTouches", id))!;
  },
});
export const report = mutation({
  args: {
    secret: v.string(),
    actor,
    appId: v.string(),
    draftId: v.id("growthDrafts"),
    hash: v.string(),
    publicationUrl: v.string(),
    release: v.string(),
  },
  returns: schema.doc("growthTouches"),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (a.actor.role !== "owner")
      throw new ConvexError("Owner controls publication");
    const d = await ctx.db.get("growthDrafts", a.draftId);
    const o = d && (await ctx.db.get("growthOpportunities", d.opportunityId));
    const latest =
      o &&
      (await ctx.db
        .query("growthDrafts")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", o._id))
        .order("desc")
        .first());
    const cap = d && (await ctx.db.get("growthCapabilities", d.capabilityId));
    if (
      !d ||
      o?.appId !== a.appId ||
      latest?._id !== d._id ||
      d.status !== "approved" ||
      d.hash !== a.hash ||
      !cap?.valid ||
      cap.release !== a.release ||
      cap.version !== d.capabilityVersion
    )
      throw new ConvexError("Current exact approved draft required");
    const t = await ctx.db
      .query("growthTouches")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", o._id))
      .order("desc")
      .first();
    if (!t || t.expiresAt < Date.now() || !d.text.includes(t.link))
      throw new ConvexError("Approved campaign link expired or changed");
    if (t.status === "verified") {
      if (t.draftId !== d._id || t.publicationUrl !== a.publicationUrl)
        throw new ConvexError("Verified publication cannot be replaced");
      return t;
    }
    await ctx.db.patch("growthTouches", t._id, {
      draftId: d._id,
      draftHash: d.hash,
      publicationUrl: a.publicationUrl,
      status: "reported",
      verification: "Operator reported; independent check pending",
    });
    await ctx.db.patch("growthOpportunities", o._id, {
      status: "publication-recorded",
      updatedAt: Date.now(),
    });
    await transition(
      ctx,
      o._id,
      a.actor.name,
      "running",
      "Independent publication check",
      "Owner reported URL. Official read must verify author, thread, full text and link.",
    );
    return (await ctx.db.get("growthTouches", t._id))!;
  },
});
export const verify = mutation({
  args: {
    secret: v.string(),
    touchId: v.id("growthTouches"),
    hash: v.string(),
    publicationUrl: v.string(),
    ok: v.boolean(),
    method: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const t = await ctx.db.get("growthTouches", a.touchId);
    if (!t || t.draftHash !== a.hash || t.publicationUrl !== a.publicationUrl)
      throw new ConvexError("Publication changed during verification");
    const d = t.draftId && (await ctx.db.get("growthDrafts", t.draftId));
    const latest = await ctx.db
      .query("growthDrafts")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", t.opportunityId),
      )
      .order("desc")
      .first();
    const cap = d && (await ctx.db.get("growthCapabilities", d.capabilityId));
    if (
      !d ||
      d._id !== latest?._id ||
      d.status !== "approved" ||
      d.hash !== a.hash ||
      !cap?.valid ||
      d.capabilityVersion !== cap.version
    )
      throw new ConvexError("Review invalidated while checking");
    await ctx.db.patch("growthTouches", t._id, {
      status: a.ok ? "verified" : "failed",
      verification: a.method.slice(0, 500),
      publishedAt: a.ok ? Date.now() : undefined,
    });
    await ctx.db.patch("growthOpportunities", t.opportunityId, {
      status: a.ok ? "published" : "publication-recorded",
      updatedAt: Date.now(),
    });
    await transition(
      ctx,
      t.opportunityId,
      "Official X read",
      a.ok ? "completed" : "blocked",
      a.ok
        ? "Publication verified; observing outcomes"
        : "Publication not verified",
      a.method,
      a.ok ? undefined : "Owner",
    );
    return null;
  },
});
export const lookup = query({
  args: { secret: v.string(), tokenHash: v.string(), now: v.number() },
  returns: v.union(v.null(), schema.doc("growthTouches")),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const t = await ctx.db
      .query("growthTouches")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", a.tokenHash))
      .unique();
    if (!t || t.status !== "verified" || t.expiresAt < a.now || !t.draftId)
      return null;
    const d = await ctx.db.get("growthDrafts", t.draftId);
    const cap = d && (await ctx.db.get("growthCapabilities", d.capabilityId));
    return cap?.valid &&
      cap.version === d?.capabilityVersion &&
      cap.release === d.release
      ? t
      : null;
  },
});
export const click = mutation({
  args: { secret: v.string(), touchId: v.id("growthTouches") },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const t = await ctx.db.get("growthTouches", a.touchId);
    if (t?.status === "verified" && t.expiresAt > Date.now())
      await ctx.db.patch("growthTouches", t._id, {
        clicks: t.clicks + 1,
        lastClickAt: Date.now(),
      });
    return null;
  },
});
export const ingest = mutation({
  args: {
    secret: v.string(),
    appId: v.string(),
    touchId: v.id("growthTouches"),
    browser: v.string(),
    eventId: v.string(),
    type: growthEventType,
    occurredAt: v.number(),
    internal: v.boolean(),
    returning: v.boolean(),
  },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (
      !/^[a-f0-9]{64}$/.test(a.browser) ||
      a.eventId.length > 200 ||
      a.occurredAt > Date.now() + 60000
    )
      throw new ConvexError("Invalid product event");
    const t = await ctx.db.get("growthTouches", a.touchId);
    if (
      !t ||
      t.appId !== a.appId ||
      t.status !== "verified" ||
      a.occurredAt < t.createdAt ||
      a.occurredAt > t.expiresAt
    )
      throw new ConvexError("Event app or touch rejected");
    const prior = await ctx.db
      .query("growthEvents")
      .withIndex("by_appId_and_eventId", (q) =>
        q.eq("appId", a.appId).eq("eventId", a.eventId),
      )
      .unique();
    if (prior) {
      if (
        prior.touchId !== a.touchId ||
        prior.browser !== a.browser ||
        prior.type !== a.type ||
        prior.occurredAt !== a.occurredAt ||
        prior.internal !== a.internal ||
        prior.returning !== a.returning
      )
        throw new ConvexError("Event ID changed payload");
      return false;
    }
    const b = await ctx.db
      .query("growthBrowsers")
      .withIndex("by_appId_and_browser", (q) =>
        q.eq("appId", a.appId).eq("browser", a.browser),
      )
      .unique();
    if (b && b.touchId !== a.touchId)
      throw new ConvexError("First attribution cannot be replaced");
    const { secret: _secret, ...data } = a;
    void _secret;
    await ctx.db.insert("growthEvents", { ...data, receivedAt: Date.now() });
    const milestones = {
      confirmedAt: b?.confirmedAt,
      savedAt: b?.savedAt,
      activatedAt: b?.activatedAt,
    };
    if (a.type === "session_confirmed")
      milestones.confirmedAt = Math.min(
        milestones.confirmedAt || Infinity,
        a.occurredAt,
      );
    if (a.type === "memory_created")
      milestones.savedAt = Math.min(
        milestones.savedAt || Infinity,
        a.occurredAt,
      );
    if (a.type === "caption_search_match")
      milestones.activatedAt = Math.min(
        milestones.activatedAt || Infinity,
        a.occurredAt,
      );
    const fields = {
      appId: a.appId,
      touchId: a.touchId,
      browser: a.browser,
      internal: a.internal || b?.internal || false,
      returning: a.returning || b?.returning || false,
      ...milestones,
    };
    if (b) await ctx.db.patch("growthBrowsers", b._id, fields);
    else await ctx.db.insert("growthBrowsers", fields);
    const task = await ctx.db
      .query("agentTasks")
      .withIndex("by_key", (q) =>
        q.eq("key", "growth-journey:" + t.opportunityId),
      )
      .unique();
    if (task)
      await ctx.db.insert("agentTaskEvents", {
        taskId: task._id,
        actor: "Bloom",
        kind: "completed",
        text:
          "Trusted " +
          a.type +
          " · " +
          a.eventId +
          (fields.internal ? " · controlled/internal" : "") +
          (fields.returning ? " · returning browser" : ""),
        createdAt: a.occurredAt,
        evidence: "#/growth/" + t.opportunityId,
      });
    return true;
  },
});
