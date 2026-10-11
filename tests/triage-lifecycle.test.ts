/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.{ts,js}");
const auth = { secret: "triage-lifecycle-test" };
const spec = JSON.stringify({
  need: "Readable journal text",
  specification: "Persist the reader's chosen text size",
  acceptanceCriteria: ["Applies while reading", "Applies while writing"],
});
beforeEach(() => vi.stubEnv("CUE_DEMO_SECRET", auth.secret));
afterEach(() => vi.unstubAllEnvs());

async function setup(appId?: string) {
  const t = convexTest(schema, modules);
  const caseId = await t.mutation(api.cue.createCase, {
    ...auth,
    appId,
    channel: "slack",
    sourceKey: "slack:TEAM:CHANNEL:1.0",
    customer: "Holly",
    title: "Larger text",
    body: "Please make journal text easier to read",
  });
  const triage = {
    ...auth,
    caseId,
    priority: "P2" as const,
    tags: ["Readability"],
    reason: "Request for a text-size preference",
    kind: "feature",
  };
  await t.mutation(api.cue.triage, triage);
  const state = await t.query(api.cue.snapshot, auth);
  const issue = state.issues.find(
    (i) => i._id === state.cases.find((c) => c._id === caseId)?.issueId,
  )!;
  return { t, triage, issue };
}

test.each([undefined, "cue_app_test"])(
  "Slack follow-up triage preserves an exact-spec approval (app %s)",
  async (appId) => {
    const { t, triage, issue } = await setup(appId);
    expect(issue).toMatchObject({ kind: "feature", status: "requested" });
    await t.mutation(api.cue.spec, { ...auth, issueId: issue._id, spec });
    await t.mutation(api.cue.decideSpec, {
      ...auth,
      issueId: issue._id,
      expectedSpec: spec,
      approve: true,
      actor: "Holly · Slack UPRODUCT",
    });
    const approved = (await t.query(api.cue.snapshot, auth)).issues.find(
      (i) => i._id === issue._id,
    )!;
    await t.mutation(api.intake.receive, {
      ...auth,
      channel: "slack",
      sourceKey: "slack:TEAM:CHANNEL:1.0",
      eventKey: "slack:TEAM:CHANNEL:2.0",
      customer: "Holly",
      title: "Larger text",
      body: "Use the preference for both reading and writing",
    });
    await t.mutation(api.cue.triage, triage);
    const state = await t.query(api.cue.snapshot, auth);
    expect(state.issues.find((i) => i._id === issue._id)).toMatchObject({
      kind: "feature",
      status: "approved",
      spec,
      specApprovedBy: approved.specApprovedBy,
      specApprovedAt: approved.specApprovedAt,
    });
    expect(state.cases.find((c) => c._id === triage.caseId)?.issueId).toBe(
      issue._id,
    );
    expect(state.runs).toHaveLength(0);
  },
);

test.each(["spec_ready", "spec_rejected", "implementing", "resolved"])(
  "Follow-up triage preserves feature lifecycle state %s",
  async (status) => {
    const { t, triage, issue } = await setup();
    await t.mutation(api.cue.spec, { ...auth, issueId: issue._id, spec });
    await t.run(async (ctx) => ctx.db.patch("issues", issue._id, { status }));
    await t.mutation(api.cue.triage, triage);
    expect(
      (await t.query(api.cue.snapshot, auth)).issues.find(
        (i) => i._id === issue._id,
      ),
    ).toMatchObject({ status, spec });
  },
);

test("A late model-only duplicate match cannot move a reviewed case", async () => {
  const { t, triage, issue } = await setup();
  await t.mutation(api.cue.spec, { ...auth, issueId: issue._id, spec });
  const otherId = await t.run(async (ctx) =>
    ctx.db.insert("issues", {
      title: "Similar request",
      description: "Larger fonts",
      kind: "feature",
      fingerprint: "other-feature",
      status: "requested",
      priority: "P2",
      tags: [],
      createdAt: Date.now(),
    }),
  );
  await t.mutation(api.cue.triage, { ...triage, issueId: otherId });
  const state = await t.query(api.cue.snapshot, auth);
  expect(state.cases.find((c) => c._id === triage.caseId)?.issueId).toBe(
    issue._id,
  );
  expect(state.events.at(-1)?.issueId).toBe(issue._id);
});

test("Re-triage repairs the legacy status reset using retained approval, without inventing a decision", async () => {
  const { t, triage, issue } = await setup();
  await t.mutation(api.cue.spec, { ...auth, issueId: issue._id, spec });
  await t.mutation(api.cue.decideSpec, {
    ...auth,
    issueId: issue._id,
    expectedSpec: spec,
    approve: true,
    actor: "Holly · Slack UPRODUCT",
  });
  const before = await t.query(api.cue.snapshot, auth);
  const approved = before.issues.find((i) => i._id === issue._id)!;
  await t.run(async (ctx) =>
    ctx.db.patch("issues", issue._id, { status: "requested" }),
  );
  await t.mutation(api.cue.triage, triage);
  await t.mutation(api.cue.triage, triage);
  const after = await t.query(api.cue.snapshot, auth);
  expect(after.issues.find((i) => i._id === issue._id)).toMatchObject({
    status: "approved",
    spec,
    specApprovedAt: approved.specApprovedAt,
    specApprovedBy: approved.specApprovedBy,
  });
  expect(
    after.events.filter((e) => e.title === "Feature specification approved"),
  ).toHaveLength(1);
  expect(
    after.events.filter(
      (e) => e.title === "Specification approval status restored",
    ),
  ).toHaveLength(1);
  expect(after.runs).toHaveLength(0);
});

test("Unreviewed requests do not gain an approval during re-triage", async () => {
  const { t, triage, issue } = await setup();
  await t.mutation(api.cue.triage, triage);
  const current = (await t.query(api.cue.snapshot, auth)).issues.find(
    (i) => i._id === issue._id,
  )!;
  expect(current.status).toBe("requested");
  expect(current.specApprovedAt).toBeUndefined();
  expect(current.specApprovedBy).toBeUndefined();
});

test("Legacy reconciliation does not change status after implementation has started", async () => {
  const { t, triage, issue } = await setup();
  await t.mutation(api.cue.spec, {
    ...auth,
    issueId: issue._id,
    spec,
    approved: true,
    actor: "Holly",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch("issues", issue._id, { status: "requested" });
    await ctx.db.insert("runs", {
      issueId: issue._id,
      status: "running",
      phase: "coding",
      provider: "codex",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  await t.mutation(api.cue.triage, triage);
  const state = await t.query(api.cue.snapshot, auth);
  expect(state.issues.find((i) => i._id === issue._id)?.status).toBe(
    "requested",
  );
  expect(
    state.events.some(
      (e) => e.title === "Specification approval status restored",
    ),
  ).toBe(false);
  expect(state.runs).toHaveLength(1);
});
