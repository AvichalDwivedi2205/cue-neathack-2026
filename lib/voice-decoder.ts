import { spawn } from "node:child_process";
import { voiceAudio } from "./voice-audio";

// Compressed audio must pass the same duration/silence checks as WAV before
// reaching the model. Never give the decoder URLs, filenames or credentials.
export async function decodeVoiceAudio(data: string, mime: string) {
  const input = voiceAudio(data, mime);
  if (input.mimeType === "audio/wav") return input;
  const pcm = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      // FFmpeg is an installed system dependency, never a bundled project file.
      /* turbopackIgnore: true */
      process.env.CUE_FFMPEG_PATH || "ffmpeg",
      [
        "-nostdin",
        "-loglevel",
        "error",
        "-max_alloc",
        "16777216",
        "-protocol_whitelist",
        "pipe",
        "-threads",
        "1",
        "-f",
        input.mimeType === "audio/ogg" ? "ogg" : "matroska",
        "-i",
        "pipe:0",
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-t",
        "36",
        "-f",
        "s16le",
        "pipe:1",
      ],
      {
        stdio: ["pipe", "pipe", "ignore"],
        env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV },
      },
    );
    const chunks: Buffer[] = [];
    let size = 0,
      failed = false;
    const fail = (message: string) => {
      if (failed) return;
      failed = true;
      child.kill("SIGKILL");
      reject(new Error(message));
    };
    const timeout = setTimeout(
      () => fail("Recording could not be decoded. Please try again."),
      8000,
    );
    child.on("error", () =>
      fail("Voice audio decoder unavailable. Please use support chat."),
    );
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 35 * 32000)
        fail("Record between half a second and 30 seconds of speech");
      else chunks.push(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (failed) return;
      if (code !== 0) fail("Recording could not be decoded. Please try again.");
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input.bytes);
  });
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return voiceAudio(wav.toString("base64"), "audio/wav");
}
