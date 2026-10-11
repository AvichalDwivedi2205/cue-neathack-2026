import { expectedFailure } from "./expected-failure";
import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
nextEnv.loadEnvConfig(process.cwd());
const { slackConfig } = await import("../lib/integration-config");
const { api, db, secret } = await import("../lib/server-store");
const { decideSlack } = await import("../lib/slack-events");
const { specVersion } = await import("../lib/slack-messages");
const { reviewers, membersInput } = await import("../lib/roles");
const config = await slackConfig();
assert(config?.members, "Save team roles first");
const checks: string[] = [];
const pass = (name: string) => {
  checks.push(name);
  console.log(`PASS · ${name}`);
};
const product = config.members.find((m) => m.role === "product");
const engineering = config.members.find((m) => m.role === "engineering");
const support = config.members.find((m) => m.role === "support");
membersInput.parse(config.members);
assert(product?.slackId, "Connect Product's real Slack member ID");
assert.equal(
  config.members.find((m) => m.email === process.env.CUE_OPERATOR_EMAIL)?.role,
  "owner",
);
assert.deepEqual(reviewers(config, "spec"), [product.slackId]);
pass(
  "Current server membership routes Product review to the connected Product identity",
);
const snapshot = await db().query(api.cue.snapshot, { secret: secret() });
const c = snapshot.cases.find(
  (c) => c.channel === "slack" && c.body.includes("CUE-PRODUCT-ROLE-1010"),
);
assert(c, "Send the marked live Slack feature report");
assert.equal(c.customer, `Slack ${product.slackId}`);
const issue = snapshot.issues.find((i) => i._id === c.issueId);
assert(
  issue?.spec &&
    issue.kind === "feature" &&
    ["approved", "resolved"].includes(issue.status),
);
assert.equal(
  issue.specApprovedBy,
  `${product.name} · Slack ${product.slackId}`,
);
assert(issue.specApprovedAt);
pass(
  "Live Slack intake and native Product approval retain the exact reviewer in Convex",
);
const version = specVersion(issue.spec);
for (const prefix of ["spec-approval", "spec-decision"]) {
  const deliveries: typeof snapshot.deliveries = snapshot.deliveries.filter(
    (d) => d.key === `${prefix}:${issue._id}:${version}`,
  );
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, "sent");
  assert(deliveries[0].receipt?.startsWith(config.engineeringChannel + ":"));
}
pass(
  "Exact-version review and threaded decision each have one Slack provider receipt",
);
const featureRuns = snapshot.runs.filter((r) => r.issueId === issue._id);
if (!featureRuns.length) {
  pass("Specification approval has no coding run or deployment");
} else {
  for (const run of featureRuns) {
    assert.equal(run.kind, "feature");
    assert.equal(run.approvedSpec, issue.spec);
    assert(run.createdAt >= issue.specApprovedAt!);
  }
  pass(
    "Later coding runs remain bound to the exact Product-approved specification and approval time",
  );
  if (issue.status === "resolved") {
    const released = featureRuns
      .filter((r) => r.status === "resolved")
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    assert(
      released?.deployed &&
        released.verified &&
        released.releaseCommit &&
        released.releaseEvidence,
    );
    assert.equal(
      released.approval,
      `${engineering?.name} · Slack ${engineering?.slackId}`,
    );
    pass(
      "Released feature retains the actual Engineering reviewer plus deployed acceptance evidence",
    );
  }
}
const payload = {
  team: { id: config.teamId },
  channel: { id: config.engineeringChannel },
  user: { id: product.slackId },
  actions: [
    {
      action_id: "cue_spec_approve",
      value: JSON.stringify({ issueId: issue._id, version }),
    },
  ],
};
await assert.rejects(
  () => decideSlack(payload, config),
  expectedFailure(/pending specification/),
);
await assert.rejects(
  () =>
    decideSlack(
      {
        ...payload,
        actions: [
          {
            action_id: "cue_approve",
            value: JSON.stringify({ runId: "unused", commit: "a".repeat(40) }),
          },
        ],
      },
      config,
    ),
  expectedFailure(/not authorized/),
);
pass(
  "Repeated native decision and Product deployment attempt are denied without side effects",
);
if (engineering?.slackId && support?.slackId) {
  assert.deepEqual(reviewers(config, "deploy"), [engineering.slackId]);
  assert.equal(new Set(config.members.map((m) => m.slackId)).size, 4);
  assert.equal(new Set(config.members.map((m) => m.email)).size, 4);
  pass(
    "Four distinct saved identities route Engineering and Product reviews separately",
  );
  for (const member of [engineering, support])
    await assert.rejects(
      () => decideSlack({ ...payload, user: { id: member.slackId } }, config),
      expectedFailure(/not authorized/),
    );
  await assert.rejects(
    () =>
      decideSlack(
        {
          ...payload,
          user: { id: support.slackId },
          actions: [
            {
              action_id: "cue_approve",
              value: JSON.stringify({
                runId: "unused",
                commit: "a".repeat(40),
              }),
            },
          ],
        },
        config,
      ),
    expectedFailure(/not authorized/),
  );
  const after = await db().query(api.cue.snapshot, { secret: secret() });
  assert.equal(
    after.issues.find((i) => i._id === issue._id)?.specApprovedBy,
    issue.specApprovedBy,
  );
  assert.equal(after.runs.length, snapshot.runs.length);
  pass(
    "Actual Engineering and Support IDs cannot overwrite Product approval or start an unauthorized deployment",
  );
}
const members = config.members.map(({ name, role, slackId }) => ({
  name,
  role,
  slackConnected: !!slackId,
}));
await fs.writeFile(
  ".cue/team-verification.json",
  JSON.stringify(
    {
      at: new Date().toISOString(),
      checks,
      caseId: c._id,
      issueId: issue._id,
      reviewer: product.name,
      members,
    },
    null,
    2,
  ),
);
console.log(
  `${checks.length} live team checks passed. Pending Slack identities: ${
    members
      .filter((m) => !m.slackConnected)
      .map((m) => m.name)
      .join(", ") || "none"
  }.`,
);
