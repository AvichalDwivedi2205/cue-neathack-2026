import { z } from "zod";
import { api, db, secret } from "./server-store";
import { readIntegrations } from "./integration-config";
import {
  sharedWorkerStatus,
  xRuntimeStatus,
  notificationRuntimeStatus,
} from "./integration-checks";
import { geminiReady } from "./gemini";
import type { Role } from "./roles";
import type { Id } from "../convex/_generated/dataModel";
import { ConvexError } from "convex/values";

export const workspaceInput = z
  .object({
    agent: z.enum(["x", "reddit", "growth", "engineering"]),
    appId: z.string().min(1).max(100),
    text: z.string().trim().min(1).max(4000),
    key: z.string().min(8).max(200),
    taskId: z.string().max(100).optional(),
    issueId: z.string().max(100).optional(),
  })
  .strict();
export type WorkspaceActor = { id: string; name: string; role: Role };
export async function workspaceApp(appId?: string) {
  const config = await readIntegrations();
  if (appId === "bloom")
    return {
      app: { id: "bloom", name: "Legacy Bloom", origins: [] as string[] },
      config,
    };
  const app = appId
    ? config.apps.find((a) => a.id === appId)
    : config.apps.find((a) =>
        a.origins.includes(
          process.env.CUE_BLOOM_PUBLIC_URL ||
            "https://bloom-with-cue.vercel.app",
        ),
      );
  if (!app) throw new Error("Choose a registered app");
  return { app, config };
}
export async function postWorkspace(
  input: z.infer<typeof workspaceInput>,
  actor: WorkspaceActor,
  via = "Q",
  threadKey?: string,
) {
  const { config } = await workspaceApp(input.appId);
  const references = new Set(input.text.match(/\b[a-z0-9]{26,40}\b/g) || []);
  const tasks =
    input.taskId || references.size
      ? (
          await db().query(api.workspace.snapshot, {
            secret: secret(),
            appId: input.appId,
            participant: actor.id,
          })
        ).tasks
      : [];
  const matches = tasks.filter(
    (t) => t.agent === input.agent && references.has(t._id),
  );
  const selected = input.taskId
    ? tasks.find((t) => t._id === input.taskId)
    : matches.length === 1
      ? matches[0]
      : null;
  const taskId = input.taskId || selected?._id;
  const words = input.text.toLowerCase();
  let growthCommand:
    | {
        growthAction: "discover" | "qualify" | "draft";
        growthRevision?: boolean;
        campaignId: Id<"growthCampaigns">;
        opportunityId?: Id<"growthOpportunities">;
        release: string;
      }
    | undefined;
  if (
    input.agent === "growth" &&
    /^(?:please\s+)?(?:find|run (?:discovery|search)|qualify|draft|revise|regenerate)\b/.test(
      words,
    )
  ) {
    const { observedRelease } = await import("./growth");
    const { release } = await observedRelease(input.appId);
    const growth = await db().query(api.growth.snapshot, {
      secret: secret(),
      appId: input.appId,
    });
    const opportunity = growth.opportunities.find(
      (o) => o._id === selected?.opportunityId || words.includes(o._id),
    );
    const growthAction = /\bqualify\b/.test(words)
      ? "qualify"
      : /\b(?:draft|revise|regenerate)\b/.test(words)
        ? "draft"
        : "discover";
    const campaign = opportunity
      ? growth.campaigns.find((c) => c._id === opportunity.campaignId)
      : growth.campaigns[0];
    if (!campaign)
      throw new ConvexError(
        "Growth needs a current verified capability and registered campaign.",
      );
    if (growthAction !== "discover" && !opportunity)
      throw new ConvexError(
        "Select the Growth task or include its exact opportunity ID.",
      );
    growthCommand = {
      growthAction,
      growthRevision: /\b(?:revise|regenerate)\b/.test(words),
      campaignId: campaign._id,
      ...(opportunity ? { opportunityId: opportunity._id } : {}),
      release,
    };
  }
  const action = /^(?:please\s+)?(?:investigate|start investigation)\b/.test(
    words,
  )
    ? "investigate"
    : /^(?:please\s+)?(?:delegate|implement)\b/.test(words)
      ? "delegate"
      : /^(?:please\s+)?(?:collect|run collection)\b/.test(words)
        ? "collect"
        : undefined;
  let issueId = input.issueId || selected?.issueId;
  if (!issueId) {
    const snapshot = await db().query(api.cue.snapshot, { secret: secret() });
    const eligible = snapshot.issues.filter(
      (i) => (i.appId || "bloom") === input.appId,
    );
    issueId = eligible.find(
      (i) =>
        words.includes(i._id) ||
        (words.includes("iss-14") && i.fingerprint === "bloom:upload:413"),
    )?._id;
  }
  return db().mutation(api.workspace.post, {
    secret: secret(),
    appId: input.appId,
    agent: input.agent,
    actor: { id: actor.id, name: actor.name, role: actor.role },
    key: input.key,
    text: input.text,
    via,
    ...(taskId ? { taskId: taskId as Id<"agentTasks"> } : {}),
    ...(issueId ? { issueId: issueId as Id<"issues"> } : {}),
    ...(action ? { action } : {}),
    ...growthCommand,
    ...(threadKey ? { threadKey } : {}),
    repository: config.coding?.find((c) => c.appId === input.appId)?.repository,
    queueAnswer: !action && geminiReady(),
  });
}
export async function workspaceSnapshot(appId: string, actor: WorkspaceActor) {
  const { app } = await workspaceApp(appId);
  const [workspace, domain, jobs, x, notifications, companion, growth] =
    await Promise.all([
      db().query(api.workspace.snapshot, {
        secret: secret(),
        appId,
        participant: actor.id,
      }),
      db().query(api.cue.snapshot, { secret: secret() }),
      db().query(api.jobs.status, { secret: secret() }),
      xRuntimeStatus(),
      notificationRuntimeStatus(),
      sharedWorkerStatus().catch(() => null),
      db().query(api.growth.snapshot, { secret: secret(), appId }),
    ]);
  const health = (ok: boolean, label: string, detail: string) => ({
    st: ok ? "ok" : "unknown",
    label,
    detail,
  });
  const agents = [
    {
      id: "x",
      name: "X",
      icon: "xlogo",
      purpose:
        "Collects authorized X mentions with original source provenance.",
      can: ["Read official mentions", "Run bounded collection"],
      cannot: ["Publish public replies"],
      limits: "Shared checkpoint and leased collection",
      health: health(
        x.connected,
        x.connected ? "Official read connected" : "Collection unavailable",
        x.detail,
      ),
      sugg: ["Show current work", "Run collection now"],
    },
    {
      id: "reddit",
      name: "Reddit",
      icon: "reddit",
      purpose:
        "Routes notification excerpts and supplied sources; source removal remains separate from intake health.",
      can: ["Notification intake", "Operator supplied-source capture"],
      cannot: ["General API search", "Publish replies"],
      limits: "Assisted capture; general API access unavailable",
      health: health(
        !!notifications.connected,
        notifications.connected
          ? "Notification inbox connected"
          : "Notification health unavailable",
        notifications.detail || "Provider notification coverage varies",
      ),
      sugg: ["Show current work"],
    },
    {
      id: "growth",
      name: "Growth",
      icon: "trend",
      purpose:
        "Matches explicit needs to verified capabilities and tracks reviewed recommendations.",
      can: [
        "Bounded official discovery",
        "Qualify explicit needs",
        "Draft from verified capabilities",
        "Inspect review and activation evidence",
      ],
      cannot: [
        "Approve own content",
        "Publish replies",
        "Promise unsupported features",
      ],
      limits: "Shares two reasoning slots",
      health: health(
        geminiReady(),
        geminiReady() ? "Gemini configured" : "Gemini unavailable",
        "Publication requires exact review and Owner action",
      ),
      sugg: ["What is blocked?"],
    },
    {
      id: "engineering",
      name: "Engineering",
      icon: "bot",
      purpose:
        "Delegates approved specifications through registered repository policy; follows tests, PRs and release evidence.",
      can: [
        "Delegate approved specs",
        "Inspect existing runs",
        "Scoped Bloom upload investigation",
      ],
      cannot: [
        "Arbitrary bug execution",
        "Claim deployed resolution without release evidence",
      ],
      limits: "One personal Codex run",
      health: health(
        !!companion?.codex.loggedIn && !!companion?.codex.workerOnline,
        companion?.codex.workerOnline
          ? "Companion online"
          : "Companion offline",
        companion?.busy
          ? "Coding slot busy"
          : "No active companion work reported",
      ),
      sugg: ["Show current work"],
    },
  ];
  const tasks = workspace.tasks.map((t) => {
    const opportunity = growth.opportunities.find(
      (o) => o._id === t.opportunityId,
    );
    const capability = growth.capabilities.find(
      (c) => c._id === opportunity?.capabilityId,
    );
    const draft = growth.drafts
      .filter((d) => d.opportunityId === opportunity?._id)
      .sort((a, b) => b.version - a.version)[0];
    const touch = growth.touches
      .filter((x) => x.opportunityId === opportunity?._id)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const run = t.runId && domain.runs.find((r) => r._id === t.runId);
    const issue = t.issueId && domain.issues.find((i) => i._id === t.issueId);
    const state = run
      ? run.status === "resolved" && run.verified && run.deployed
        ? "completed"
        : run.status === "awaiting_approval"
          ? "awaiting"
          : ["failed", "canceled"].includes(run.status)
            ? run.status
            : ["approved", "rejected"].includes(run.status)
              ? "blocked"
              : jobs.find((j) => j.runId === run._id)?.status === "queued"
                ? "queued"
                : "running"
      : t.state;
    const events = workspace.events
      .filter((e) => e.taskId === t._id)
      .map((e) => ({
        t: e.createdAt,
        who: e.actor,
        kind: e.kind,
        text: e.text,
        evidence: e.evidence,
        ref: e.evidence ? { h: e.evidence, l: "Evidence" } : undefined,
      }));
    if (run)
      events.push(
        ...domain.events
          .filter((e) => e.runId === run._id)
          .map((e) => ({
            t: e.createdAt,
            who: run.provider,
            kind:
              e.kind === "failure"
                ? "failed"
                : e.kind === "approval"
                  ? "pending"
                  : "completed",
            text: e.title + " · " + e.detail,
            evidence: run.prUrl,
            ref: run.prUrl ? { h: run.prUrl, l: "PR" } : undefined,
          })),
      );
    return {
      id: t._id,
      issueId: t.issueId,
      opportunityId: t.opportunityId,
      campaignId: t.campaignId,
      parentId: t.parentId,
      deps: (t.dependencies || []).join(" · "),
      children: workspace.tasks
        .filter((child) => child.parentId === t._id)
        .map((child) => ({
          l: child.title,
          h: "#/agents/" + child.agent + "/" + child._id,
        })),
      reviewer:
        t.reviewer ||
        (run?.status === "awaiting_approval" ? "Engineering" : undefined),
      agent: t.agent,
      app: app.name,
      title: t.title,
      type: t.action,
      state:
        !run && state === "running" && t.leaseUntil && t.leaseUntil < Date.now()
          ? "blocked"
          : state,
      stage: run?.phase || t.stage,
      blocker:
        (!run &&
        state === "running" &&
        t.leaseUntil &&
        t.leaseUntil < Date.now()
          ? "Worker lease expired. Await bounded retry or request recovery; saved effects retained."
          : undefined) ||
        run?.error ||
        t.blocker ||
        (run?.status === "approved"
          ? "Approved commit awaits deployment and acceptance."
          : undefined),
      note:
        state === "queued"
          ? "Durable instruction saved; worker has not started."
          : undefined,
      review: t.opportunityId
        ? { l: "Open exact Growth context", h: "#/growth/" + t.opportunityId }
        : run?.status === "awaiting_approval"
          ? { l: "Review exact commit", h: "#/issues/" + t.issueId }
          : undefined,
      person: !!t.reviewer || run?.status === "awaiting_approval",
      retry:
        ["failed", "retrying", "canceled"].includes(state) &&
        (t.agent === "x" ||
          (t.agent === "growth" &&
            ["discover", "qualify", "draft"].includes(t.action)) ||
          (t.agent === "engineering" && !!t.issueId)),
      next: t.opportunityId
        ? "Continue through Growth controls"
        : t.agent === "engineering" && ["failed", "canceled"].includes(state)
          ? "Request a new supported run; existing evidence retained"
          : undefined,
      created: t.createdAt,
      owner: agents.find((a) => a.id === t.agent)!.name,
      events: events.sort((a, b) => a.t - b.t),
      sources: opportunity
        ? [
            {
              l: opportunity.author + " · " + opportunity.provenance,
              h: opportunity.sourceUrl,
              k: opportunity.channel,
              ext: true,
            },
          ]
        : domain.cases
            .filter(
              (c) =>
                t.issueId &&
                c.issueId === t.issueId &&
                (c.appId || "bloom") === appId,
            )
            .map((c) => ({ l: c.title, h: "#/inbox/" + c._id, k: "case" })),
      evidence: [
        ...(capability
          ? [
              {
                l:
                  capability.name +
                  " · " +
                  capability.release +
                  " · " +
                  (capability.valid ? "verified" : "stale"),
                h: "#/growth/campaigns",
                k: "capability",
              },
            ]
          : []),
        ...(draft
          ? [
              {
                l:
                  "Draft v" +
                  draft.version +
                  " · " +
                  draft.status +
                  " · " +
                  draft.hash,
                h: "#/growth/" + opportunity!._id,
                k: "exact content",
              },
            ]
          : []),
        ...(touch?.status === "verified" && touch.publicationUrl
          ? [
              {
                l: "Verified publication",
                h: touch.publicationUrl,
                k: "official receipt",
                ext: true,
              },
            ]
          : []),
        ...(opportunity
          ? [
              {
                l: "Product outcome milestones",
                h: "#/growth/results",
                k: "trusted Bloom events",
              },
            ]
          : []),
        ...(issue?.spec
          ? [
              {
                l: "Exact specification",
                h: "#/features/" + issue._id,
                k: "spec",
              },
            ]
          : []),
        ...(run?.commit ? [{ l: run.commit, k: "commit" }] : []),
        ...(run?.prUrl
          ? [{ l: "Pull request", h: run.prUrl, ext: true, k: "PR" }]
          : []),
        ...(run?.after ? [{ l: run.after, k: "independent tests" }] : []),
        ...(run?.releaseEvidence
          ? [{ l: run.releaseEvidence, k: "release acceptance" }]
          : []),
      ],
    };
  });
  return {
    operator: { name: actor.name, role: actor.role },
    app: { id: app.id, name: app.name },
    apps: [
      { id: "bloom", name: "Legacy Bloom" },
      ...(await readIntegrations()).apps.map((a) => ({
        id: a.id,
        name: a.name,
      })),
    ],
    agents,
    tasks,
    conversations: workspace.conversations,
  };
}
