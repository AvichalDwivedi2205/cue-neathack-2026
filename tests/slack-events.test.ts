/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { SlackConfig } from "../lib/integration-config";

const mocks = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn() }));
vi.mock("../lib/server-store", async () => ({
  api: (await import("../convex/_generated/api")).api,
  db: () => ({ mutation: mocks.mutation, query: mocks.query }),
  secret: () => "isolated-test-secret",
}));
vi.mock("../lib/triage", () => ({ triage: vi.fn() }));
import { decideSlack } from "../lib/slack-events";
import { specVersion } from "../lib/slack-messages";
import { membersInput } from "../lib/roles";

const modules = import.meta.glob("../convex/**/*.{ts,js}");
const auth = { secret: "isolated-test-secret" };
const commit = "a".repeat(40);
const config: SlackConfig = {
  botToken: "xoxb-isolated-test",
  teamId: "TTEST",
  supportChannel: "CSUPPORT",
  engineeringChannel: "CENGINEERING",
  operatorIds: ["UOPERATOR"],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CUE_DEMO_SECRET", auth.secret);
});
afterEach(() => vi.unstubAllEnvs());

test.each([true, false])(
  "Slack decision approve=%s reaches actual Convex lifecycle and rejects replay",
  async (approve) => {
    const t = convexTest(schema, modules);
    await t.mutation(api.cue.seed, auth);
    const initial = await t.query(api.cue.snapshot, auth);
    const issue = initial.issues.find((i) => i.kind === "bug")!;
    const runId = await t.mutation(api.cue.startRun, {
      ...auth,
      issueId: issue._id,
    });
    await t.mutation(api.cue.updateRun, {
      ...auth,
      runId,
      fields: { status: "awaiting_approval", commit },
    });
    mocks.mutation.mockImplementation((reference, args) =>
      t.mutation(reference, args),
    );
    const payload = {
      team: { id: config.teamId },
      channel: { id: config.engineeringChannel },
      user: { id: config.operatorIds[0] },
      actions: [
        {
          action_id: approve ? "cue_approve" : "cue_reject",
          value: JSON.stringify({ runId, commit }),
        },
      ],
    };
    expect(await decideSlack(payload, config)).toEqual({
      runId,
      commit,
      actor: "Slack operator UOPERATOR",
    });
    const snapshot = await t.query(api.cue.snapshot, auth);
    expect(snapshot.runs.find((r) => r._id === runId)).toMatchObject({
      status: approve ? "running" : "rejected",
      phase: approve ? "deploying" : "rejected",
      approval: "Slack operator UOPERATOR",
      commit,
      ...(approve ? {} : { error: "Rejected in Slack" }),
    });
    expect(snapshot.issues.find((i) => i._id === issue._id)?.status).toBe(
      approve ? "investigating" : "open",
    );
    const jobs = await t.query(api.jobs.status, auth);
    expect(
      jobs.filter((j) => j.runId === runId && j.kind === "deploy"),
    ).toHaveLength(approve ? 1 : 0);
    await expect(decideSlack(payload, config)).rejects.toThrow(
      "pending commit",
    );
    const afterReplay = await t.query(api.jobs.status, auth);
    expect(afterReplay).toEqual(jobs);
  },
);
const roleConfig = {
  ...config,
  members: membersInput.parse([
    {
      email: "owner@example.com",
      name: "Avichal",
      role: "owner",
      slackId: "UOWNER",
    },
    {
      email: "engineering@example.com",
      name: "Ganesh",
      role: "engineering",
      slackId: "UENGINEER",
    },
    {
      email: "product@example.com",
      name: "Holly",
      role: "product",
      slackId: "UPRODUCT",
    },
    {
      email: "support@example.com",
      name: "Aria",
      role: "support",
      slackId: "USUPPORT",
    },
  ]),
};
test.each([true, false])(
  "Product specification approve=%s is atomic, auditable and replay safe",
  async (approve) => {
    const t = convexTest(schema, modules);
    await t.mutation(api.cue.seed, auth);
    const initial = await t.query(api.cue.snapshot, auth);
    const issue = initial.issues.find((i) => i.kind === "feature")!;
    const spec = JSON.stringify({
      need: "Search memories",
      specification: "Search by captions",
      acceptanceCriteria: ["Find matching captions", "Show no matches state"],
    });
    await t.mutation(api.cue.spec, { ...auth, issueId: issue._id, spec });
    mocks.mutation.mockImplementation((reference, args) =>
      t.mutation(reference, args),
    );
    mocks.query.mockImplementation((reference, args) =>
      t.query(reference, args),
    );
    const payload = {
      team: { id: config.teamId },
      channel: { id: config.engineeringChannel },
      user: { id: "UPRODUCT" },
      actions: [
        {
          action_id: approve ? "cue_spec_approve" : "cue_spec_reject",
          value: JSON.stringify({
            issueId: issue._id,
            version: specVersion(spec),
          }),
        },
      ],
    };
    for (const id of ["USUPPORT", "UENGINEER", "UOPERATOR", "USTRANGER"])
      await expect(
        decideSlack({ ...payload, user: { id } }, roleConfig),
      ).rejects.toThrow("authorized");
    for (const changed of [
      { ...payload, team: { id: "TWRONG" } },
      { ...payload, channel: { id: config.supportChannel } },
    ])
      await expect(decideSlack(changed, roleConfig)).rejects.toThrow(
        "authorized",
      );
    expect(mocks.mutation).not.toHaveBeenCalled();
    await decideSlack(payload, roleConfig);
    const snapshot = await t.query(api.cue.snapshot, auth);
    expect(snapshot.issues.find((i) => i._id === issue._id)).toMatchObject({
      status: approve ? "approved" : "spec_rejected",
      spec,
      ...(approve ? { specApprovedBy: "Holly · Slack UPRODUCT" } : {}),
    });
    expect(snapshot.runs).toHaveLength(0);
    expect(await t.query(api.jobs.status, auth)).toHaveLength(0);
    await expect(decideSlack(payload, roleConfig)).rejects.toThrow(
      "pending specification",
    );
    await t.mutation(api.cue.spec, {
      ...auth,
      issueId: issue._id,
      spec: spec.replace("captions", "titles"),
    });
    await expect(decideSlack(payload, roleConfig)).rejects.toThrow("changed");
    await expect(
      t.mutation(api.cue.decideSpec, {
        ...auth,
        issueId: issue._id,
        expectedSpec: spec,
        approve: true,
        actor: "stale reviewer",
      }),
    ).rejects.toThrow("pending specification");
  },
);
test("Product and Support cannot approve deployments even with valid commit payloads", async () => {
  const payload = {
    team: { id: config.teamId },
    channel: { id: config.engineeringChannel },
    actions: [
      {
        action_id: "cue_approve",
        value: JSON.stringify({ runId: "run", commit }),
      },
    ],
  };
  for (const id of ["UPRODUCT", "USUPPORT", "UOPERATOR"])
    await expect(
      decideSlack({ ...payload, user: { id } }, roleConfig),
    ).rejects.toThrow("authorized");
  expect(mocks.mutation).not.toHaveBeenCalled();
});
