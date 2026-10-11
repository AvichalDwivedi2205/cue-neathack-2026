import nextEnv from "@next/env";
import assert from "node:assert/strict";
import type { FunctionReturnType } from "convex/server";
import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import { photo } from "../demo/bloom/fixture.mjs";
import { validSlack } from "../lib/slack";
import { replyProblems, socialReplyLength } from "../lib/reply-policy";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
nextEnv.loadEnvConfig(process.cwd());
const { db, api, secret } = await import("../lib/server-store");
const workos = !!(
  process.env.WORKOS_API_KEY &&
  process.env.WORKOS_CLIENT_ID &&
  process.env.WORKOS_COOKIE_PASSWORD
);
const base = process.env.CUE_VERIFY_ORIGIN || "http://127.0.0.1:3000",
  checks: string[] = [];
const check = (name: string) => {
  checks.push(name);
  console.log("PASS · " + name);
};
const post = (path: string, body: unknown, cookie = "") =>
  fetch(base + path, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
const operatorResponse = await fetch(base + "/api/demo");
if (workos) {
  assert.equal(operatorResponse.status, 401);
  check("WorkOS rejects unauthenticated operator HTTP access");
}
const snapshot = async (): Promise<
  FunctionReturnType<typeof api.cue.snapshot>
> =>
  workos
    ? db().query(api.cue.snapshot, { secret: secret() })
    : (await fetch(base + "/api/demo")).json();
const s = await snapshot();
assert.ok(s.cases?.length);
check(
  workos
    ? "Trusted server can read the Convex backend"
    : "Operator backend reachable",
);
const uploadIssue = s.issues.find((i) => i.fingerprint === "bloom:upload:413");
const run = s.runs.find(
  (r) => r.issueId === uploadIssue?._id && r.status === "resolved",
);
assert.ok(run?.verified && run.deployed && run.commit);
check("A real run has deployed and verified evidence");
const health = base.startsWith("https:")
  ? (await (await fetch(base + "/api/bloom")).json()).health
  : await (await fetch("http://127.0.0.1:4318/health")).json();
assert.equal(health.build, run.commit);
assert.equal(health.maxUploadBytes, 5 * 1024 * 1024);
check("Active upload release equals the approved commit");
const a = await fetch(base + "/api/bloom"),
  cookieA = a.headers.get("set-cookie")!.split(";")[0],
  stateA = await a.json();
const b = await fetch(base + "/api/bloom"),
  cookieB = b.headers.get("set-cookie")!.split(";")[0];
assert.notEqual(cookieA, cookieB);
assert.deepEqual(stateA.memories, []);
check("Fresh customer sessions have separate journals");
const form = new FormData();
form.append(
  "file",
  new File([photo(3 * 1024 * 1024)], "verified-3mb.png", { type: "image/png" }),
);
const upload = await fetch(base + "/api/bloom", {
  method: "POST",
  headers: { origin: base, cookie: cookieA },
  body: form,
});
assert.equal(upload.status, 201);
const file = await upload.json();
check("Customer gateway accepts an actual valid 3 MB PNG");
const large = new FormData();
large.append(
  "file",
  new File([photo(6 * 1024 * 1024)], "control-6mb.png", { type: "image/png" }),
);
assert.equal(
  (
    await fetch(base + "/api/bloom", {
      method: "POST",
      headers: { origin: base, cookie: cookieA },
      body: large,
    })
  ).status,
  413,
);
check("Customer gateway rejects the valid 6 MB control");
const memory = {
  title: "Verification fixture",
  caption: "Isolated test session",
  date: "2026-10-10",
  w: file.w,
  h: file.h,
  fileId: file.fileId,
};
assert.equal(
  (
    await post(
      "/api/bloom",
      { action: "save", memory: { ...memory, date: "2026-02-30" } },
      cookieA,
    )
  ).status,
  400,
);
check("Nonexistent calendar dates are rejected through the customer gateway");
assert.equal(
  (await post("/api/bloom", { action: "save", memory }, cookieB)).status,
  400,
);
check("Another customer cannot claim this uploaded photo");
const saved = await post("/api/bloom", { action: "save", memory }, cookieA);
assert.equal(saved.status, 200);
const { id } = await saved.json();
assert.equal(
  (await post("/api/bloom", { action: "delete", id }, cookieB)).status,
  400,
);
assert.equal(
  (
    await post(
      "/api/bloom",
      {
        action: "save",
        memory: { ...memory, id, owner: cookieA.split("=")[1].split(".")[0] },
      },
      cookieB,
    )
  ).status,
  400,
);
check("Owner spoofing and cross-customer writes are rejected");
await post("/api/bloom", { action: "delete", id }, cookieA);
let own = await (
  await fetch(base + "/api/bloom", { headers: { cookie: cookieA } })
).json();
assert.equal(own.memories.length, 0);
await post("/api/bloom", { action: "delete", id, undo: true }, cookieA);
own = await (
  await fetch(base + "/api/bloom", { headers: { cookie: cookieA } })
).json();
assert.equal(own.memories.length, 1);
check("Soft deletion and undo persist through HTTP reload");
await post("/api/bloom", { action: "delete", id }, cookieA);
assert.equal(
  (
    await fetch(base + "/api/demo", {
      method: "POST",
      headers: {
        origin: "https://untrusted.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "reset" }),
    })
  ).status,
  400,
);
check("Cross-origin operator mutation is rejected");
const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
  (base.startsWith("https:") ? httpsRequest : httpRequest)(
    base + "/api/demo",
    {
      headers: { host: "untrusted.invalid" },
      ...(base.startsWith("https:")
        ? { servername: new URL(base).hostname }
        : {}),
    },
    (r) => {
      r.resume();
      resolve(r.statusCode);
    },
  )
    .on("error", reject)
    .end();
});
if (base.startsWith("https:"))
  assert([400, 401, 403, 404].includes(hostStatus || 0));
else assert.equal(hostStatus, 401);
check(
  workos
    ? "Unauthenticated forged-host requests remain denied"
    : "Local operator fallback rejects non-local hosts",
);
const replayArgs = {
  action: "approve",
  runId: run._id,
  commit: run.commit,
};
if (workos) {
  await assert.rejects(() =>
    db().mutation(api.jobs.decide, {
      secret: secret(),
      runId: run._id,
      commit: run.commit!,
      actor: "Verification",
      approve: true,
    }),
  );
} else {
  assert.equal((await post("/api/demo", replayArgs)).status, 400);
}
check("Resolved approvals cannot be replayed");
const sample = s.cases.find(
  (c: { sourceKey?: string }) => c.sourceKey === "x:9990000000000000001",
);
assert.ok(sample);
const dedupArgs = {
  action: "report",
  channel: "x",
  customer: sample.customer,
  title: sample.title,
  body: sample.body,
  sourceUrl: sample.sourceUrl,
};
const dedup = workos
  ? {
      id: await db().mutation(api.cue.createCase, {
        secret: secret(),
        title: dedupArgs.title,
        body: dedupArgs.body,
        channel: dedupArgs.channel,
        customer: dedupArgs.customer,
        sourceUrl: dedupArgs.sourceUrl,
        sourceKey: sample.sourceKey,
        sample: true,
      }),
    }
  : await (await post("/api/demo", dedupArgs)).json();
assert.equal(dedup.id, sample._id);
const again = await snapshot();
assert.equal(
  again.cases.filter(
    (c: { sourceKey?: string }) => c.sourceKey === sample.sourceKey,
  ).length,
  1,
);
check("Repeated X post capture reuses the original case");
assert.equal(
  (await fetch(base + "/api/webhooks/slack", { method: "POST", body: "{}" }))
    .status,
  401,
);
const timestamp = String(Math.floor(Date.now() / 1000)),
  body = '{"type":"event_callback"}',
  sig =
    "v0=" +
    createHmac("sha256", "test-only-secret")
      .update(`v0:${timestamp}:${body}`)
      .digest("hex");
assert.ok(validSlack(body, timestamp, sig, "test-only-secret"));
assert.ok(!validSlack(body + "tampered", timestamp, sig, "test-only-secret"));
assert.ok(!validSlack(body, "1", sig, "test-only-secret"));
check("Slack signature, tamper and replay controls");
await assert.rejects(() => db().query(api.cue.snapshot, { secret: "invalid" }));
check("Direct Convex access requires server authorization");
const { draft } = await import("../lib/gemini");
const replyContext = {
  channel: "x",
  case: sample,
  issue: s.issues.find((i) => i._id === sample.issueId),
  run: s.runs
    .filter((r) => r.issueId === sample.issueId)
    .sort((a, b) => b.createdAt - a.createdAt)[0],
  messages: s.messages.filter((m) => m.caseId === sample._id),
};
const reply = await draft(replyContext);
assert.ok(reply.length && socialReplyLength(reply) <= 280);
assert.deepEqual(replyProblems(reply, replyContext), []);
check("Live Vertex Gemini returns a bounded X brand draft");
await fs.mkdir(".cue", { recursive: true });
await fs.writeFile(
  base.startsWith("https:")
    ? ".cue/hosted-verification.json"
    : ".cue/verification.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      origin: base,
      commit: run.commit,
      prUrl: run.prUrl,
      checks,
      operatorMode: workos
        ? "WorkOS HTTP access control; server-only Convex checks; authenticated UI verified separately"
        : "loopback local operator",
      integrationLimits: [
        "Slack and support email live checks are recorded by verify-slack.ts and verify-email.ts",
        "Native social intake evidence is recorded separately by verify-social.ts",
        "Reddit public reply was removed by moderation",
        "Branded sender delivery is checked separately by verify-email.ts",
      ],
    },
    null,
    2,
  ),
);
console.log(`${checks.length} checks passed against ${base}.`);
