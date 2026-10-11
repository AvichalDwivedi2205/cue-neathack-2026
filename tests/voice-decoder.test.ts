import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { decodeVoiceAudio } from "../lib/voice-decoder";
import { publicVoiceError } from "../lib/voice-audio";
const compressed = (source: string, format: "webm" | "ogg", duration = "1") =>
  execFileSync(process.env.CUE_FFMPEG_PATH || "ffmpeg", [
    "-nostdin",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    source,
    "-t",
    duration,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libopus",
    "-f",
    format,
    "pipe:1",
  ]);
describe("compressed microphone audio", () => {
  for (const format of ["webm", "ogg"] as const) {
    test(`decodes real ${format} and rejects its silent control before transcription`, async () => {
      const tone = compressed("sine=frequency=440:sample_rate=16000", format);
      const audio = await decodeVoiceAudio(
        tone.toString("base64"),
        `audio/${format}`,
      );
      expect(audio.mimeType).toBe("audio/wav");
      expect(audio.bytes.length).toBeGreaterThan(16000);
      const silence = compressed("anullsrc=r=16000:cl=mono", format);
      await expect(
        decodeVoiceAudio(silence.toString("base64"), `audio/${format}`),
      ).rejects.toThrow("No clear speech");
    });
  }
  test("rejects excessive decoded duration despite a small compressed input", async () => {
    const input = compressed("anullsrc=r=16000:cl=mono", "webm", "36");
    await expect(
      decodeVoiceAudio(input.toString("base64"), "audio/webm"),
    ).rejects.toThrow("30 seconds");
  });
  test("rejects truncated compressed headers", async () => {
    const corrupt = Buffer.alloc(200);
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(corrupt);
    await expect(
      decodeVoiceAudio(corrupt.toString("base64"), "audio/webm"),
    ).rejects.toThrow("could not be decoded");
  });
});
test("public voice failures exclude private provider traces and backend arguments", () => {
  expect(
    publicVoiceError(new Error("secret=sensitive-token backend traceback")),
  ).toBe("Voice request failed. Please try support chat.");
  expect(
    publicVoiceError({
      data: "Voice session not found",
      message: "private traceback",
    }),
  ).toBe("Voice session not found");
  expect(
    publicVoiceError(new Error("No clear speech heard. Please try again.")),
  ).toContain("No clear speech");
});
