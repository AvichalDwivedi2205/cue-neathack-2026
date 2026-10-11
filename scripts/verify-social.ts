import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { Resend } from "resend";
import { socialSource } from "../lib/social-source";
import { isSocialNotification, normalizeEmail } from "../lib/email-intake";

nextEnv.loadEnvConfig(process.cwd());
const { api, db, secret } = await import("../lib/server-store");
const { emailConfig } = await import("../lib/integration-config");
const { notificationRuntimeStatus } = await import("../lib/integration-checks");
const args = process.argv.slice(2);
assert(
  args.length > 0 && args.length <= 6 && args.length % 3 === 0,
  "Usage: npx tsx scripts/verify-social.ts reddit <actual-comment-url> <marker> [x <actual-post-url> <marker>]",
);
const config = await emailConfig();
assert(
  config?.pollReceiving && config.notificationImport && config.receivingAddress,
);
const snapshot = await db().query(api.cue.snapshot, { secret: secret() });
const checkpoint = JSON.parse(
  await fs.readFile(".cue/notification-poll.json", "utf8"),
) as { processed: string[]; startedAt: number };
const resend = new Resend(config.apiKey);
const checks: string[] = [];
const evidence: {
  channel: string;
  sourceUrl: string;
  caseId: string;
  emailId: string;
  tags: string[];
}[] = [];
const pass = (name: string) => {
  checks.push(name);
  console.log("PASS · " + name);
};
const channels = new Set<string>();
for (let offset = 0; offset < args.length; offset += 3) {
  const [channel, url, marker] = args.slice(offset, offset + 3);
  assert(channel === "x" || channel === "reddit", "Use x or reddit");
  assert(!channels.has(channel), "Verify one fresh report per platform");
  channels.add(channel);
  assert(marker.length >= 5 && marker.length <= 100);
  const source = socialSource(channel, url);
  const cases = snapshot.cases.filter((c) => c.sourceKey === source.key);
  assert.equal(
    cases.length,
    1,
    "Fresh source must have exactly one real Cue case",
  );
  const c = cases[0];
  assert.equal(c.channel, channel);
  assert(c.externalId, "Imported case must retain the actual provider receipt");
  assert(
    c.provenance?.includes("notification email"),
    "Operator capture cannot pass as automatic intake",
  );
  assert(c.body.includes(marker));
  const received = await resend.emails.receiving.get(
    c.externalId,
    {},
    { signal: AbortSignal.timeout(10000) },
  );
  assert(
    received.data && !received.error,
    "Read actual receiving provider receipt",
  );
  const mail = received.data;
  assert(isSocialNotification(mail));
  const recipients = mail.received_for?.length ? mail.received_for : mail.to;
  assert(
    recipients
      .map((r) => r.toLowerCase())
      .includes(config.receivingAddress.toLowerCase()),
  );
  assert(
    Date.parse(mail.created_at) >=
      (config.pollStartedAt ?? checkpoint.startedAt),
  );
  assert(c.createdAt >= Date.parse(mail.created_at));
  assert(mail.text?.includes(marker) || mail.html?.includes(marker));
  pass(
    `${channel}: fresh native notification reached the configured receiving inbox`,
  );

  const report = normalizeEmail(mail, true).reports.find(
    (r) => r.sourceKey === source.key,
  );
  assert(
    report &&
      report.channel === channel &&
      report.transport === "notification_email",
  );
  assert.equal(report.externalId, c.externalId);
  assert.equal(c.sourceUrl, report.sourceUrl);
  assert(
    checkpoint.processed.includes(c.externalId),
    "Background worker must checkpoint the provider event",
  );
  pass(
    `${channel}: background polling created one case with the real permalink and email receipt`,
  );

  const messages = snapshot.messages.filter((m) => m.caseId === c._id);
  assert.equal(
    messages.filter((m) => m.role === "customer" && m.body.includes(marker))
      .length,
    1,
  );
  assert(
    messages.some(
      (m) =>
        m.role === "note" && m.body.startsWith("Gemini triage suggestion:"),
    ),
  );
  assert(
    c.tags.some((t) => /search/i.test(t)) &&
      c.tags.some((t) => /caption/i.test(t)),
  );
  assert.equal(new Set(c.tags.map((t) => t.toLowerCase())).size, c.tags.length);
  const issue = snapshot.issues.find((i) => i._id === c.issueId);
  assert.equal(issue?.kind, "feature");
  pass(
    `${channel}: caption-search request retains classification, tags and Gemini triage without duplicate customer messages`,
  );
  evidence.push({
    channel,
    sourceUrl: c.sourceUrl!,
    caseId: c._id,
    emailId: c.externalId,
    tags: c.tags,
  });
  // Stay below the receiving provider's request-rate limit for the next target.
  if (offset + 3 < args.length)
    await new Promise((resolve) => setTimeout(resolve, 600));
}
assert(
  (await notificationRuntimeStatus()).connected,
  "Persistent notification worker remains healthy",
);
pass("Notification worker remains connected after subsequent polling cycles");
await fs.writeFile(
  ".cue/social-verification.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      checks,
      evidence,
      uncheckedPlatforms: ["x", "reddit"].filter((c) => !channels.has(c)),
      limits: [
        "Only emailed notifications are collected; platform coverage and timing vary",
        "Email content and post authors remain unverified",
        "Public visibility and social reply delivery require separate native-browser checks",
      ],
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  `${checks.length} live social intake checks passed for ${[...channels].join(", ")}.`,
);
