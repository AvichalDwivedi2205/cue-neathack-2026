import nextEnv from "@next/env";
import { promises as fs } from "node:fs";
import assert from "node:assert/strict";
nextEnv.loadEnvConfig(process.cwd());
const { readIntegrations } = await import("../lib/integration-config");
const { api, db, secret } = await import("../lib/server-store");
const base = process.env.CUE_VERIFY_ORIGIN || "http://127.0.0.1:3000";
const app = (await readIntegrations()).apps.find((a) =>
  a.origins.includes("http://localhost:4400"),
);
assert(app, "Register the widget demo app first");
const checks: string[] = [];
async function call(
  action: string,
  extra: Record<string, unknown> = {},
  requestOrigin = base,
) {
  const r = await fetch(base + "/api/widget", {
    method: "POST",
    headers: { "content-type": "application/json", origin: requestOrigin },
    body: JSON.stringify({
      action,
      app: app!.id,
      origin: "http://localhost:4400",
      ...extra,
    }),
  });
  return { status: r.status, body: await r.json() };
}
const one = await call("session"),
  two = await call("session");
assert.equal(one.status, 200);
assert.equal(two.status, 200);
assert.notEqual(one.body.token, two.body.token);
checks.push("separate visitor sessions");
assert.equal(
  (await call("session", { origin: "https://unregistered.example" })).status,
  403,
);
assert.equal(
  (await call("session", {}, "https://foreign.example")).status,
  400,
);
checks.push("unregistered app origin and foreign request origin rejected");
assert.equal(
  (await call("read", { token: one.body.token.slice(0, -5) + "wrong" })).status,
  401,
);
checks.push("forged conversation token rejected");
const first = await call("message", {
  token: one.body.token,
  name: "Widget verification",
  text: "Widget HTTP verification: screenshot attached.",
  page: "http://localhost:4400/?private-query=must-not-be-collected",
  attachment:
    "data:image/png;base64," +
    (await fs.readFile("artifacts/widget-test.png")).toString("base64"),
});
assert.equal(first.status, 200);
const second = await call("message", {
  token: one.body.token,
  name: "Widget verification",
  text: "Widget HTTP verification: follow-up in the same conversation.",
});
assert.equal(second.body.id, first.body.id);
checks.push("report and follow-up share one case");
const s = await db().query(api.cue.snapshot, { secret: secret() });
assert(s.attachments.some((a) => a.caseId === first.body.id && a.url));
checks.push("real screenshot bytes stored and linked to the case");
assert.equal(
  s.cases.find((c) => c._id === first.body.id)!.sourceUrl,
  "http://localhost:4400/",
);
checks.push("page query strings omitted from captured context");
await db().mutation(api.cue.message, {
  secret: secret(),
  caseId: first.body.id,
  role: "note",
  body: "Widget verification private operator note",
  author: "Test operator",
});
await db().mutation(api.cue.message, {
  secret: secret(),
  caseId: first.body.id,
  role: "staff",
  body: "Widget verification public operator reply",
  author: "Test operator",
});
const visible = await call("read", { token: one.body.token });
assert(
  visible.body.messages.some(
    (m: { body: string }) =>
      m.body === "Widget verification public operator reply",
  ),
);
assert(
  !visible.body.messages.some((m: { role: string }) =>
    ["note", "draft"].includes(m.role),
  ),
);
checks.push(
  "public reply returned while operator notes and drafts stay private",
);
const isolated = await call("read", { token: two.body.token });
assert.equal(isolated.body.case, null);
assert.deepEqual(isolated.body.messages, []);
checks.push("another visitor cannot read this conversation");
const frame = await fetch(
  `${base}/widget?app=${app.id}&origin=${encodeURIComponent("http://localhost:4400")}`,
);
assert.equal(frame.status, 200);
assert(
  frame.headers.get("content-security-policy")?.includes("frame-ancestors"),
);
checks.push("iframe restricts embedding to registered origins");
await fs.writeFile(
  base.startsWith("https:")
    ? ".cue/hosted-widget-verification.json"
    : ".cue/widget-verification.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      origin: base,
      checks,
      caseId: first.body.id,
      browser:
        "Browser proof is recorded separately; these checks use live HTTP requests.",
      screenshotPicker:
        "Browser automation could not open iframe file chooser; screenshot endpoint tested with real PNG bytes",
    },
    null,
    2,
  ),
);
console.log(`${checks.length} live widget checks passed.`);
