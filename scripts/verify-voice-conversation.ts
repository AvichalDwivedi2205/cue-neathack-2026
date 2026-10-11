import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
nextEnv.loadEnvConfig(process.cwd());
const { synthesizeReply } = await import("../lib/google-speech");
const { api, db, secret } = await import("../lib/server-store");
const { replyProblems } = await import("../lib/reply-policy");
const base = process.env.CUE_VERIFY_ORIGIN || "http://127.0.0.1:3000";
let cookie = "";
async function call(body: object) {
  const response = await fetch(base + "/api/voice", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: base,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const received = response.headers.get("set-cookie");
  if (received) cookie = received.split(";")[0];
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
const { sessionId } = await call({ action: "start", consent: true });
const novel = process.env.CUE_VOICE_NOVEL === "true";
const sentences = novel
  ? [
      "Something goes wrong when I edit a memory. Can you help me?",
      "I am editing an existing caption in Chrome on my Pixel. The save button looks successful, but my new words disappear after I refresh.",
      "The photo and title stay saved. Only the caption goes back to the older text, and there is no error message. It happens on two entries.",
    ]
  : [
      "So I don't think this platform is working. Can you check once?",
      "I am trying to upload a three megabyte photo on my Pixel in Chrome. It stays on a loading screen and never finishes.",
      "A different small photo also stays on the loading screen. There is no error message.",
    ];
const turns: {
  transcript: string;
  reply: string;
  audioBytes: number;
  latencyMs: number;
}[] = [];
let caseId;
try {
  for (const [i, sentence] of sentences.entries()) {
    const fixture = await synthesizeReply(sentence);
    const input = `.cue/voice-${novel ? "novel-" : "conversation-"}${i}.mp3`,
      wav = `.cue/voice-${novel ? "novel-" : "conversation-"}${i}.wav`;
    await fs.writeFile(input, Buffer.from(fixture.data, "base64"), {
      mode: 0o600,
    });
    execFileSync(process.env.CUE_FFMPEG_PATH || "ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      input,
      "-ar",
      "16000",
      "-ac",
      "1",
      wav,
    ]);
    const payload = {
      action: "turn",
      sessionId,
      key: randomUUID(),
      audio: (await fs.readFile(wav)).toString("base64"),
      mimeType: "audio/wav",
    };
    const began = Date.now();
    const turn = await call(payload);
    caseId ||= turn.caseId;
    assert.equal(turn.caseId, caseId);
    assert.equal(
      turn.audio?.provider,
      "google-cloud",
      "Hosted speech must use Cloud TTS",
    );
    assert.equal(turn.audio.mimeType, "audio/mpeg");
    assert(turn.reply.trim().length < 1200);
    assert.deepEqual(
      replyProblems(turn.reply, {
        medium: "voice",
        message: turn.transcript,
        messages: turns.map((previous) => ({
          role: "customer",
          body: previous.transcript,
        })),
      }),
      [],
      "The next question must advance past known answers",
    );
    assert(
      !/your (issue|problem) (is|has been) (fixed|resolved)/i.test(turn.reply),
    );
    if (i === 0) {
      assert(
        turn.reply.includes("?"),
        "Vague failure needs a diagnostic question",
      );
      assert(/part|trying|happens|what.*(?:issue|problem)/i.test(turn.reply));
      await db().mutation(api.voice.markVerificationCase, {
        secret: secret(),
        caseId,
        expectedTranscript: turn.transcript,
      });
    } else {
      assert(
        !/what (?:device|phone|browser)|(?:what|which|how big).*size|how (?:large|big) is/i.test(
          turn.reply,
        ),
        "Don't repeat already answered device/size questions",
      );
    }
    const replyFile = `artifacts/cue-voice-${novel ? "novel-" : "reply-"}${i}.mp3`;
    await fs.writeFile(replyFile, Buffer.from(turn.audio.data, "base64"));
    const duration = Number(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=nw=1:nk=1",
          replyFile,
        ],
        { encoding: "utf8" },
      ).trim(),
    );
    assert(
      duration > 0.5 && duration < 60,
      "Reply audio must decode to bounded audible duration",
    );
    turns.push({
      transcript: turn.transcript,
      reply: turn.reply,
      audioBytes: Buffer.from(turn.audio.data, "base64").length,
      latencyMs: Date.now() - began,
    });
    console.log(`PASS turn ${i + 1}: ${turn.reply}`);
    if (i === 0) {
      const again = await call(payload);
      assert.equal(again.caseId, caseId);
      assert.equal(again.reply, turn.reply);
      assert(again.audio?.data);
      console.log(
        "PASS retry returns the saved turn and Cloud speech without duplicate conversation messages",
      );
    }
  }
} finally {
  await call({ action: "end", sessionId });
}
const visible = await (
  await fetch(base + "/api/bloom", { headers: { cookie } })
).json();
assert.equal(visible.conversation.case._id, caseId);
assert.equal(
  visible.conversation.messages.filter(
    (m: { role: string }) => m.role === "customer",
  ).length,
  3,
);
assert.equal(
  visible.conversation.messages.filter(
    (m: { role: string }) => m.role === "cue",
  ).length,
  3,
);
assert.equal(visible.conversation.progress.label, "Received");
assert.equal(visible.conversation.progress.steps[1].state, "pending");
assert(!JSON.stringify(visible).includes('"audio"'));
const result = {
  checkedAt: new Date().toISOString(),
  fixture: novel
    ? "Novel caption edit persistence diagnostic"
    : "Original upload diagnostic",
  origin: base,
  caseId,
  turns,
  checks: [
    "Three real audio turns through Gemini, persisted to one visitor case",
    "Vague failure asks a follow-up",
    "History avoids repeating supplied device and size",
    "Cloud Chirp reply audio decodes",
    "Idempotent retry",
    "Received UI does not claim investigation",
    "Raw audio absent from customer projection",
  ],
  limitation:
    "Fixed synthetic sentences exercise real services; naturalness and novel diagnostic quality still require human review. This is turn-based voice.",
};
await fs.writeFile(
  process.env.CUE_VERIFY_OUTPUT ||
    (base.startsWith("https:")
      ? ".cue/hosted-voice-conversation.json"
      : ".cue/voice-conversation.json"),
  JSON.stringify(result, null, 2),
  { mode: 0o600 },
);
console.log("PASS complete voice conversation and honest progress");
