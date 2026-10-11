/// <reference types="vite/client" />
import { test, expect, vi, afterEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { replyFacts, replyProblems } from "../lib/reply-policy";
const modules = import.meta.glob("../convex/**/*.{ts,js}"),
  auth = { secret: "release-test-secret" };
afterEach(() => vi.unstubAllEnvs());
const evidence =
  "Local deployed acceptance checks: case-insensitive caption search matched correct cards, missing query showed an empty state, clearing restored both cards. Exact approved source verified.";
async function setup() {
  vi.stubEnv("CUE_DEMO_SECRET", auth.secret);
  const t = convexTest(schema, modules);
  const issueId = await t.run((ctx) =>
    ctx.db.insert("issues", {
      title: "Caption search",
      description: "Search captions",
      kind: "feature",
      fingerprint: "caption-search",
      status: "approved",
      priority: "P3",
      tags: [],
      createdAt: Date.now(),
      spec: "approved spec",
      specApprovedAt: Date.now(),
    }),
  );
  const caseId = await t.mutation(api.cue.createCase, {
    ...auth,
    customer: "Visitor",
    owner: "visitor",
    title: "Caption search",
    body: "Find my memories by caption",
    channel: "chat",
  });
  await t.run((ctx) => ctx.db.patch("cases", caseId, { issueId }));
  const runId = await t.mutation(api.cue.startFeature, {
    ...auth,
    issueId,
    expectedSpec: "approved spec",
    targetId: "bloom",
    repository: "owner/bloom",
  });
  const commit = "a".repeat(40),
    releaseCommit = "b".repeat(40);
  await t.mutation(api.cue.updateRun, {
    ...auth,
    runId,
    fields: { status: "awaiting_approval", commit },
  });
  return {
    t,
    runId,
    issueId,
    caseId,
    commit,
    args: { ...auth, runId, commit, releaseCommit, evidence },
  };
}
test("release requires Engineering, exact commit, current Product approval and deployed evidence", async () => {
  const { t, runId, issueId, commit, args } = await setup();
  await expect(t.mutation(api.releases.confirmFeature, args)).rejects.toThrow(
    "approved",
  );
  await t.mutation(api.jobs.decide, {
    ...auth,
    runId,
    commit,
    actor: "Ganesh",
    approve: true,
  });
  await expect(
    t.mutation(api.releases.confirmFeature, {
      ...args,
      commit: "c".repeat(40),
    }),
  ).rejects.toThrow("approved");
  await expect(
    t.mutation(api.releases.confirmFeature, { ...args, evidence: "" }),
  ).rejects.toThrow("evidence");
  await expect(
    t.mutation(api.cue.updateRun, {
      ...auth,
      runId,
      fields: { status: "resolved", deployed: true, verified: true },
    }),
  ).rejects.toThrow("release verifier");
  await t.run((ctx) =>
    ctx.db.patch("issues", issueId, {
      spec: "changed",
      specApprovedAt: undefined,
    }),
  );
  await expect(t.mutation(api.releases.confirmFeature, args)).rejects.toThrow(
    "Product",
  );
});
test("verified release records proof and one customer update, and retry is idempotent", async () => {
  const { t, runId, commit, args, caseId } = await setup();
  await t.mutation(api.jobs.decide, {
    ...auth,
    runId,
    commit,
    actor: "Ganesh",
    approve: true,
  });
  await t.mutation(api.releases.confirmFeature, args);
  await t.mutation(api.releases.confirmFeature, args);
  await t.mutation(api.releases.confirmFeature, {
    ...args,
    evidence: "  " + args.evidence + "  ",
  });
  const snapshot = await t.query(api.cue.snapshot, auth),
    run = snapshot.runs.find((r) => r._id === runId)!;
  expect(run.releaseEvidence).toBe(evidence);
  expect(run.deployed && run.verified).toBe(true);
  const updates = snapshot.messages.filter(
    (m) =>
      m.caseId === caseId &&
      m.role === "cue" &&
      m.body.includes("acceptance checks"),
  );
  expect(updates).toHaveLength(1);
  expect(updates[0].body).toContain("caption search");
  const context = {
    run,
    issue: snapshot.issues.find((i) => i._id === run.issueId),
  };
  expect(replyFacts(context).featureVerified).toBe(true);
  expect(replyProblems(updates[0].body, context)).toEqual([]);
  expect(
    replyFacts({ ...context, run: { ...run, releaseEvidence: undefined } })
      .featureVerified,
  ).toBe(false);
});
