import schema from "./schema";
import { mutation, query, env } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { uploadRegressionCandidate } from "../lib/symptoms";
import { fallbackReply } from "../lib/reply-policy";
import { internal } from "./_generated/api";

export function authorize(secret: string) {
  if (!env.CUE_DEMO_SECRET || secret !== env.CUE_DEMO_SECRET)
    throw new ConvexError("Unauthorized");
}
const stamp = () => Date.now();

export const snapshot = query({
  args: { secret: v.string() },
  returns: v.object({
    cases: v.array(schema.doc("cases")),
    issues: v.array(schema.doc("issues")),
    messages: v.array(schema.doc("messages")),
    runs: v.array(schema.doc("runs")),
    events: v.array(schema.doc("events")),
    settings: v.array(schema.doc("settings")),
    attachments: v.array(
      schema.doc("attachments").extend({ url: v.union(v.string(), v.null()) }),
    ),
    deliveries: v.array(schema.doc("deliveries")),
  }),
  handler: async (ctx, args) => {
    authorize(args.secret);
    return {
      cases: await ctx.db
        .query("cases")
        .withIndex("by_updatedAt")
        .order("desc")
        .take(100),
      issues: await ctx.db.query("issues").take(100),
      messages: (
        await ctx.db.query("messages").order("desc").take(300)
      ).reverse(),
      runs: await ctx.db.query("runs").order("desc").take(100),
      events: await ctx.db
        .query("events")
        .withIndex("by_createdAt")
        .order("desc")
        .take(200),
      settings: await ctx.db.query("settings").take(20),
      attachments: await Promise.all(
        (await ctx.db.query("attachments").take(100)).map(async (a) => ({
          ...a,
          url: await ctx.storage.getUrl(a.fileId),
        })),
      ),
      deliveries: await ctx.db.query("deliveries").order("desc").take(100),
    };
  },
});

export const seed = mutation({
  args: { secret: v.string(), reset: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    if ((await ctx.db.query("cases").take(1)).length && !args.reset)
      return null;
    if (args.reset) {
      if (
        (await ctx.db.query("runs").take(100)).some(
          (r) => r.status === "running",
        )
      )
        throw new ConvexError(
          "Stop the active investigation before resetting.",
        );
      const issue = await ctx.db
        .query("issues")
        .withIndex("by_fingerprint", (q) =>
          q.eq("fingerprint", "bloom:upload:413"),
        )
        .unique();
      if (!issue) return null;
      for (const run of await ctx.db
        .query("runs")
        .withIndex("by_issueId_and_createdAt", (q) =>
          q.eq("issueId", issue._id),
        )
        .take(100))
        await ctx.db.patch("runs", run._id, {
          status: "archived",
          updatedAt: stamp(),
        });
      await ctx.db.patch("issues", issue._id, { status: "open" });
      for (const c of await ctx.db.query("cases").take(100)) {
        if (c.issueId !== issue._id) continue;
        await ctx.db.patch("cases", c._id, {
          status: "open",
          updatedAt: stamp(),
        });
        await ctx.db.insert("messages", {
          caseId: c._id,
          author: "Cue",
          role: c.channel === "chat" ? "cue" : "draft",
          body: "Demo reset: the original upload bug is active again. Earlier verification belongs to the previous demo run.",
          createdAt: stamp(),
        });
      }
      await ctx.db.insert("events", {
        issueId: issue._id,
        title: "Demo upload scenario reset",
        detail:
          "Previous runs archived. Customer reports, attachments, feature specifications and journal memories preserved.",
        kind: "intake",
        createdAt: stamp(),
      });
      return null;
    }
    const now = stamp();
    const upload = await ctx.db.insert("issues", {
      title: "Photos above 2 MB fail to upload",
      description:
        "Bloom promises 5 MB photo uploads, but the server rejects files larger than 2 MB. Customers report mobile photos and an HTTP 413 response.",
      kind: "bug",
      fingerprint: "bloom:upload:413",
      status: "open",
      priority: "P1",
      tags: ["Uploads", "Android", "Regression"],
      createdAt: now - 18 * 60000,
    });
    const pdf = await ctx.db.insert("issues", {
      title: "Export journals as PDF",
      description:
        "Customers want a printable journal to share with family or keep offline.",
      kind: "feature",
      fingerprint: "bloom:feature:export",
      status: "requested",
      priority: "P3",
      tags: ["Export", "Feature request"],
      createdAt: now - 42 * 60000,
    });
    const dark = await ctx.db.insert("issues", {
      title: "Dark mode",
      description:
        "Comfortable journaling at night, following the system theme.",
      kind: "feature",
      fingerprint: "bloom:feature:dark",
      status: "requested",
      priority: "P3",
      tags: ["Appearance", "Feature request"],
      createdAt: now - 66 * 60000,
    });
    const rows = [
      {
        title: "Every photo from my phone gets rejected",
        customer: "Maya Chen",
        initials: "MC",
        channel: "x",
        body: "@bloomapp I can't upload any photos from my Android. Your app says up to 5 MB but a 3 MB photo fails every time. Please fix this 😭",
        priority: "P1",
        tags: ["Uploads", "Android"],
        issueId: upload,
        status: "open",
        sourceUrl: "https://x.com",
        ago: 4,
      },
      {
        title: "Upload says file too large for a 3 MB photo",
        customer: "Oliver Park",
        initials: "OP",
        channel: "chat",
        body: "Hi! I'm trying to add a 3 MB photo to my journal, but I get 'File too large'. The upload area says files up to 5 MB are supported.",
        priority: "P1",
        tags: ["Uploads"],
        issueId: upload,
        status: "open",
        ago: 12,
      },
      {
        title: "Photo uploads keep returning an error",
        customer: "Aisha Patel",
        initials: "AP",
        channel: "email",
        body: "Small screenshots work but camera photos fail. Chrome DevTools shows 413 on the upload request. I tried a photo around 3 MB.",
        priority: "P1",
        tags: ["Uploads", "Chrome"],
        issueId: upload,
        status: "open",
        ago: 18,
      },
      {
        title: "Could I download my journal as a PDF?",
        customer: "Leo Martin",
        initials: "LM",
        channel: "chat",
        body: "I'd love to print my journal for my parents. Could you add a PDF export that includes photos and dates?",
        priority: "P3",
        tags: ["Export", "Feature request"],
        issueId: pdf,
        status: "requested",
        ago: 42,
      },
      {
        title: "Dark mode would be lovely at night",
        customer: "Sofia Rivera",
        initials: "SR",
        channel: "email",
        body: "I usually write at night. Could you add dark mode or follow my system theme?",
        priority: "P3",
        tags: ["Appearance", "Feature request"],
        issueId: dark,
        status: "requested",
        ago: 66,
      },
    ];
    for (const row of rows) {
      const { ago, ...fields } = row;
      const id = await ctx.db.insert("cases", {
        ...fields,
        provenance: "Seeded demo report",
        createdAt: now - ago * 60000,
        updatedAt: now - ago * 60000,
      });
      await ctx.db.insert("messages", {
        caseId: id,
        author: row.customer,
        role: "customer",
        body: row.body,
        createdAt: now - ago * 60000,
      });
      if (row.issueId === upload)
        await ctx.db.insert("messages", {
          caseId: id,
          author: "Cue",
          role: row.channel === "chat" ? "cue" : "draft",
          body: "Thanks for the details. I've linked this to the photo upload issue. We'll test a 3 MB photo and investigate the server's upload limit.",
          createdAt: now - ago * 60000 + 12000,
        });
    }
    await ctx.db.insert("events", {
      issueId: upload,
      title: "Three reports, one shared issue",
      detail:
        "Seeded X, in-app and email reports linked by upload symptoms and HTTP 413.",
      kind: "intake",
      createdAt: now,
    });
    return null;
  },
});

export const createCase = mutation({
  args: {
    secret: v.string(),
    title: v.string(),
    body: v.string(),
    customer: v.string(),
    channel: v.string(),
    sourceUrl: v.optional(v.string()),
    feature: v.optional(v.boolean()),
    owner: v.optional(v.string()),
    sourceKey: v.optional(v.string()),
    ack: v.optional(v.string()),
    sample: v.optional(v.boolean()),
    appId: v.optional(v.string()),
  },
  returns: v.id("cases"),
  handler: async (ctx, args) => {
    authorize(args.secret);
    if (args.sourceKey) {
      const existing = await ctx.db
        .query("cases")
        .withIndex("by_sourceKey", (q) => q.eq("sourceKey", args.sourceKey))
        .unique();
      if (existing) return existing._id;
    }
    if (
      !args.body.trim() ||
      args.body.length > 12000 ||
      args.customer.length > 100 ||
      args.title.length > 200
    )
      throw new ConvexError("Invalid report");
    const text = `${args.title} ${args.body}`.toLowerCase();
    const upload = uploadRegressionCandidate(text) && !args.feature;
    const feature =
      args.feature || /(?:pdf|dark mode|feature request)/.test(text);
    const group = upload
      ? "bloom:upload:413"
      : feature && /pdf/.test(text)
        ? "bloom:feature:export"
        : feature && /dark mode/.test(text)
          ? "bloom:feature:dark"
          : `report:${stamp()}:${args.customer}:${args.body}`;
    const fingerprint = args.appId ? `${args.appId}:${group}` : group;
    let issue = await ctx.db
      .query("issues")
      .withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint))
      .unique();
    if (!issue) {
      const issueId = await ctx.db.insert("issues", {
        title: args.title,
        description: args.body,
        kind: feature ? "feature" : "bug",
        fingerprint,
        appId: args.appId,
        priority: upload ? "P1" : "P2",
        status: feature ? "requested" : "open",
        tags: feature ? ["Feature request"] : ["Needs triage"],
        createdAt: stamp(),
      });
      issue = await ctx.db.get("issues", issueId);
    }
    const latestRun =
      issue?.kind === "bug" && issue.status === "resolved"
        ? await ctx.db
            .query("runs")
            .withIndex("by_issueId_and_createdAt", (q) =>
              q.eq("issueId", issue!._id),
            )
            .order("desc")
            .first()
        : null;
    const initials = args.customer
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((x) => x[0])
      .join("")
      .toUpperCase();
    const id = await ctx.db.insert("cases", {
      title: args.title,
      body: args.body,
      customer: args.customer,
      initials,
      channel: args.channel,
      appId: args.appId,
      sourceUrl: args.sourceUrl,
      owner: args.owner,
      sourceKey: args.sourceKey,
      provenance: args.sample
        ? `Synthetic ${args.channel === "reddit" ? "Reddit" : "X"} sample · operator capture`
        : args.channel === "x"
          ? "Operator-assisted X capture"
          : args.channel === "reddit"
            ? "Operator-assisted Reddit capture"
            : args.appId
              ? "Connected app widget · visitor supplied identity"
              : args.channel === "slack"
                ? "Verified Slack event"
                : args.channel === "email"
                  ? "Verified inbound email"
                  : "Live demo message",
      priority: upload ? "P1" : "P2",
      status: feature ? "requested" : "open",
      tags: upload
        ? ["Uploads"]
        : feature
          ? ["Feature request"]
          : ["Needs triage"],
      issueId: issue!._id,
      createdAt: stamp(),
      updatedAt: stamp(),
    });
    await ctx.db.insert("messages", {
      caseId: id,
      author: args.customer,
      role: "customer",
      body: args.body,
      createdAt: stamp(),
    });
    await ctx.db.insert("messages", {
      caseId: id,
      author: "Cue",
      role: args.channel === "chat" ? "cue" : "draft",
      body:
        args.ack ||
        fallbackReply({
          case: { title: args.title, body: args.body, channel: args.channel },
          issue,
          run: latestRun,
        }),
      createdAt: stamp() + 1,
    });
    await ctx.db.insert("events", {
      issueId: issue!._id,
      title: "New customer report received",
      detail: `${args.customer} via ${args.channel}. ${upload ? "Linked to the shared upload issue." : "Ready for review."}`,
      kind: "intake",
      createdAt: stamp(),
    });
    await ctx.runMutation(internal.triageQueue.enqueue, { caseId: id });
    return id;
  },
});

export const message = mutation({
  args: {
    secret: v.string(),
    caseId: v.id("cases"),
    body: v.string(),
    author: v.string(),
    role: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    if (
      !args.body.trim() ||
      args.body.length > 12000 ||
      !["customer", "staff", "cue", "draft", "note"].includes(args.role)
    )
      throw new ConvexError("Invalid message");
    if (!(await ctx.db.get("cases", args.caseId)))
      throw new ConvexError("Case not found");
    await ctx.db.insert("messages", {
      caseId: args.caseId,
      body: args.body,
      author: args.author,
      role: args.role,
      createdAt: stamp(),
    });
    await ctx.db.patch("cases", args.caseId, { updatedAt: stamp() });
    if (args.role === "customer")
      await ctx.runMutation(internal.triageQueue.enqueue, {
        caseId: args.caseId,
      });
    return null;
  },
});

export const startRun = mutation({
  args: { secret: v.string(), issueId: v.id("issues") },
  returns: v.id("runs"),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const issue = await ctx.db.get("issues", args.issueId);
    if (!issue || issue.fingerprint !== "bloom:upload:413")
      throw new ConvexError(
        "Live coding demo supports the Bloom upload issue.",
      );
    const previous = await ctx.db
      .query("runs")
      .withIndex("by_issueId_and_createdAt", (q) =>
        q.eq("issueId", args.issueId),
      )
      .order("desc")
      .take(1);
    if (
      previous[0] &&
      ["running", "awaiting_approval", "resolved"].includes(previous[0].status)
    )
      throw new ConvexError(
        "An active or completed run already exists. Reset the demo to run again.",
      );
    const runId = await ctx.db.insert("runs", {
      issueId: args.issueId,
      status: "running",
      phase: "reproducing",
      provider: "Codex",
      createdAt: stamp(),
      updatedAt: stamp(),
    });
    await ctx.db.patch("issues", args.issueId, { status: "investigating" });
    await ctx.db.insert("jobs", {
      runId,
      kind: "investigate",
      status: "queued",
      leaseUntil: 0,
      cancel: false,
      createdAt: stamp(),
    });
    return runId;
  },
});

export const startFeature = mutation({
  args: {
    secret: v.string(),
    issueId: v.id("issues"),
    expectedSpec: v.string(),
    targetId: v.string(),
    repository: v.string(),
  },
  returns: v.id("runs"),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const issue = await ctx.db.get("issues", a.issueId);
    if (
      !issue ||
      issue.kind !== "feature" ||
      issue.status !== "approved" ||
      !issue.specApprovedAt ||
      issue.spec !== a.expectedSpec
    )
      throw new ConvexError(
        "Implementation requires the current approved specification",
      );
    if (
      (issue.appId || "bloom") !== a.targetId ||
      !/^[\w.-]+\/[\w.-]+$/.test(a.repository)
    )
      throw new ConvexError("Repository must belong to this connected app");
    const old = await ctx.db
      .query("runs")
      .withIndex("by_issueId_and_createdAt", (q) => q.eq("issueId", a.issueId))
      .order("desc")
      .first();
    if (
      old &&
      ["running", "awaiting_approval", "approved", "resolved"].includes(
        old.status,
      )
    )
      throw new ConvexError(
        "An active or approved implementation already exists",
      );
    const runId = await ctx.db.insert("runs", {
      issueId: issue._id,
      status: "running",
      phase: "preparing",
      provider: "Codex",
      kind: "feature",
      approvedSpec: a.expectedSpec,
      targetId: a.targetId,
      repository: a.repository,
      deploymentMode: "pull_request",
      createdAt: stamp(),
      updatedAt: stamp(),
    });
    await ctx.db.patch("issues", issue._id, { status: "implementing" });
    await ctx.db.insert("jobs", {
      runId,
      kind: "feature",
      status: "queued",
      leaseUntil: 0,
      cancel: false,
      createdAt: stamp(),
    });
    return runId;
  },
});

export const updateRun = mutation({
  args: {
    secret: v.string(),
    runId: v.id("runs"),
    fields: v.object({
      status: v.optional(v.string()),
      phase: v.optional(v.string()),
      rootCause: v.optional(v.string()),
      diff: v.optional(v.string()),
      before: v.optional(v.string()),
      after: v.optional(v.string()),
      prUrl: v.optional(v.string()),
      commit: v.optional(v.string()),
      repoPath: v.optional(v.string()),
      error: v.optional(v.string()),
      deployed: v.optional(v.boolean()),
      verified: v.optional(v.boolean()),
      approval: v.optional(v.string()),
      summary: v.optional(v.string()),
      baseCommit: v.optional(v.string()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const run = await ctx.db.get("runs", args.runId);
    if (!run) throw new ConvexError("Run not found");
    if (run.kind === "feature" && args.fields.status === "resolved")
      throw new ConvexError("Use the repository release verifier for features");
    if (
      [
        "canceled",
        "rejected",
        "resolved",
        "failed",
        "archived",
        "approved",
      ].includes(run.status)
    )
      throw new ConvexError("Run is terminal");
    if (
      args.fields.status === "resolved" &&
      (!args.fields.verified || !args.fields.deployed)
    )
      throw new ConvexError("Deployment verification required");
    await ctx.db.patch("runs", args.runId, {
      ...args.fields,
      updatedAt: stamp(),
    });
    if (args.fields.status === "awaiting_approval")
      await ctx.db.patch("issues", run.issueId, {
        status: "awaiting_approval",
      });
    if (args.fields.status === "failed" || args.fields.status === "canceled")
      await ctx.db.patch("issues", run.issueId, {
        status: run.kind === "feature" ? "approved" : "open",
      });
    if (args.fields.status === "resolved") {
      await ctx.db.patch("issues", run.issueId, { status: "resolved" });
      for (const c of await ctx.db.query("cases").take(100)) {
        if (c.issueId !== run.issueId) continue;
        await ctx.db.patch("cases", c._id, {
          ...(c.channel === "chat" ? { status: "resolved" } : {}),
          updatedAt: stamp(),
        });
        await ctx.db.insert("messages", {
          caseId: c._id,
          author: "Cue",
          role: c.channel === "chat" ? "cue" : "draft",
          body: "The fix for rejected photos between 2 and 5 MB is live and passed our upload tests. Please retry your photo; if it still fails, send the exact error you see.",
          createdAt: stamp(),
        });
      }
    }
    return null;
  },
});

export const event = mutation({
  args: {
    secret: v.string(),
    runId: v.optional(v.id("runs")),
    issueId: v.optional(v.id("issues")),
    title: v.string(),
    detail: v.string(),
    kind: v.string(),
  },
  returns: v.id("events"),
  handler: async (ctx, args) => {
    authorize(args.secret);
    return await ctx.db.insert("events", {
      runId: args.runId,
      issueId: args.issueId,
      title: args.title,
      detail: args.detail,
      kind: args.kind,
      createdAt: stamp(),
    });
  },
});

export const spec = mutation({
  args: {
    secret: v.string(),
    issueId: v.id("issues"),
    spec: v.string(),
    approved: v.optional(v.boolean()),
    actor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const issue = await ctx.db.get("issues", args.issueId);
    if (!issue || issue.kind !== "feature")
      throw new ConvexError("Feature not found");
    let spec;
    try {
      spec = JSON.parse(args.spec);
    } catch {
      throw new ConvexError("Specification must be valid JSON");
    }
    if (
      typeof spec.need !== "string" ||
      typeof spec.specification !== "string" ||
      !spec.specification.trim() ||
      !Array.isArray(spec.acceptanceCriteria) ||
      spec.acceptanceCriteria.length < 2 ||
      spec.acceptanceCriteria.length > 10 ||
      spec.acceptanceCriteria.some(
        (c: unknown) => typeof c !== "string" || !c.trim(),
      ) ||
      args.spec.length > 18000
    )
      throw new ConvexError(
        "Use a specification with two to ten acceptance criteria",
      );
    await ctx.db.patch("issues", args.issueId, {
      spec: args.spec,
      status: args.approved ? "approved" : "spec_ready",
      specApprovedAt: args.approved ? stamp() : undefined,
      specApprovedBy: args.approved
        ? (args.actor?.trim() || "Operator").slice(0, 100)
        : undefined,
    });
    await ctx.db.insert("events", {
      issueId: args.issueId,
      title: args.approved
        ? "Feature specification approved"
        : "Feature specification saved",
      detail: issue.title,
      kind: "approval",
      createdAt: stamp(),
    });
    return null;
  },
});

export const decideSpec = mutation({
  args: {
    secret: v.string(),
    issueId: v.id("issues"),
    expectedSpec: v.string(),
    approve: v.boolean(),
    actor: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const issue = await ctx.db.get("issues", args.issueId);
    if (
      !issue ||
      issue.kind !== "feature" ||
      issue.status !== "spec_ready" ||
      issue.spec !== args.expectedSpec
    )
      throw new ConvexError("Approval must match the pending specification");
    await ctx.db.patch("issues", args.issueId, {
      status: args.approve ? "approved" : "spec_rejected",
      specApprovedAt: args.approve ? stamp() : undefined,
      specApprovedBy: args.approve ? args.actor.slice(0, 100) : undefined,
    });
    await ctx.db.insert("events", {
      issueId: args.issueId,
      title: args.approve
        ? "Feature specification approved"
        : "Feature specification rejected",
      detail: `${args.actor.slice(0, 100)}: ${issue.title}. This decision covers the specification, not implementation or deployment.`,
      kind: args.approve ? "approval" : "failure",
      createdAt: stamp(),
    });
    return null;
  },
});

export const tags = mutation({
  args: {
    secret: v.string(),
    caseId: v.id("cases"),
    tags: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    if (a.tags.length > 12 || a.tags.some((t) => !t.trim() || t.length > 30))
      throw new ConvexError("Use up to 12 tags, each under 30 characters");
    const tags = [
      ...new Map(
        a.tags.map((t) => [t.trim().toLowerCase(), t.trim()]),
      ).values(),
    ];
    await ctx.db.patch("cases", a.caseId, {
      tags,
      updatedAt: stamp(),
    });
    return null;
  },
});
export const link = mutation({
  args: { secret: v.string(), caseId: v.id("cases"), issueId: v.id("issues") },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const report = await ctx.db.get("cases", a.caseId),
      issue = await ctx.db.get("issues", a.issueId);
    if (!issue || !report || issue.appId !== report.appId)
      throw new ConvexError("Issue not found");
    await ctx.db.patch("cases", a.caseId, {
      issueId: a.issueId,
      updatedAt: stamp(),
    });
    return null;
  },
});
export const triage = mutation({
  args: {
    secret: v.string(),
    caseId: v.id("cases"),
    receiptId: v.optional(v.id("triageReceipts")),
    issueId: v.optional(v.id("issues")),
    priority: v.union(v.literal("P1"), v.literal("P2"), v.literal("P3")),
    tags: v.array(v.string()),
    reason: v.string(),
    kind: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const report = await ctx.db.get("cases", a.caseId);
    if (!report) throw new ConvexError("Case not found");
    if (a.receiptId) {
      const receipt = await ctx.db.get("triageReceipts", a.receiptId);
      if (!receipt || receipt.caseId !== report._id)
        throw new ConvexError("Wrong triage receipt");
      if (receipt.status !== "queued") return null;
      const latest = await ctx.db
        .query("messages")
        .withIndex("by_caseId_and_role_and_createdAt", (q) =>
          q.eq("caseId", report._id).eq("role", "customer"),
        )
        .order("desc")
        .first();
      if (latest?._id !== receipt.messageId) {
        await ctx.db.patch("triageReceipts", receipt._id, {
          status: "superseded",
          updatedAt: stamp(),
        });
        return null;
      }
      await ctx.db.patch("triageReceipts", receipt._id, {
        status: "completed",
        updatedAt: stamp(),
      });
    }
    const current = report.issueId
      ? await ctx.db.get("issues", report.issueId)
      : null;
    if (a.tags.length > 6 || a.tags.some((t) => !t.trim() || t.length > 30))
      throw new ConvexError("Invalid tags");
    const suggestion = a.issueId ? await ctx.db.get("issues", a.issueId) : null;
    if (a.issueId && !suggestion) throw new ConvexError("Issue not found");
    if (suggestion && suggestion.appId !== report.appId)
      throw new ConvexError("Cannot link reports across connected apps");
    // A model result may arrive after a human review or an implementation starts.
    // Read the current workflow in this transaction before applying suggestions.
    const workflowStarted =
      current &&
      (current.spec ||
        current.specApprovedAt ||
        current.specApprovedBy ||
        !["open", "requested"].includes(current.status));
    const matched = workflowStarted ? null : suggestion;
    const priority =
      current?.fingerprint === "bloom:upload:413" ? "P1" : a.priority;
    await ctx.db.patch("cases", report._id, {
      issueId: matched?._id || report.issueId,
      priority,
      tags: [...new Set([...report.tags, ...a.tags])].slice(0, 12),
      updatedAt: stamp(),
    });
    if (
      current?.fingerprint.startsWith(
        current.appId ? `${current.appId}:report:` : "report:",
      ) &&
      current.kind !== "feature" &&
      !workflowStarted &&
      !matched &&
      a.kind === "feature"
    )
      await ctx.db.patch("issues", current._id, {
        kind: "feature",
        priority,
        status: "requested",
        tags: a.tags,
      });
    // The old re-triage path reset approved features to requested while leaving
    // the exact spec and approval intact. Restore only that inconsistent state,
    // before any run exists; retain the original reviewer and decision time.
    if (
      current?.kind === "feature" &&
      current.status === "requested" &&
      current.spec &&
      current.specApprovedAt &&
      current.specApprovedBy
    ) {
      const run = await ctx.db
        .query("runs")
        .withIndex("by_issueId_and_createdAt", (q) =>
          q.eq("issueId", current._id),
        )
        .order("desc")
        .first();
      if (!run) {
        await ctx.db.patch("issues", current._id, { status: "approved" });
        await ctx.db.insert("events", {
          issueId: current._id,
          title: "Specification approval status restored",
          detail: `Reconciled a legacy triage reset with the retained approval by ${current.specApprovedBy}. The specification, reviewer and original approval timestamp are unchanged; no new approval or implementation was created.`,
          kind: "intake",
          createdAt: stamp(),
        });
      }
    }
    await ctx.db.insert("messages", {
      caseId: report._id,
      author: "Cue",
      role: "note",
      body:
        "Gemini triage suggestion: " +
        a.reason +
        " Model confidence is not a calibrated probability.",
      createdAt: stamp(),
    });
    await ctx.db.insert("events", {
      issueId: matched?._id || report.issueId,
      title: "Feedback triaged",
      detail: `${report.customer}: ${priority}. ${a.reason} ${matched ? "Grouped with an existing need." : "Existing symptom match preserved or operator review required."}`,
      kind: "intake",
      createdAt: stamp(),
    });
    return null;
  },
});
