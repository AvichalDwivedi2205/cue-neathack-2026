/// <reference types="vite/client" />
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { voiceAudio } from "../lib/voice-audio";
const modules = import.meta.glob("../convex/**/*.{ts,js}"),
  auth = { secret: "voice-test-secret" },
  owner = "voice-owner",
  key = "a0000000-0000-4000-8000-000000000001";
beforeEach(() => vi.stubEnv("CUE_DEMO_SECRET", auth.secret));
afterEach(() => vi.unstubAllEnvs());
async function setup() {
  const t = convexTest(schema, modules);
  const sessionId = await t.mutation(api.voice.start, {
    ...auth,
    owner,
    customer: "Voice visitor",
  });
  return { t, sessionId, args: { ...auth, owner, sessionId, key } };
}
describe("Voice session ownership and lifecycle", () => {
  test("verification labeling retains evidence and requires the exact spoken fixture", async () => {
    const { t, args } = await setup();
    await t.mutation(api.voice.claim, args);
    const caseId = await t.mutation(api.voice.finish, {
      ...args,
      transcript: "Controlled spoken fixture",
      reply: "Saved",
    });
    await expect(
      t.mutation(api.voice.markVerificationCase, {
        ...auth,
        caseId,
        expectedTranscript: "Different",
      }),
    ).rejects.toThrow("does not match");
    await t.mutation(api.voice.markVerificationCase, {
      ...auth,
      caseId,
      expectedTranscript: "Controlled spoken fixture",
    });
    await t.mutation(api.voice.markVerificationCase, {
      ...auth,
      caseId,
      expectedTranscript: "Controlled spoken fixture",
    });
    const conversation = await t.query(api.bloom.conversation, {
      ...auth,
      owner,
    });
    expect(conversation?.case.provenance).toBe("Synthetic voice verification");
    expect(
      conversation?.messages.filter((m) => m.role === "customer"),
    ).toHaveLength(1);
    expect(
      conversation?.messages.filter((m) =>
        m.body.startsWith("Generated audio fixture"),
      ),
    ).toHaveLength(1);
  });
  test("start reuses an active session and rejects cross-owner access", async () => {
    const { t, sessionId } = await setup();
    expect(
      await t.mutation(api.voice.start, {
        ...auth,
        owner,
        customer: "Voice visitor",
      }),
    ).toBe(sessionId);
    await expect(
      t.query(api.voice.get, { ...auth, owner: "other", sessionId }),
    ).rejects.toThrow("not found");
    await expect(
      t.mutation(api.voice.end, { ...auth, owner: "other", sessionId }),
    ).rejects.toThrow("not found");
  });
  test("commits both spoken turns atomically, deduplicates retries, and hides internal notes", async () => {
    const { t, args } = await setup();
    await t.mutation(api.voice.claim, args);
    const id = await t.mutation(api.voice.finish, {
      ...args,
      transcript: "Please add caption search",
      reply: "Your request is saved for product review.",
    });
    expect(
      await t.mutation(api.voice.finish, {
        ...args,
        transcript: "duplicate",
        reply: "duplicate",
      }),
    ).toBe(id);
    const done = await t.mutation(api.voice.claim, args);
    expect(done?.transcript).toBe("Please add caption search");
    const conversation = await t.query(api.bloom.conversation, {
      ...auth,
      owner,
    });
    expect(
      conversation?.messages.filter((m) => m.role === "customer"),
    ).toHaveLength(1);
    expect(conversation?.messages.filter((m) => m.role === "cue")).toHaveLength(
      1,
    );
    expect(
      (
        await t.query(api.voice.get, {
          ...auth,
          owner,
          sessionId: args.sessionId,
        })
      ).turnCount,
    ).toBe(1);
    await t.mutation(api.voice.end, {
      ...auth,
      owner,
      sessionId: args.sessionId,
    });
    await t.mutation(api.voice.end, {
      ...auth,
      owner,
      sessionId: args.sessionId,
    });
    const final = await t.query(api.bloom.conversation, { ...auth, owner });
    expect(
      final?.messages.filter((m) => m.body.startsWith("Voice session ended")),
    ).toHaveLength(1);
    expect(
      final?.messages.find((m) => m.body.startsWith("Voice session ended"))
        ?.role,
    ).toBe("note");
    await expect(t.mutation(api.voice.claim, args)).rejects.toThrow("ended");
  });
  test("a pending turn prevents concurrent generation and can be released on failure", async () => {
    const { t, args } = await setup();
    await t.mutation(api.voice.claim, args);
    await expect(
      t.mutation(api.voice.claim, { ...args, key: key.replace(/1$/, "2") }),
    ).rejects.toThrow("still processing");
    await t.mutation(api.voice.release, { ...args, owner: "other" });
    await expect(t.mutation(api.voice.claim, args)).rejects.toThrow(
      "still processing",
    );
    await t.mutation(api.voice.release, args);
    expect(await t.mutation(api.voice.claim, args)).toBeNull();
  });
  test("ending during generation prevents late transcript delivery", async () => {
    const { t, args } = await setup();
    await t.mutation(api.voice.claim, args);
    await t.mutation(api.voice.end, {
      ...auth,
      owner,
      sessionId: args.sessionId,
    });
    await expect(
      t.mutation(api.voice.finish, {
        ...args,
        transcript: "late",
        reply: "late",
      }),
    ).rejects.toThrow("ended");
    expect(
      await t.query(api.bloom.conversation, { ...auth, owner }),
    ).toBeNull();
  });
  test("widget app boundaries survive subsequent turns", async () => {
    const { t } = await setup();
    const appOwner = "widget-owner";
    const sessionId = await t.mutation(api.voice.start, {
      ...auth,
      owner: appOwner,
      appId: "app-a",
      customer: "Guest",
    });
    const args = { ...auth, owner: appOwner, sessionId, key };
    await t.mutation(api.voice.claim, args);
    const id = await t.mutation(api.voice.finish, {
      ...args,
      transcript: "My upload failed",
      reply: "Your report is saved.",
    });
    const next = { ...args, key: key.replace(/1$/, "2") };
    await t.mutation(api.voice.claim, next);
    await t.mutation(api.voice.finish, {
      ...next,
      transcript: "Only on mobile",
      reply: "I saved that detail.",
    });
    const conversation = await t.query(api.bloom.conversation, {
      ...auth,
      owner: appOwner,
    });
    expect(conversation?.case._id).toBe(id);
    expect(conversation?.case.appId).toBe("app-a");
    expect(
      conversation?.messages.filter((m) => m.role === "customer"),
    ).toHaveLength(2);
    expect(
      await t.query(api.bloom.conversation, {
        ...auth,
        owner: "another-widget",
      }),
    ).toBeNull();
  });
});
test("audio validation rejects mismatched MIME, oversized and non-audio payloads", () => {
  const bytes = Buffer.alloc(32044);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(32000, 40);
  bytes.writeInt16LE(5000, 44);
  expect(voiceAudio(bytes.toString("base64"), "audio/wav").mimeType).toBe(
    "audio/wav",
  );
  expect(() => voiceAudio(bytes.toString("base64"), "audio/webm")).toThrow(
    "valid",
  );
  expect(() => voiceAudio("not base64", "audio/wav")).toThrow();
  const silence = Buffer.from(bytes);
  silence.fill(0, 44);
  expect(() => voiceAudio(silence.toString("base64"), "audio/wav")).toThrow(
    "No clear speech",
  );
  expect(() =>
    voiceAudio(
      Buffer.alloc(3 * 1024 * 1024 + 1).toString("base64"),
      "audio/wav",
    ),
  ).toThrow();
});
