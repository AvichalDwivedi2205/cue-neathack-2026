/// <reference types="vite/client" />
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { codingInput } from "../lib/integration-config";
import {
  permittedChange,
  protectedSource,
  featurePrompt,
} from "../lib/coding-policy";
import { approvalMessage } from "../lib/slack-messages";
const modules = import.meta.glob("../convex/**/*.{ts,js}"),
  auth = { secret: "feature-test-secret" };
const spec = JSON.stringify({
  need: "Find memories",
  specification: "Search journal captions",
  acceptanceCriteria: ["Case-insensitive search", "Empty query shows all"],
});
const policy = {
  appId: "bloom",
  repository: "owner/bloom",
  baseBranch: "main",
  allowedPaths: ["src/", "tests/"],
  testCommands: [{ program: "node" as const, args: ["test.mjs"] }],
};
beforeEach(() => vi.stubEnv("CUE_DEMO_SECRET", auth.secret));
afterEach(() => vi.unstubAllEnvs());
async function setup(approved = true) {
  const t = convexTest(schema, modules);
  const issueId = await t.run((ctx) =>
    ctx.db.insert("issues", {
      title: "Search",
      description: "Search captions",
      kind: "feature",
      fingerprint: "feature:search",
      status: approved ? "approved" : "spec_ready",
      priority: "P3",
      tags: [],
      createdAt: Date.now(),
      spec,
      ...(approved
        ? { specApprovedAt: Date.now(), specApprovedBy: "Product" }
        : {}),
    }),
  );
  return {
    t,
    issueId,
    args: {
      ...auth,
      issueId,
      expectedSpec: spec,
      targetId: "bloom",
      repository: policy.repository,
    },
  };
}
describe("Approved feature implementation", () => {
  test("unapproved, edited and cross-app specifications cannot delegate code", async () => {
    const { t, args } = await setup(false);
    await expect(t.mutation(api.cue.startFeature, args)).rejects.toThrow(
      "approved specification",
    );
    await t.run((ctx) =>
      ctx.db.patch("issues", args.issueId, {
        status: "approved",
        specApprovedAt: Date.now(),
      }),
    );
    await expect(
      t.mutation(api.cue.startFeature, { ...args, expectedSpec: "{}" }),
    ).rejects.toThrow("approved specification");
    await expect(
      t.mutation(api.cue.startFeature, { ...args, targetId: "other" }),
    ).rejects.toThrow("connected app");
  });
  test("concurrent delegation creates one run and one durable job", async () => {
    const { t, args } = await setup();
    const outcomes = await Promise.allSettled([
      t.mutation(api.cue.startFeature, args),
      t.mutation(api.cue.startFeature, args),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await t.query(api.jobs.status, auth)).filter(
        (j) => j.kind === "feature",
      ),
    ).toHaveLength(1);
  });
  test("Engineering approves exact PR commit without deploying or resolving customers", async () => {
    const { t, args } = await setup();
    const runId = await t.mutation(api.cue.startFeature, args);
    const commit = "b".repeat(40);
    await t.mutation(api.cue.updateRun, {
      ...auth,
      runId,
      fields: {
        status: "awaiting_approval",
        phase: "awaiting_approval",
        commit,
        after: "checks passed",
      },
    });
    await expect(
      t.mutation(api.jobs.decide, {
        ...auth,
        runId,
        commit: "a".repeat(40),
        actor: "Engineering",
        approve: true,
      }),
    ).rejects.toThrow("pending commit");
    await t.mutation(api.jobs.decide, {
      ...auth,
      runId,
      commit,
      actor: "Engineering",
      approve: true,
    });
    const state = await t.query(api.cue.snapshot, auth),
      run = state.runs.find((r) => r._id === runId)!;
    expect(run.status).toBe("approved");
    expect(run.deployed).toBeUndefined();
    expect(run.verified).toBeUndefined();
    expect(state.issues.find((i) => i._id === args.issueId)?.status).toBe(
      "implemented",
    );
    expect(
      (await t.query(api.jobs.status, auth)).filter((j) => j.kind === "deploy"),
    ).toHaveLength(0);
    await expect(
      t.mutation(api.jobs.decide, {
        ...auth,
        runId,
        commit,
        actor: "Engineering",
        approve: true,
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.cue.updateRun, {
        ...auth,
        runId,
        fields: { status: "resolved", deployed: true, verified: true },
      }),
    ).rejects.toThrow("release verifier");
  });
  test("PR approval card uses the correct action and explains release limits", async () => {
    const { t, args } = await setup();
    const runId = await t.mutation(api.cue.startFeature, args);
    await t.mutation(api.cue.updateRun, {
      ...auth,
      runId,
      fields: { status: "awaiting_approval", commit: "c".repeat(40) },
    });
    const run = (await t.query(api.cue.snapshot, auth)).runs.find(
      (r) => r._id === runId,
    )!;
    const card = approvalMessage(run, "Caption search");
    expect(card.text).toContain("does not merge, deploy");
    expect(JSON.stringify(card.blocks)).toContain("Approve change");
    expect(JSON.stringify(card.blocks)).not.toContain("Approve & deploy");
  });
  test("editing a specification invalidates a pending implementation approval", async () => {
    const { t, args } = await setup();
    const runId = await t.mutation(api.cue.startFeature, args);
    const commit = "d".repeat(40);
    await t.mutation(api.cue.updateRun, {
      ...auth,
      runId,
      fields: { status: "awaiting_approval", commit },
    });
    await t.mutation(api.cue.spec, {
      ...auth,
      issueId: args.issueId,
      spec: JSON.stringify({
        ...JSON.parse(spec),
        specification: "New search requirements",
      }),
    });
    await expect(
      t.mutation(api.jobs.decide, {
        ...auth,
        runId,
        commit,
        actor: "Engineering",
        approve: true,
      }),
    ).rejects.toThrow("current specification");
  });
});
test("repository policies constrain paths and preserve existing validation", () => {
  expect(codingInput.parse(policy).repository).toBe("owner/bloom");
  expect(permittedChange("src/search.ts", policy)).toBe(true);
  expect(permittedChange("src-other/search.ts", policy)).toBe(false);
  expect(permittedChange("src/../../credentials", policy)).toBe(false);
  expect(permittedChange(".env.local", policy)).toBe(false);
  expect(protectedSource("tests/existing.test.ts")).toBe(true);
  expect(protectedSource("package-lock.json")).toBe(true);
  expect(featurePrompt("Search", spec, policy)).toContain(
    "Network and web search are disabled",
  );
  expect(() =>
    codingInput.parse({ ...policy, allowedPaths: ["../"] }),
  ).toThrow();
});
