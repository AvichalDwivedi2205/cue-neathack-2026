import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
nextEnv.loadEnvConfig(process.cwd());
const { api, db, secret } = await import("../lib/server-store");
const base = process.env.CUE_VERIFY_ORIGIN || "http://127.0.0.1:3000";
let cookie = "";
const call = async (body: object, useCookie = true) => {
  const r = await fetch(base + "/api/voice", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: base,
      ...(useCookie && cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const received = r.headers.get("set-cookie");
  if (useCookie && received) cookie = received.split(";")[0];
  return { status: r.status, data: await r.json() };
};
const checks: string[] = [];
const pass = (s: string) => {
  checks.push(s);
  console.log("PASS · " + s);
};
assert.equal((await call({ action: "start" })).status, 400);
pass("Voice requires explicit consent");
const start = await call({ action: "start", consent: true });
assert.equal(start.status, 200);
const sessionId = start.data.sessionId;
assert(start.data.disclosure.includes("Google Gemini"));
pass("Real signed visitor session starts with processing disclosure");
const key = randomUUID();
const payload = {
  action: "turn",
  sessionId,
  key,
  audio: (await fs.readFile(".cue/voice-check.webm")).toString("base64"),
  mimeType: "audio/webm",
};
const began = Date.now();
const turn = await call(payload);
assert.equal(turn.status, 200, JSON.stringify(turn.data));
await db().mutation(api.voice.markVerificationCase, {
  secret: secret(),
  caseId: turn.data.caseId,
  expectedTranscript: turn.data.transcript,
});
assert(/three|3/i.test(turn.data.transcript));
assert(/chrome/i.test(turn.data.transcript));
assert(turn.data.reply.trim());
pass(
  "Real WebM → validated PCM → live Vertex Gemini transcript → contextual support reply",
);
const repeated = await call(payload);
assert.equal(repeated.data.caseId, turn.data.caseId);
assert.equal(repeated.data.reply, turn.data.reply);
pass(
  "Repeated audio turn returns its durable receipt without duplicate messages",
);
assert.equal((await call({ action: "end", sessionId }, false)).status, 403);
pass("Another visitor cannot end the session");
assert.equal((await call({ action: "end", sessionId })).status, 200);
assert.equal((await call({ ...payload, key: randomUUID() })).status, 400);
pass("Ended sessions reject late audio turns");
const r = await fetch(base + "/api/bloom", { headers: { cookie } }),
  visible = await r.json();
assert.equal(visible.conversation.case._id, turn.data.caseId);
assert(
  visible.conversation.messages.some(
    (m: { body: string }) => m.body === turn.data.transcript,
  ),
);
assert(
  !visible.conversation.messages.some((m: { role: string }) =>
    ["note", "draft"].includes(m.role),
  ),
);
assert(!("owner" in visible.conversation.case));
assert(!visible.conversation.run || !("repoPath" in visible.conversation.run));
pass(
  "Customer reload retains transcript and excludes internal notes, identity and checkout details",
);
const state = await db().query(api.cue.snapshot, { secret: secret() });
assert.equal(
  state.messages.filter(
    (m) => m.caseId === turn.data.caseId && m.role === "customer",
  ).length,
  1,
);
assert(
  state.messages.some(
    (m) =>
      m.caseId === turn.data.caseId &&
      m.role === "note" &&
      m.body.startsWith("Voice session ended"),
  ),
);
pass("Cue records one spoken report plus a private session-end note");
await fs.writeFile(
  base.startsWith("https:")
    ? ".cue/hosted-voice-verification.json"
    : ".cue/voice-verification.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      origin: base,
      caseId: turn.data.caseId,
      transcript: turn.data.transcript,
      reply: turn.data.reply,
      turnLatencyMs: Date.now() - began,
      checks,
      limitations: [
        "Spoken WAV was generated from a fixed test sentence. This proves the real audio gateway and persistence, not a microphone or speaker hardware check.",
        "Voice is turn-based, not a phone call or full-duplex streaming connection.",
      ],
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(`${checks.length} live voice checks passed.`);
