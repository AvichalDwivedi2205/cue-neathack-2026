import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { Resend } from "resend";

nextEnv.loadEnvConfig(process.cwd());
const { emailConfig } = await import("../lib/integration-config");
const { api, db, secret } = await import("../lib/server-store");
const origin = new URL(
  process.env.CUE_VERIFY_ORIGIN ||
    "https://cue-987049542259.us-central1.run.app",
).origin;
const marker = process.env.CUE_VERIFY_EMAIL_MARKER || "CUE-CLOUD-INTAKE-1011";
assert(
  marker.length >= 10,
  "Use a unique marker for an actual controlled email",
);
const config = await emailConfig();
assert(config?.webhookSecret && config.supportReceivingAddress);
const resend = new Resend(config.apiKey);
const hooks = await resend.webhooks.list({ limit: 100 });
assert(hooks.data && !hooks.error);
const hook = hooks.data.data.find(
  (h) => h.endpoint === origin + "/api/webhooks/email",
);
assert(hook?.status === "enabled");
const state = await db().query(api.cue.snapshot, { secret: secret() });
const reports = state.cases.filter(
  (c) => c.channel === "email" && c.title.includes(marker),
);
assert.equal(reports.length, 1, "Send one uniquely marked real email first");
const report = reports[0];
assert(report.externalId);
assert.equal(
  state.messages.filter((m) => m.caseId === report._id && m.role === "customer")
    .length,
  1,
);

const events = await resend.webhooks.events.list({
  webhookId: hook.id,
  limit: 100,
});
assert(events.data && !events.error);
let matched;
for (const event of events.data.data) {
  await new Promise((resolve) => setTimeout(resolve, 600));
  const got = await resend.webhooks.events.get({
    webhookId: hook.id,
    eventId: event.id,
  });
  if (
    got.data?.payload.type === "email.received" &&
    got.data.payload.data.email_id === report.externalId
  ) {
    matched = got.data;
    break;
  }
}
assert(matched?.status === "success", "Actual provider event must succeed");
const attempts = await resend.webhooks.events.attempts.list({
  webhookId: hook.id,
  eventId: matched.id,
});
assert(attempts.data && !attempts.error);
const imported = attempts.data.data.some(
  (a) => a.http_status_code === 200 && JSON.parse(a.response).imported === 1,
);
assert(imported, "Hosted webhook must have imported the report before ACK");
const replayDeduplicated = attempts.data.data.some(
  (a) => a.http_status_code === 200 && JSON.parse(a.response).imported === 0,
);
assert(replayDeduplicated, "Replay the actual event in Resend before checking");
const classified = state.messages.some(
  (m) =>
    m.caseId === report._id &&
    m.role === "note" &&
    m.body.startsWith("Gemini triage suggestion:"),
);
assert(classified, "Hosted classification must have reached the stored case");
const delivery = state.deliveries
  .filter(
    (d) => d.key.startsWith(`email:${report._id}:`) && d.status === "sent",
  )
  .sort((a, b) => b.createdAt - a.createdAt)[0];
assert(delivery?.receipt, "Send a reviewed reply from the dashboard first");
const sent = await resend.emails.get(delivery.receipt);
assert(sent.data && !sent.error);
assert.equal(sent.data.from, config.from);
assert(sent.data.to.includes(report.customer));
assert(["delivered", "opened", "clicked"].includes(sent.data.last_event));

const checks = [
  "An enabled receiving webhook points at the selected hosted origin",
  "A real provider event matches the single marked customer case",
  "Hosted intake persisted before HTTP 200 acknowledgment",
  "An actual provider replay was deduplicated",
  "Gemini classification is present in the stored case",
  "A reviewed dashboard reply has a delivered provider receipt",
];
await fs.writeFile(
  ".cue/hosted-email-webhook-verification.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      origin,
      caseId: report._id,
      eventId: matched.id,
      receipt: delivery.receipt,
      checks,
      limits: [
        "Read-only checks; this verifier does not send email or pause workers",
        "Native Gmail visibility and worker isolation need separate evidence",
        "Does not establish X or Reddit native notification delivery",
      ],
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
checks.forEach((check) => console.log("PASS " + check));
