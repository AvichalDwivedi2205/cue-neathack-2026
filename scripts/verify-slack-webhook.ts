import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

nextEnv.loadEnvConfig(process.cwd());
const { api, db, secret } = await import("../lib/server-store");
const { slackConfig } = await import("../lib/integration-config");
const { checkSlack, slackRuntimeStatus } = await import(
  "../lib/integration-checks"
);
const { specVersion } = await import("../lib/slack-messages");
const config = await slackConfig();
assert(config?.signingSecret && config.deliveryMode === "webhook");
assert((await checkSlack(config)).ok);
const health = await slackRuntimeStatus();
assert(health.connected && /HTTPS verified/.test(health.detail));

const marker = process.env.CUE_VERIFY_SLACK_MARKER || "CUE-CLOUD-SLACK-1011";
assert(marker.length >= 10, "Use a unique marker from a real Slack report");
const snapshot = await db().query(api.cue.snapshot, { secret: secret() });
const reports = snapshot.cases.filter(
  (c) => c.channel === "slack" && c.body.includes(marker),
);
assert.equal(reports.length, 1, "Post the marked report through Slack first");
const report = reports[0];
assert(report.sourceKey);
assert(
  report.sourceKey?.startsWith(
    `slack:${config.teamId}:${config.supportChannel}:`,
  ),
);
const messages = snapshot.messages.filter((m) => m.caseId === report._id);
assert.equal(
  messages.filter((m) => m.role === "customer" && m.body.includes(marker))
    .length,
  1,
);
for (const followUp of [
  "CUE-CLOUD-SLACK-FOLLOWUP-1011",
  "CUE-CLOUD-SLACK-HEALTH-1011",
  "CUE-CLOUD-SLACK-AFTER-FIX-1011",
]) {
  assert.equal(
    messages.filter((m) => m.role === "customer" && m.body.includes(followUp))
      .length,
    1,
    "Send each controlled follow-up in the original native Slack thread",
  );
}
assert(
  messages.some(
    (m) => m.role === "note" && m.body.startsWith("Gemini triage suggestion:"),
  ),
);
const replies = snapshot.deliveries.filter(
  (d) =>
    d.key.startsWith(`slack-reply:${report._id}:`) &&
    d.status === "sent" &&
    d.body.includes("CUE-CLOUD-SLACK-REPLY-1011"),
);
assert.equal(replies.length, 1);
assert(replies[0].receipt?.startsWith(`${config.supportChannel}:`));
assert.equal(
  replies[0].destination,
  report.sourceKey.split(":").slice(2).join(":"),
);
assert(messages.some((m) => m.role === "staff" && m.body === replies[0].body));

const issue = snapshot.issues.find((i) => i._id === report.issueId);
assert(issue?.kind === "feature" && issue.spec && issue.status === "approved");
const actor = config.members?.find((m) => m.role === "owner");
assert(actor?.slackId);
assert.equal(issue.specApprovedBy, `${actor.name} · Slack ${actor.slackId}`);
assert(issue.specApprovedAt);
assert.equal(
  issue.specApprovedAt,
  1791662244649,
  "Original native approval time must survive re-triage",
);
const version = specVersion(issue.spec);
assert.equal(
  version,
  "e6f10efcb74657ffbe8a3f18c5f2a1cb5e8bc392c3f372a94e18fa0646ab2494",
);
const review = snapshot.deliveries.filter(
  (d) =>
    d.key === `spec-approval:${issue._id}:${version}` && d.status === "sent",
);
const decision = snapshot.deliveries.filter(
  (d) =>
    d.key === `spec-decision:${issue._id}:${version}` && d.status === "sent",
);
assert.equal(review.length, 1);
assert.equal(decision.length, 1);
assert(review[0].receipt?.startsWith(`${config.engineeringChannel}:`));
assert(decision[0].receipt?.startsWith(`${config.engineeringChannel}:`));
assert(decision[0].body.includes(issue.specApprovedBy));
assert.equal(snapshot.runs.filter((r) => r.issueId === issue._id).length, 0);

const checks = [
  "Current workspace token and both bot channel memberships are verified",
  "HTTPS health reflects a recent persisted, signature-verified support event",
  "Real mention and message deliveries retain one original case and message",
  "All three native follow-ups are stored once in the original conversation",
  "Gemini classification reached the saved report",
  "Dashboard reply has a provider receipt addressed to the original Slack thread",
  "Exact-specification review and Owner decision each have one provider receipt",
  "Product approval records the actual reviewer without starting implementation",
  "Post-fix triage preserves the original approved spec version and decision time",
];
await fs.writeFile(
  ".cue/hosted-slack-verification.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      caseId: report._id,
      sourceUrl: report.sourceUrl,
      issueId: issue._id,
      replyReceipt: replies[0].receipt,
      reviewReceipt: review[0].receipt,
      decisionReceipt: decision[0].receipt,
      webhookLastEventAt: health.updatedAt,
      checks,
      limitations: [
        "Read-only verifier; send the controlled native messages and approve the card first",
        "Provider HTTPS request logs, native card visibility and disabled Socket Mode require separate evidence",
        "Recent delivery is not a continuous liveness or future delivery guarantee",
        "Role denial and replay coverage is in the isolated suite and earlier native role tests",
      ],
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
checks.forEach((check) => console.log("PASS · " + check));
