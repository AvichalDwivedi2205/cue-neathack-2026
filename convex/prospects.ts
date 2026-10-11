import { ConvexError, v } from "convex/values";
import { query, mutation, internalMutation, env } from "./_generated/server";
import { authorize } from "./cue";
import { actor } from "./workspaceValidators";
import { prospectFields, prospectDisposition } from "./prospectSchema";
import schema from "./schema";
const permit = (role: string) => {
  if (!["owner", "product"].includes(role))
    throw new ConvexError("Owner or Product role required");
};
export const snapshot = query({
  args: { secret: v.string() },
  returns: v.object({
    configured: v.boolean(),
    runs: v.array(schema.doc("prospectRuns")),
    companies: v.array(schema.doc("prospectCompanies")),
  }),
  handler: async (ctx, a) => {
    authorize(a.secret);
    return {
      configured: !!env.CRUSTDATA_API_KEY,
      runs: await ctx.db
        .query("prospectRuns")
        .withIndex("by_scope_and_createdAt", (q) => q.eq("scope", "cue"))
        .order("desc")
        .take(10),
      companies: await ctx.db
        .query("prospectCompanies")
        .withIndex("by_scope_and_lastFoundAt", (q) => q.eq("scope", "cue"))
        .order("desc")
        .take(100),
    };
  },
});
export const begin = internalMutation({
  args: {
    key: v.string(),
    query: v.string(),
    limit: v.number(),
    actor,
    reservedCredits: v.number(),
  },
  returns: v.object({ runId: v.id("prospectRuns"), started: v.boolean() }),
  handler: async (ctx, a) => {
    permit(a.actor.role);
    if (
      !/^[a-zA-Z0-9_-]{8,100}$/.test(a.key) ||
      a.query.trim().length < 10 ||
      a.query.length > 400 ||
      !Number.isInteger(a.limit) ||
      a.limit < 1 ||
      a.limit > 5 ||
      !Number.isFinite(a.reservedCredits) ||
      a.reservedCredits < 0 ||
      a.reservedCredits > 15
    )
      throw new ConvexError("Invalid research request");
    const previous = await ctx.db
      .query("prospectRuns")
      .withIndex("by_key", (q) => q.eq("key", a.key))
      .unique();
    if (previous) {
      if (
        previous.query !== a.query ||
        previous.limit !== a.limit ||
        previous.actor !== a.actor.id
      )
        throw new ConvexError("Research key already used for another request");
      return { runId: previous._id, started: false };
    }
    const now = Date.now(),
      dayStart = Math.floor(now / 86400000) * 86400000;
    // Atomic spend reservations: retries/failures retain their allocation.
    const today = await ctx.db
      .query("prospectRuns")
      .withIndex("by_scope_and_createdAt", (q) =>
        q.eq("scope", "cue").gte("createdAt", dayStart),
      )
      .take(6);
    if (today.length >= 5)
      throw new ConvexError(
        "Five research searches reserved today; try again tomorrow",
      );
    if (today.some((r) => r.state === "running" && now - r.createdAt < 120000))
      throw new ConvexError("A company search is already running");
    const runId = await ctx.db.insert("prospectRuns", {
      scope: "cue",
      key: a.key,
      query: a.query,
      limit: a.limit,
      actor: a.actor.id,
      state: "running",
      createdAt: now,
      updatedAt: now,
      reservedCredits: a.reservedCredits,
      usedCredits: null,
      count: 0,
      warning: null,
      traceId: null,
    });
    return { runId, started: true };
  },
});
export const finish = internalMutation({
  args: {
    runId: v.id("prospectRuns"),
    companies: v.array(v.object(prospectFields)),
    usedCredits: v.union(v.number(), v.null()),
    warning: v.union(v.string(), v.null()),
    traceId: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const run = await ctx.db.get("prospectRuns", a.runId);
    if (!run || run.state !== "running")
      throw new ConvexError("Research run is no longer active");
    if (
      a.companies.length > run.limit ||
      new Set(a.companies.map((c) => c.companyId)).size !== a.companies.length
    )
      throw new ConvexError("Research result exceeded its reservation");
    const now = Date.now();
    for (const c of a.companies) {
      if (
        !Number.isSafeInteger(c.companyId) ||
        c.companyId <= 0 ||
        c.name.length > 120 ||
        c.description.length > 1600 ||
        c.domain.length > 253 ||
        c.reasons.length > 8 ||
        c.gaps.length > 8
      )
        throw new ConvexError("Invalid company facts");
      const old = await ctx.db
        .query("prospectCompanies")
        .withIndex("by_scope_and_companyId", (q) =>
          q.eq("scope", "cue").eq("companyId", c.companyId),
        )
        .unique();
      const fields = {
        ...c,
        runId: a.runId,
        query: run.query,
        lastFoundAt: now,
      };
      if (old) await ctx.db.patch("prospectCompanies", old._id, fields);
      else
        await ctx.db.insert("prospectCompanies", {
          ...fields,
          scope: "cue",
          disposition: "candidate",
          firstFoundAt: now,
          reviewedAt: null,
        });
    }
    await ctx.db.patch("prospectRuns", a.runId, {
      state: "completed",
      count: a.companies.length,
      updatedAt: now,
      usedCredits: a.usedCredits,
      warning: a.warning,
      traceId: a.traceId,
    });
    return null;
  },
});
export const fail = internalMutation({
  args: {
    runId: v.id("prospectRuns"),
    message: v.string(),
    traceId: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const run = await ctx.db.get("prospectRuns", a.runId);
    if (run?.state === "running")
      await ctx.db.patch("prospectRuns", a.runId, {
        state: "failed",
        warning: a.message.slice(0, 300),
        traceId: a.traceId,
        updatedAt: Date.now(),
      });
    return null;
  },
});
export const review = mutation({
  args: {
    secret: v.string(),
    actor,
    companyId: v.id("prospectCompanies"),
    disposition: prospectDisposition,
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    permit(a.actor.role);
    const c = await ctx.db.get("prospectCompanies", a.companyId);
    if (!c || c.scope !== "cue") throw new ConvexError("Company unavailable");
    await ctx.db.patch("prospectCompanies", a.companyId, {
      disposition: a.disposition,
      reviewedAt: Date.now(),
    });
    return null;
  },
});
