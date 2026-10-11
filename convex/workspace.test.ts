/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import workpool from "@convex-dev/workpool/test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const auth = { secret: "workspace-test-secret" };
const owner = { id: "owner-id", name: "Owner", role: "owner" as const };
const base = {
  ...auth,
  appId: "bloom",
  agent: "engineering" as const,
  actor: owner,
  text: "Show current work",
  via: "Q",
  key: "question-1",
};
beforeEach(() => {
  vi.stubEnv("CUE_DEMO_SECRET", auth.secret);
});
afterEach(() => vi.unstubAllEnvs());
function setup() {
  const t = convexTest(schema, modules);
  agent.register(t);
  workpool.register(t, "triagePool");
  return t;
}
test("status questions persist in Agent threads and never create execution jobs", async () => {
  const t = setup();
  const result = await t.mutation(api.workspace.post, base);
  expect(result.taskId).toBeNull();
  const snapshot = await t.query(api.workspace.snapshot, {
    ...auth,
    appId: base.appId,
    participant: owner.id,
  });
  expect(snapshot.tasks).toHaveLength(0);
  expect(snapshot.conversations[0].messages).toHaveLength(2);
  expect(snapshot.conversations[0].messages[0].text).toBe(base.text);
  expect(await t.run((ctx) => ctx.db.query("jobs").take(20))).toHaveLength(0);
  expect(
    (
      await t.query(api.workspace.snapshot, {
        ...auth,
        appId: "another-app",
        participant: owner.id,
      })
    ).conversations,
  ).toHaveLength(0);
});
test("command replay is exact-context and exact-content bound", async () => {
  const t = setup();
  await t.mutation(api.workspace.post, base);
  expect((await t.mutation(api.workspace.post, base)).duplicate).toBe(true);
  await expect(
    t.mutation(api.workspace.post, { ...base, text: "Changed" }),
  ).rejects.toThrow("content version");
  await expect(
    t.mutation(api.workspace.post, {
      ...base,
      actor: { ...owner, id: "other" },
    }),
  ).rejects.toThrow("another context");
  await expect(
    t.mutation(api.workspace.post, { ...base, secret: "wrong" }),
  ).rejects.toThrow("Unauthorized");
});
test("wrong role records denial without invoking coding tool", async () => {
  const t = setup();
  await t.mutation(api.cue.seed, auth);
  const issue = (await t.query(api.cue.snapshot, auth)).issues.find(
    (i) => i.kind === "bug",
  )!;
  const result = await t.mutation(api.workspace.post, {
    ...base,
    issueId: issue._id,
    action: "investigate",
    actor: { ...owner, role: "support" },
  });
  expect(result.response).toContain("No work queued");
  expect(await t.run((ctx) => ctx.db.query("jobs").take(20))).toHaveLength(0);
});
test("Q and Slack instructions share one task and one existing implementation", async () => {
  const t = setup();
  await t.mutation(api.cue.seed, auth);
  const issue = (await t.query(api.cue.snapshot, auth)).issues.find(
    (i) => i.kind === "bug",
  )!;
  const results = await Promise.all([
    t.mutation(api.workspace.post, {
      ...base,
      issueId: issue._id,
      action: "investigate",
    }),
    t.mutation(api.workspace.post, {
      ...base,
      key: "slack-question",
      via: "Slack",
      issueId: issue._id,
      action: "investigate",
      threadKey: "TEAM:CHANNEL:1",
    }),
  ]);
  expect(results[0].taskId).toBe(results[1].taskId);
  expect(await t.run((ctx) => ctx.db.query("runs").take(20))).toHaveLength(1);
  expect(await t.run((ctx) => ctx.db.query("jobs").take(20))).toHaveLength(1);
  expect(
    (await t.query(api.workspace.thread, { ...auth, key: "TEAM:CHANNEL:1" }))
      ?.taskId,
  ).toBe(results[0].taskId);
  await expect(
    t.mutation(api.workspace.post, {
      ...base,
      key: "wrong-app",
      appId: "other",
      issueId: issue._id,
      action: "investigate",
    }),
  ).rejects.toThrow("another app");
});
test("two companions cannot claim simultaneous coding runs", async () => {
  const t = setup();
  await t.mutation(api.cue.seed, auth);
  const issue = (await t.query(api.cue.snapshot, auth)).issues.find(
    (i) => i.kind === "bug",
  )!;
  await t.mutation(api.cue.startRun, { ...auth, issueId: issue._id });
  const runId = await t.run((ctx) =>
    ctx.db.insert("runs", {
      issueId: issue._id,
      status: "running",
      phase: "waiting",
      provider: "Codex",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("jobs", {
      runId,
      status: "queued",
      kind: "feature",
      leaseUntil: 0,
      cancel: false,
      createdAt: Date.now(),
    }),
  );
  const claims = await Promise.all([
    t.mutation(api.jobs.claim, { ...auth, worker: "one" }),
    t.mutation(api.jobs.claim, { ...auth, worker: "two" }),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
});
test("leases reject overlap; stale completion cannot overwrite cancellation", async () => {
  const t = setup();
  const taskId = await t.run((ctx) =>
    ctx.db.insert("agentTasks", {
      appId: "bloom",
      agent: "x",
      action: "collect",
      key: "lease",
      title: "Collection",
      state: "queued",
      stage: "Waiting",
      attempts: 0,
      cancel: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await t.mutation(api.workspace.begin, { ...auth, taskId, token: "one" });
  await expect(
    t.mutation(api.workspace.begin, { ...auth, taskId, token: "two" }),
  ).rejects.toThrow("leased");
  await t.mutation(api.workspace.cancel, {
    ...auth,
    appId: "bloom",
    taskId,
    actor: owner,
  });
  await t.mutation(api.workspace.finish, {
    ...auth,
    taskId,
    token: "stale",
    ok: true,
    detail: "Stale receipt",
  });
  await t.mutation(api.workspace.finish, {
    ...auth,
    taskId,
    token: "one",
    ok: true,
    detail: "Collection finished after cancellation",
  });
  const snapshot = await t.query(api.workspace.snapshot, {
    ...auth,
    appId: "bloom",
    participant: owner.id,
  });
  expect(snapshot.tasks[0].state).toBe("canceled");
  expect(snapshot.events.some((e) => e.text === "Stale receipt")).toBe(false);
});

test("contextual answers update the persisted Agent reply, preserve prior turns and reject stale writes", async () => {
  const t = setup();
  await t.mutation(api.workspace.post, {
    ...base,
    text: "Earlier context about deployment",
    key: "earlier-question",
  });
  await t.mutation(api.workspace.post, {
    ...base,
    text: "What does that imply?",
    key: "context-question",
    queueAnswer: true,
  });
  const command = (
    await t.run((ctx) => ctx.db.query("agentCommands").take(10))
  ).find((c) => c.key === "context-question")!;
  const job = await t.mutation(api.workspaceAnswers.begin, {
    ...auth,
    commandId: command._id,
    token: "answer-lease",
  });
  expect(job?.context).toContain("Earlier context about deployment");
  expect(
    await t.mutation(api.workspaceAnswers.begin, {
      ...auth,
      commandId: command._id,
      token: "other-lease",
    }),
  ).toBeNull();
  await t.mutation(api.workspaceAnswers.finish, {
    ...auth,
    commandId: command._id,
    token: "stale",
    answer: "Wrong overwrite",
  });
  await t.mutation(api.workspaceAnswers.finish, {
    ...auth,
    commandId: command._id,
    token: "answer-lease",
    answer: "Deployment evidence still required.",
  });
  const snapshot = await t.query(api.workspace.snapshot, {
    ...auth,
    appId: base.appId,
    participant: owner.id,
  });
  expect(snapshot.conversations[0].messages.at(-1)?.text).toBe(
    "Deployment evidence still required.",
  );
  expect(snapshot.conversations[0].messages.at(-1)?.answerStatus).toBe(
    "completed",
  );
  expect(
    (
      await t.query(api.workspace.snapshot, {
        ...auth,
        appId: base.appId,
        participant: "another-owner",
      })
    ).conversations,
  ).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.query("jobs").take(10))).toHaveLength(0);
});

test("lost leases are visible in question answers, and failed engineering work can request a supported fresh run", async () => {
  const t = setup();
  const expired = await t.run((ctx) =>
    ctx.db.insert("agentTasks", {
      appId: "bloom",
      agent: "x",
      action: "collect",
      key: "expired-collect",
      title: "Expired collection",
      state: "running",
      stage: "Collecting",
      attempts: 1,
      cancel: false,
      leaseUntil: Date.now() - 10000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  const answer = await t.mutation(api.workspace.post, {
    ...base,
    agent: "x",
    taskId: expired,
    key: "expired-question",
  });
  expect(answer.response).toContain("blocked");
  expect(answer.response).toContain("lease expired");
  await t.mutation(api.cue.seed, auth);
  const issue = (await t.query(api.cue.snapshot, auth)).issues.find(
    (i) => i.fingerprint === "bloom:upload:413",
  )!;
  const first = await t.mutation(api.workspace.post, {
    ...base,
    key: "first-failed-run",
    issueId: issue._id,
    action: "investigate",
  });
  const task = await t.run((ctx) => ctx.db.get("agentTasks", first.taskId!));
  await t.run((ctx) =>
    ctx.db.patch("runs", task!.runId!, {
      status: "failed",
      error: "Test worker failed",
    }),
  );
  const retry = await t.mutation(api.workspace.post, {
    ...base,
    key: "fresh-retry-run",
    issueId: issue._id,
    action: "investigate",
  });
  expect(retry.taskId).not.toBe(first.taskId);
});
