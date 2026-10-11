import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import nextEnv from "@next/env";
import { photo } from "../demo/bloom/fixture.mjs";
nextEnv.loadEnvConfig(process.cwd());
const base =
  process.env.BLOOM_VERIFY_ORIGIN || "https://bloom-with-cue.vercel.app";
const checks: string[] = [];
const pass = (label: string) => {
  checks.push(label);
  console.log("PASS · " + label);
};
const first = await fetch(base + "/api/bloom");
assert.equal(first.status, 200);
const cookieHeader = first.headers.get("set-cookie") || "";
assert(/HttpOnly/i.test(cookieHeader));
if (base.startsWith("https:")) assert(/Secure/i.test(cookieHeader));
assert(/SameSite=strict/i.test(cookieHeader));
const cookie = cookieHeader.split(";")[0];
const start = await first.json();
assert.equal(start.health.hosting, "vercel");
assert.equal(start.health.maxUploadBytes, 5 * 1024 * 1024);
assert.equal(start.supportAvailable, true);
assert.deepEqual(start.memories, []);
pass(
  "Separate Bloom host loads an isolated journal and a connected support session",
);
async function post(body: object, customerCookie = cookie, origin = base) {
  return fetch(base + "/api/bloom", {
    method: "POST",
    headers: {
      origin,
      cookie: customerCookie,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
async function read(customerCookie = cookie) {
  const r = await fetch(base + "/api/bloom", {
    headers: { cookie: customerCookie },
  });
  assert.equal(r.status, 200);
  return await r.json();
}
async function upload(bytes: Buffer, mime = "image/png") {
  const ticketResponse = await post({ action: "uploadTicket" });
  assert.equal(ticketResponse.status, 200);
  const ticket = await ticketResponse.json();
  assert.equal(new URL(ticket.url).host, "accurate-pony-820.convex.site");
  const response = await fetch(ticket.url, {
    method: "POST",
    headers: {
      origin: base,
      authorization: "Bearer " + ticket.token,
      "content-type": mime,
    },
    body: new Uint8Array(bytes),
  });
  return { response, ticket };
}
const full = await upload(photo(5 * 1024 * 1024));
assert.equal(full.response.status, 201);
const { fileId } = await full.response.json();
const verified = await post({ action: "finishUpload", fileId });
assert.equal(verified.status, 200, await verified.clone().text());
assert.equal((await verified.json()).w, 16);
pass(
  "Full 5 MiB PNG uploads directly to Bloom's own Convex storage and decodes on Vercel",
);
const reused = await fetch(full.ticket.url, {
  method: "POST",
  headers: {
    origin: base,
    authorization: "Bearer " + full.ticket.token,
    "content-type": "image/png",
  },
  body: photo(1024),
});
assert.equal(reused.status, 401);
assert.equal((await upload(photo(5 * 1024 * 1024 + 1))).response.status, 413);
const forged = await upload(Buffer.from("not a photo"));
assert.equal(forged.response.status, 201);
assert.equal(
  (
    await post({
      action: "finishUpload",
      fileId: (await forged.response.json()).fileId,
    })
  ).status,
  400,
);
pass("Oversize photos, reused tickets and disguised non-images are rejected");
const memory = {
  fileId,
  title: "Controlled Bloom deployment check",
  caption: "caption persistence verification",
  date: "2026-10-11",
  w: 16,
  h: 16,
};
const saved = await post({ action: "save", memory });
assert.equal(saved.status, 200);
const { id } = await saved.json();
try {
  const journal = await read();
  assert.equal(journal.memories[0].id, id);
  assert.equal(
    new URL(journal.memories[0].src).host,
    "accurate-pony-820.convex.cloud",
  );
  assert(!JSON.stringify(journal).includes("BLOOM_SERVER_SECRET"));
  const visitorTwo = await fetch(base + "/api/bloom");
  const otherCookie = (visitorTwo.headers.get("set-cookie") || "").split(
    ";",
  )[0];
  assert.deepEqual((await visitorTwo.json()).memories, []);
  assert.equal((await post({ action: "delete", id }, otherCookie)).status, 400);
  assert.equal(
    (await post({ action: "finishUpload", fileId }, otherCookie)).status,
    400,
  );
  assert.equal(
    (
      await post({
        action: "save",
        memory: { ...memory, id, title: "Edited verification" },
      })
    ).status,
    200,
  );
  assert.equal((await read()).memories[0].title, "Edited verification");
  assert.equal((await post({ action: "delete", id })).status, 200);
  assert.deepEqual((await read()).memories, []);
  assert.equal((await post({ action: "delete", id, undo: true })).status, 200);
  assert.equal((await read()).memories[0].id, id);
  pass(
    "Save, refresh persistence, edit, soft deletion and undo work without cross-visitor access",
  );
  assert.equal(
    (await post({ action: "delete", id }, cookie, "https://foreign.example"))
      .status,
    403,
  );
  pass("Cross-origin mutation is forbidden");
} finally {
  await post({ action: "delete", id });
}
const reported = await post({
  action: "message",
  text: "Controlled Bloom hosting check: the journal screen is stuck loading on my phone. Which detail do you need?",
  attachment: "data:image/png;base64," + photo(1024).toString("base64"),
});
assert.equal(reported.status, 200, await reported.clone().text());
const caseId = (await reported.json()).id;
let conversation = (await read()).conversation;
assert.equal(conversation.case._id, caseId);
assert(
  conversation.messages.some((m: { role: string }) => m.role === "customer"),
);
assert(
  conversation.messages.some(
    (m: { role: string; body: string }) =>
      m.role === "cue" && m.body.includes("?"),
  ),
);
assert(conversation.progress?.steps.length === 4);
assert.equal(conversation.attachments.length, 1);
assert.equal(
  new URL(conversation.attachments[0].url).host,
  "tangible-kiwi-777.convex.cloud",
);
assert.equal(
  (
    await post({
      action: "message",
      text: "This is Chrome on a Pixel. No error is shown; the spinner stays after refreshing.",
    })
  ).status,
  200,
);
conversation = (await read()).conversation;
assert.equal(conversation.case._id, caseId);
assert.equal(
  conversation.messages.filter((m: { role: string }) => m.role === "customer")
    .length,
  2,
);
assert.equal(
  conversation.messages.filter((m: { role: string }) => m.role === "cue")
    .length,
  2,
);
assert(
  !conversation.messages.some((m: { role: string }) =>
    ["note", "draft"].includes(m.role),
  ),
);
const { api, db, secret } = await import("../lib/server-store");
const snapshot = await db().query(api.cue.snapshot, { secret: secret() });
const savedCase = snapshot.cases.find((c) => c._id === caseId);
assert.equal(savedCase?.appId, "cue_app_5625fca3e391d92460528d8d");
assert.equal(new URL(savedCase!.sourceUrl!).origin, new URL(base).origin);
pass(
  "Two customer messages receive diagnostic replies in one Cue case scoped to the registered Bloom app",
);
pass(
  "Support screenshot persists in Cue's storage and reloads only in its owner's conversation",
);
const result = {
  checkedAt: new Date().toISOString(),
  origin: base,
  release: start.health.release,
  bloomConvex: "accurate-pony-820",
  cueConvex: "tangible-kiwi-777",
  caseId,
  checks,
};
await fs.writeFile(
  ".cue/bloom-hosting-verification.json",
  JSON.stringify(result, null, 2),
  { mode: 0o600 },
);
