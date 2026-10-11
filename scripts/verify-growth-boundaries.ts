import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
nextEnv.loadEnvConfig(process.cwd());
const { api, db, secret } = await import("../lib/server-store");
const origin = process.env.CUE_VERIFY_ORIGIN;
const release = process.env.CUE_VERIFY_RELEASE;
const appId = process.env.CUE_GROWTH_APP;
assert(origin?.startsWith("https:") && release && appId);
const key = (
  await fs.readFile(
    process.env.CUE_EVENT_KEY_FILE || ".cue/growth-event-key.txt",
    "utf8",
  )
).trim();
const before = await db().query(api.growth.snapshot, {
  secret: secret(),
  appId,
});
const touch = before.touches.find((t) => t.status !== "verified");
assert(touch, "Run before the controlled touch has a verified publication");
const token = new URL(touch.link).pathname.split("/").at(-1)!;
const checks: string[] = [];
const pass = (name: string) => {
  checks.push(name);
  console.log("PASS · " + name);
};
const health = await (await fetch(origin + "/api/bloom")).json();
assert.equal(health.health.release, release);
pass("Actual public Cue gateway identifies the expected release");
for (const route of [
  "/api/growth",
  "/api/agents",
  "/api/integrations",
  "/api/demo",
])
  assert.equal((await fetch(origin + route)).status, 401, route);
pass("Operator Growth, agents, configuration and workspace require sign-in");
for (const link of [touch.link, origin + "/g/modified.invalid"])
  assert.equal((await fetch(link, { redirect: "manual" })).status, 410);
pass(
  "Unpublished and forged campaign links cannot redirect or create visitors",
);
const exchange = { action: "exchange", appId, token };
async function rejected(
  body: object,
  timestamp = String(Date.now()),
  signingKey = key,
) {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", signingKey)
    .update(timestamp + "." + raw)
    .digest("hex");
  const response = await fetch(origin + "/api/growth/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cue-timestamp": timestamp,
      "x-cue-signature": signature,
    },
    body: raw,
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Signed app event rejected",
  });
}
await rejected(exchange);
await rejected(exchange, String(Date.now()), "wrong-app-event-key");
await rejected(exchange, String(Date.now() - 600000));
await rejected(exchange, String(Date.now() + 600000));
await rejected({ ...exchange, appId: "unregistered-app" });
await rejected({
  ...exchange,
  token: token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"),
});
await rejected({
  ...exchange,
  caption: "Private journal contents must never enter telemetry",
});
pass(
  "Unpublished, wrong-key/app, stale/future, modified and private-data exchanges are denied",
);
const after = await db().query(api.growth.snapshot, {
  secret: secret(),
  appId,
});
for (const field of ["browsers", "events", "drafts", "opportunities"] as const)
  assert.deepEqual(
    after[field].map((v) => v._id).sort(),
    before[field].map((v) => v._id).sort(),
  );
pass(
  "Rejected public requests preserve saved work and create no attribution events",
);
await fs.writeFile(
  process.env.CUE_VERIFY_OUTPUT || ".cue/growth-boundaries.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      origin,
      release,
      appId,
      checks,
      touchId: touch._id,
      touchStatus: touch.status,
      limitation:
        "Negative public gateway checks. Actual Slack approval, native publication and attributed save/search are separate acceptance steps.",
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
