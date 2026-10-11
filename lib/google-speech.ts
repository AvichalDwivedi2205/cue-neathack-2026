import { GoogleAuth } from "google-auth-library";
import { z } from "zod";
import { observed } from "./observability";

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
const result = z.object({
  audioContent: z
    .string()
    .min(100)
    .max(2_800_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

// Only called with a saved Cue reply. No public arbitrary-text synthesis API,
// recordings, or persisted generated audio. ADC keeps credentials server-side.
async function synthesizeReplyImpl(text: string) {
  if (!text.trim() || text.length > 1200)
    throw new Error("Invalid spoken reply");
  const project =
    process.env.CUE_TTS_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error("Cloud speech is not configured");
  const voice = process.env.CUE_TTS_VOICE || "en-US-Chirp3-HD-Aoede";
  if (!/^[a-z]{2}-[A-Z]{2}-Chirp3-HD-[A-Za-z]+$/.test(voice))
    throw new Error("Invalid Cloud speech voice");
  const client = await auth.getClient();
  const headers = await client.getRequestHeaders();
  headers.set("content-type", "application/json");
  headers.set("x-goog-user-project", project);
  const response = await fetch(
    "https://texttospeech.googleapis.com/v1/text:synthesize",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: voice.slice(0, 5), name: voice },
        audioConfig: { audioEncoding: "MP3" },
      }),
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    },
  );
  // Provider errors can include private request text. Keep errors bounded.
  if (!response.ok) throw new Error(`Cloud speech failed (${response.status})`);
  const data = result.parse(await response.json());
  return {
    data: data.audioContent,
    mimeType: "audio/mpeg",
    voice,
    provider: "google-cloud",
  };
}

export const synthesizeReply = observed(
  "Cue voice playback",
  synthesizeReplyImpl,
  {
    input: (text) => ({ characters: text.length }),
  },
);

export async function spokenReply(reply: string) {
  try {
    return { audio: await synthesizeReply(reply) };
  } catch {
    console.error("Cue voice playback synthesis unavailable");
    return {
      audio: null,
      playbackError:
        "Your reply is saved. Voice playback is unavailable; read it in the conversation.",
    };
  }
}
