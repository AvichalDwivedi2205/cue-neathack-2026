import { expectedFailure } from "./expected-failure";
import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
nextEnv.loadEnvConfig(process.cwd());
const { api, db, secret } = await import("../lib/server-store");
const { slackConfig } = await import("../lib/integration-config");
const { checkSlack, slackRuntimeStatus } = await import(
  "../lib/integration-checks"
);
const { receiveSlack, decideSlack } = await import("../lib/slack-events");
const { sendSlackRunUpdate } = await import("../lib/delivery");
const config = await slackConfig();
assert(config?.appToken, "Connect Slack Socket Mode first");
const checks: string[] = [];
const pass = (name: string) => {
  checks.push(name);
  console.log("PASS · " + name);
};
assert((await checkSlack(config)).ok);
assert((await slackRuntimeStatus()).connected);
pass(
  "Live workspace token, both bot channel memberships and Socket Mode connection",
);
assert.equal((await fs.stat(".cue/integrations.enc")).mode & 0o777, 0o600);
pass("Saved credentials remain in private encrypted storage");
const snapshot = await db().query(api.cue.snapshot, { secret: secret() });
const marker = process.env.CUE_SLACK_VERIFY_MARKER || "CUE-SLACK-1010";
const cases = snapshot.cases.filter(
  (c) => c.channel === "slack" && c.body.includes(marker),
);
assert.equal(
  cases.length,
  1,
  "Send exactly one marked Slack report through Slack UI",
);
const c = cases[0];
const messages = snapshot.messages.filter((m) => m.caseId === c._id);
assert.equal(
  messages.filter((m) => m.role === "customer" && m.body.includes(marker))
    .length,
  1,
);
pass(
  "Message and mention events create one case and one original customer message",
);
assert.equal(
  messages.filter(
    (m) => m.role === "customer" && m.body.includes("CUE-SLACK-FOLLOWUP-1010"),
  ).length,
  1,
);
pass("Live threaded follow-up appends once to the original case");
const featureCase = snapshot.cases.find(
  (c) => c.channel === "slack" && c.body.includes("CUE-FEATURE-1010"),
);
assert(featureCase, "Send the controlled feature request through Slack UI");
const featureMessages = snapshot.messages.filter(
  (m) => m.caseId === featureCase._id,
);
assert.equal(
  featureMessages.filter(
    (m) =>
      m.role === "customer" && m.body.startsWith("CUE-SLACK-RECONNECT-1010:"),
  ).length,
  1,
);
const featureReply = snapshot.deliveries.find(
  (d) =>
    d.key.startsWith(`slack-reply:${featureCase._id}:`) && d.status === "sent",
);
assert(featureReply);
assert(featureReply.receipt?.startsWith(config.supportChannel + ":"));
assert(
  featureMessages.some(
    (m) => m.role === "staff" && m.body === featureReply.body,
  ),
);
pass(
  "Feature reply is delivered and fresh post-restart follow-up reaches its original conversation once",
);
assert(c.tags.includes("integration-check"));
pass("Operator tag survives reload in Convex");
const delivery = snapshot.deliveries.find(
  (d) => d.key.startsWith(`slack-reply:${c._id}:`) && d.status === "sent",
);
assert(delivery);
assert(delivery.receipt?.startsWith(config.supportChannel + ":"));
assert(messages.some((m) => m.role === "staff" && m.body === delivery.body));
pass(
  "Composed reply has a Slack provider receipt and a persisted staff message",
);
const verifiedRun = snapshot.runs
  .filter((r) => r.issueId === c.issueId)
  .sort((a, b) => b.createdAt - a.createdAt)[0];
assert(
  verifiedRun?.status === "resolved" &&
    verifiedRun.deployed &&
    verifiedRun.verified,
);
await sendSlackRunUpdate(verifiedRun._id);
await sendSlackRunUpdate(verifiedRun._id);
const refreshed = await db().query(api.cue.snapshot, { secret: secret() });
const updates = refreshed.deliveries.filter(
  (d) => d.key === `run-update:${verifiedRun._id}:resolved:resolved`,
);
assert.equal(updates.length, 1);
assert.equal(updates[0].status, "sent");
assert(updates[0].receipt?.startsWith(config.engineeringChannel + ":"));
pass(
  "Actual verified deployment card is accepted in engineering and repeated publication is deduplicated",
);
const acknowledged = snapshot.cases.find(
  (c) => c.channel === "slack" && c.body.includes("CUE-SLACK-ACK-1010"),
);
assert(acknowledged);
assert(
  snapshot.messages.some(
    (m) =>
      m.caseId === acknowledged._id &&
      m.role === "draft" &&
      /deployed and verified|passed our upload tests/.test(m.body),
  ),
);
pass(
  "Controlled ordinary channel intake retains its verified resolution draft",
);
const input = {
  team_id: config.teamId,
  event: {
    type: "message",
    channel: config.supportChannel,
    user: config.operatorIds[0],
    ts: "1.000001",
    text: "verification gate",
  },
};
await assert.rejects(
  () => receiveSlack({ ...input, team_id: "TWRONG" }, config),
  expectedFailure(/Wrong Slack workspace/),
);
assert.equal(
  await receiveSlack(
    { ...input, event: { ...input.event, channel: config.engineeringChannel } },
    config,
  ),
  null,
);
assert.equal(
  await receiveSlack(
    { ...input, event: { ...input.event, bot_id: "BTEST" } },
    config,
  ),
  null,
);
pass(
  "Wrong workspace, engineering chatter and bot messages cannot enter support intake",
);
const run = snapshot.runs.find(
  (r) => r.status === "resolved" && r.commit && r.verified && r.deployed,
);
assert(run?.commit);
const interaction = {
  team: { id: config.teamId },
  channel: { id: config.engineeringChannel },
  user: { id: config.operatorIds[0] },
  actions: [
    {
      action_id: "cue_approve",
      value: JSON.stringify({ runId: run._id, commit: run.commit }),
    },
  ],
};
await assert.rejects(
  () => decideSlack({ ...interaction, user: { id: "UUNAUTHORIZED" } }, config),
  expectedFailure(/Operator not authorized/),
);
await assert.rejects(
  () =>
    decideSlack(
      { ...interaction, channel: { id: config.supportChannel } },
      config,
    ),
  expectedFailure(/Operator not authorized/),
);
await assert.rejects(
  () => decideSlack(interaction, config),
  expectedFailure(/pending commit/),
);
pass(
  "Unauthorized operators, wrong approval channels and resolved commit replay are denied",
);
await fs.writeFile(
  ".cue/slack-verification.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      caseId: c._id,
      sourceUrl: c.sourceUrl,
      receipt: delivery.receipt,
      checks,
      browserEvidence: [
        "artifacts/slack-polished-reply.jpg",
        "artifacts/slack-engineering-result.jpg",
        "artifacts/slack-feature-reply.jpg",
        "artifacts/slack-live-reconnect-cue.jpg",
      ],
      approvalCoverage:
        "Gateway lifecycle isolation and live denial/replay checks. The separate caption-search feature also passed Ganesh's native exact-commit approval, merge and local release verification; see feature-release-verification.json.",
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(`${checks.length} live Slack checks passed.`);
