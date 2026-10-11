import { expect, test, vi } from "vitest";
import {
  approvalMessage,
  supportMessage,
  verifiedSlackFix,
  runMessage,
  specApprovalMessage,
  specVersion,
} from "../lib/slack-messages";
import type { Doc } from "../convex/_generated/dataModel";
const c = {
  _id: "case",
  title: "Upload report",
  priority: "P1",
  status: "open",
  tags: ["photo"],
} as Doc<"cases">;
const issue = {
  title: "Upload failure",
  kind: "bug",
  status: "resolved",
} as Doc<"issues">;
const run = {
  _id: "run",
  status: "resolved",
  phase: "resolved",
  commit: "a".repeat(40),
  verified: true,
  deployed: true,
} as Doc<"runs">;
test.each([
  { ...run, status: "running" },
  { ...run, deployed: false },
  { ...run, verified: false },
  { ...run, commit: undefined },
])(
  "Slack never presents a verified fix without complete deployment evidence: %j",
  (candidate) => {
    expect(verifiedSlackFix(issue, candidate)).toBe(false);
    expect(
      supportMessage("Thanks for the report", c, issue, candidate).text,
    ).not.toContain("Fix verified");
  },
);
test("Slack customer content remains plain text and long replies retain every character", () => {
  const body = "<!channel> <@USER> " + "x".repeat(11000);
  const message = supportMessage(body, c, issue, run);
  const content = message.blocks
    .filter((b) => b.type === "section")
    .map((b) => b.text)
    .filter(Boolean) as Array<{ type: string; text: string }>;
  expect(
    content.every((t) => t.type === "plain_text" && t.text.length <= 3000),
  ).toBe(true);
  expect(
    content
      .slice(1)
      .map((t) => t.text)
      .join(""),
  ).toBe(body);
  expect(message.text).toContain(body);
});
test("Product cards bind exact specification versions and mention only configured reviewer IDs", () => {
  const spec = JSON.stringify({
    need: "Export",
    specification: "Export <!channel> without a ping",
    acceptanceCriteria: ["Select memories", "Preserve photos"],
  });
  const m = specApprovalMessage(
    {
      _id: "feature" as Doc<"issues">["_id"],
      title: "Export",
      spec,
      status: "spec_ready",
    },
    ["UPRODUCT"],
  );
  expect(m.text).toContain("Preserve photos");
  expect(m.text).toContain("does not ship");
  const actionBlock = m.blocks.find((b) => b.type === "actions");
  for (const action of (
    actionBlock?.elements as { value?: string; action_id: string }[]
  ).filter((a) => a.value))
    expect(JSON.parse(action.value!)).toEqual({
      issueId: "feature",
      version: specVersion(spec),
    });
  expect(JSON.stringify(m.blocks)).toContain("<@UPRODUCT>");
  const customerBlock = m.blocks.find((b) =>
    (b.text as { text?: string })?.text?.includes("<!channel>"),
  );
  expect(customerBlock?.text).toMatchObject({ type: "plain_text" });
});
test("approval actions bind full commit and preserve validation in accessible fallback", () => {
  const pending = {
    ...run,
    status: "awaiting_approval",
    after: "3 MB: accepted; 6 MB: rejected",
    rootCause: "Wrong size threshold",
  };
  const m = approvalMessage(pending, "Bloom photo uploads");
  const actions = m.blocks.find((b) => b.type === "actions")
    ?.elements as Array<{
    action_id: string;
    value?: string;
    confirm?: unknown;
  }>;
  for (const a of actions.filter((a) => !a.action_id.startsWith("cue_open_"))) {
    expect(JSON.parse(a.value || "{}")).toEqual({
      runId: "run",
      commit: "a".repeat(40),
    });
    expect(a.confirm).toBeDefined();
  }
  expect(m.text).toContain(pending.after);
  expect(m.text).toContain("a".repeat(40));
  expect(() => approvalMessage(run, "Already deployed")).toThrow("No pending");
});
test("invalid origins and unsafe pull request URLs do not create buttons", () => {
  vi.stubEnv("CUE_PUBLIC_URL", "javascript:alert(1)");
  const m = supportMessage("Reply", c, issue, {
    ...run,
    prUrl: "data:text/html,hello",
  });
  expect(m.blocks.some((b) => b.type === "actions")).toBe(false);
  vi.unstubAllEnvs();
});
test("Slack link actions have distinct IDs within each action block", () => {
  const m = supportMessage("Reply", c, issue, {
    ...run,
    prUrl: "https://github.com/owner/repo/pull/1",
  });
  const actions = m.blocks.find((b) => b.type === "actions")
    ?.elements as Array<{ action_id: string }>;
  expect(new Set(actions.map((a) => a.action_id)).size).toBe(actions.length);
});
test("engineering progress never reports success during deployment", () => {
  const m = runMessage(
    { ...run, status: "running", phase: "deploying", verified: false },
    issue,
  );
  expect(m.text).toContain("verification is still pending");
  expect(m.text).not.toContain("Deployment verified");
  expect(runMessage(run, issue).text).toContain("Deployment verified");
});

test("review cards summarize passing checks without terminal formatting or local paths", () => {
  const m = approvalMessage(
    {
      ...run,
      status: "awaiting_approval",
      after:
        "npm run typecheck\ntsc --noEmit\n\u001b[32mTest Files 17 passed (17)\nTests 141 passed (141)\u001b[0m\n/Users/private/checkout",
    },
    "Caption search",
  );
  expect(m.text).toContain("141 tests passed across 17 files");
  expect(m.text).not.toContain("/Users/");
  expect(JSON.stringify(m.blocks)).not.toContain("\\u001b");
});

test("feature support cards require complete released evidence before showing success", () => {
  const feature = { ...issue, kind: "feature" } as Doc<"issues">;
  const released = {
    ...run,
    kind: "feature",
    releaseCommit: "b".repeat(40),
    releaseEvidence:
      "Independently verified caption search on the deployed journal. ".repeat(
        3,
      ),
  } as Doc<"runs">;
  expect(
    supportMessage("Caption search is available.", c, feature, released).text,
  ).toContain("Feature released");
  expect(
    supportMessage("Specification recorded.", c, feature, {
      ...released,
      releaseEvidence: undefined,
    }).text,
  ).not.toContain("Feature released");
  expect(
    supportMessage("Awaiting deployment.", c, feature, {
      ...released,
      status: "approved",
      deployed: false,
    }).text,
  ).not.toContain("Feature released");
});
