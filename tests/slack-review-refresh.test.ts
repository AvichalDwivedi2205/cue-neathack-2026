import { beforeEach, expect, test, vi } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  update: vi.fn(),
  post: vi.fn(),
}));
vi.mock("../lib/integration-config", () => ({
  slackConfig: mocks.config,
  emailConfig: vi.fn(),
}));
vi.mock("../lib/server-store", () => ({
  api: {
    cue: { snapshot: "snapshot" },
    deliveries: { reserve: "reserve", finish: "finish" },
  },
  db: () => ({ query: mocks.query, mutation: mocks.mutation }),
  secret: () => "test-secret",
}));
vi.mock("../lib/slack", () => ({
  slackUpdate: mocks.update,
  slackPost: mocks.post,
}));
import {
  sendSlackDecision,
  sendSlackRunUpdate,
  sendSpecDecision,
} from "../lib/delivery";
import { specVersion } from "../lib/slack-messages";
const runId = "run" as Id<"runs">;
const run = {
  _id: runId,
  issueId: "issue",
  status: "approved",
  phase: "approved",
  commit: "a".repeat(40),
  approval: "Ganesh",
};
const issue = {
  _id: "issue",
  title: "Caption search",
  kind: "feature",
  status: "approved",
};
let snapshot: { runs: unknown[]; issues: unknown[]; deliveries: unknown[] };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockResolvedValue({
    botToken: "test-token",
    engineeringChannel: "CENGINEER",
    operatorIds: [],
  });
  snapshot = {
    runs: [run],
    issues: [issue],
    deliveries: [
      { key: "approval:run", status: "sent", receipt: "CENGINEER:123.456" },
      { key: `run-decision:run:${run.commit}`, status: "sent" },
    ],
  };
  mocks.query.mockImplementation(async () => snapshot);
  mocks.update.mockResolvedValue({ ok: true });
  mocks.post.mockResolvedValue({ channel: "CENGINEER", ts: "124.456" });
  mocks.mutation.mockResolvedValue("delivery");
});
test("completed decisions refresh the original card without resending the thread", async () => {
  await sendSlackDecision(
    { runId, commit: run.commit, actor: "Ganesh" },
    "123.456",
  );
  expect(mocks.update).toHaveBeenCalledWith(
    "test-token",
    "CENGINEER",
    "123.456",
    expect.stringContaining("Implementation approved"),
    expect.any(Array),
  );
  const blocks = JSON.stringify(mocks.update.mock.calls[0][4]);
  expect(blocks).not.toContain("cue_approve");
  expect(blocks).not.toContain("cue_reject");
  expect(mocks.post).not.toHaveBeenCalled();
});
test("a forged actor or a review receipt from another channel cannot edit a card", async () => {
  await sendSlackDecision({ runId, commit: run.commit, actor: "Aria" });
  expect(mocks.update).not.toHaveBeenCalled();
  snapshot.deliveries = [
    { key: "approval:run", status: "sent", receipt: "COTHER:123.456" },
    { key: `run-decision:run:${run.commit}`, status: "sent" },
  ];
  await sendSlackDecision({ runId, commit: run.commit, actor: "Ganesh" });
  expect(mocks.update).not.toHaveBeenCalled();
});
test("card edit failure does not block the durable decision confirmation", async () => {
  snapshot.deliveries = [
    { key: "approval:run", status: "sent", receipt: "CENGINEER:123.456" },
  ];
  mocks.update.mockRejectedValue(new Error("provider unavailable"));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  await sendSlackDecision(
    { runId, commit: run.commit, actor: "Ganesh" },
    "123.456",
  );
  expect(mocks.post).toHaveBeenCalledWith(
    "test-token",
    "CENGINEER",
    expect.stringContaining("Reviewed by Ganesh"),
    expect.any(Array),
    "123.456",
  );
  expect(mocks.mutation).toHaveBeenCalledWith(
    "finish",
    expect.objectContaining({ status: "sent" }),
  );
  warning.mockRestore();
});
test("verified status refreshes a stale review card even when its release update already exists", async () => {
  snapshot.runs = [
    {
      ...run,
      status: "resolved",
      phase: "verified",
      kind: "feature",
      deployed: true,
      verified: true,
      releaseCommit: "b".repeat(40),
      releaseEvidence:
        "Caption search passed all acceptance checks on the live journal. ".repeat(
          3,
        ),
    },
  ];
  snapshot.issues = [{ ...issue, status: "resolved" }];
  snapshot.deliveries.push({
    key: "run-update:run:resolved:verified",
    status: "sent",
  });
  await sendSlackRunUpdate(runId);
  expect(mocks.update.mock.calls[0][3]).toContain("Feature release verified");
  expect(mocks.post).not.toHaveBeenCalled();
});

test("Product cards remove stale decisions only for the reviewed specification and actor", async () => {
  const spec = JSON.stringify({
    specification: "Caption search",
    acceptanceCriteria: ["Find captions"],
  });
  const version = specVersion(spec);
  snapshot.issues = [
    { ...issue, spec, specApprovedAt: 1, specApprovedBy: "Holly" },
  ];
  snapshot.deliveries = [
    {
      key: `spec-approval:issue:${version}`,
      status: "sent",
      receipt: "CENGINEER:120.456",
    },
    { key: `spec-decision:issue:${version}`, status: "sent" },
  ];
  const decision = {
    issueId: "issue" as Id<"issues">,
    version,
    actor: "Holly",
  };
  await sendSpecDecision({ ...decision, actor: "Aria" });
  await sendSpecDecision({ ...decision, version: "changed" });
  expect(mocks.update).not.toHaveBeenCalled();
  await sendSpecDecision(decision);
  expect(mocks.update.mock.calls[0][3]).toContain("Specification approved");
  expect(JSON.stringify(mocks.update.mock.calls[0][4])).not.toContain(
    "cue_spec_approve",
  );
  expect(mocks.post).not.toHaveBeenCalled();
});
