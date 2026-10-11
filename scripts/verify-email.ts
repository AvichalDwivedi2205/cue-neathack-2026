import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { Resend } from "resend";
nextEnv.loadEnvConfig(process.cwd());
const { api, db, secret } = await import("../lib/server-store");
const { emailConfig } = await import("../lib/integration-config");
const { notificationRuntimeStatus } = await import("../lib/integration-checks");
const config = await emailConfig();
assert(config?.supportReceivingAddress && config.pollReceiving);
const snapshot = await db().query(api.cue.snapshot, { secret: secret() });
const cases = snapshot.cases.filter(
  (c) => c.channel === "email" && c.title.includes("CUE-EMAIL-1010"),
);
assert.equal(
  cases.length,
  1,
  "Send a controlled CUE-EMAIL-1010 report to the support inbox first",
);
const c = cases[0],
  messages = snapshot.messages.filter((m) => m.caseId === c._id);
assert.equal(c.customer, process.env.CUE_OPERATOR_EMAIL);
assert(c.sourceKey?.startsWith("email:"));
assert.equal(
  messages.filter(
    (m) =>
      m.role === "customer" &&
      m.body.startsWith("Controlled end-to-end support test."),
  ).length,
  1,
);
assert.equal(
  messages.filter(
    (m) =>
      m.role === "customer" && m.body.startsWith("CUE-EMAIL-FOLLOWUP-1010:"),
  ).length,
  1,
);
const receipt = snapshot.deliveries
  .filter((d) => d.key.startsWith(`email:${c._id}:`) && d.status === "sent")
  .sort((a, b) => b.createdAt - a.createdAt)[0];
assert(receipt?.receipt);
assert(messages.some((m) => m.role === "staff" && m.body === receipt.body));
const resend = new Resend(config.apiKey);
const sent = await resend.emails.get(receipt.receipt);
assert(!sent.error && sent.data, "Read the actual outbound provider receipt");
assert(
  ["delivered", "opened", "clicked"].includes(sent.data.last_event),
  `Provider delivery is ${sent.data.last_event}`,
);
assert(sent.data.to.includes(c.customer));
assert.equal(sent.data.from, config.from);
const incoming = await resend.emails.receiving.get(c.externalId!);
assert(incoming.data && !incoming.error);
assert(incoming.data.to.includes(config.supportReceivingAddress));
const branded = config.from !== "onboarding@resend.dev";
assert(
  incoming.data.text?.includes(
    branded ? "CUE-BRANDED-FOLLOWUP-1010" : "CUE-EMAIL-FOLLOWUP-1010",
  ),
);
if (branded) {
  assert.equal(
    messages.filter(
      (m) =>
        m.role === "customer" &&
        m.body.startsWith("CUE-BRANDED-FOLLOWUP-1010:"),
    ).length,
    1,
  );
}
assert((await notificationRuntimeStatus()).connected);
const checks = [
  "Real support email automatically creates one case for the expected sender",
  "Customer follow-up appends once to the same RFC email thread",
  "Cue reply has a persisted provider receipt and conversation message",
  "Resend confirms delivered status to the actual Gmail test recipient",
  "Received follow-up is addressed to the configured separate support inbox",
  "Persistent inbox poller remains connected",
];
checks.forEach((c) => console.log("PASS · " + c));
await fs.writeFile(
  ".cue/email-verification.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      caseId: c._id,
      receipt: receipt.receipt,
      providerStatus: sent.data.last_event,
      sender: sent.data.from,
      checks,
      browserEvidence: branded
        ? [
            "artifacts/email-branded-delivered.jpg",
            "artifacts/email-branded-followup-cue.jpg",
          ]
        : [
            "artifacts/email-live-delivered.jpg",
            "artifacts/email-live-followup-cue.jpg",
          ],
      limits: [
        ...(config.from === "onboarding@resend.dev"
          ? [
              "Provider test sender reaches the configured operator only",
              "Branded sender has not been tested",
            ]
          : [
              "Branded reply delivery verified to the owned Gmail test recipient",
            ]),
        "Platform notification coverage is checked separately by scripts/verify-social.ts",
      ],
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(`${checks.length} live email checks passed.`);
