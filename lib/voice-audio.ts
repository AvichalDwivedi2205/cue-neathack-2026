export const VOICE_DISCLOSURE =
  "You are speaking with Cue, an AI assistant. Audio is sent to Google Gemini for transcription; replies are sent to Google Cloud for speech. Transcripts and replies are saved in your support case; Cue does not store raw audio. You can end the session at any time.";
export function publicVoiceError(error: unknown) {
  const data = (error as { data?: unknown } | null)?.data;
  const message =
    typeof data === "string"
      ? data
      : error instanceof Error
        ? error.message
        : "";
  // Convex/provider errors can contain stack traces and private arguments.
  // Expose only the known, bounded errors intended for the customer.
  const allowed =
    /^(?:Request origin rejected|Recording too large|Consent is required before starting voice|Voice is unavailable\. Please use support chat\.|App origin is not allowed|Invalid widget session|Widget session expired or belongs to another app|Start a voice session first|Voice session belongs to another app|Record a voice message first|Voice session not found|Voice session ended\. Start a new conversation\.|Voice session limit reached|Voice turn is still processing|Voice turn changed or ended|Invalid voice turn|Invalid voice transcript|Recording must be under 3 MB|Invalid recording|Use a valid WebM, OGG or WAV audio recording|Incomplete WAV recording|Use a 16-bit PCM WAV recording|Record between half a second and 30 seconds of speech|No clear speech heard\. Please try again\.|Too many requests\. Try again in a minute\.|Recording could not be decoded\. Please try again\.|Voice audio decoder unavailable\. Please use support chat\.)$/;
  return allowed.test(message)
    ? message
    : "Voice request failed. Please try support chat.";
}
export function voiceAudio(data: string, mime: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length > 4_200_000)
    throw new Error("Recording must be under 3 MB");
  const type = mime.split(";")[0];
  const bytes = Buffer.from(data, "base64");
  if (bytes.length < 100 || bytes.length > 3 * 1024 * 1024)
    throw new Error("Invalid recording");
  const valid =
    (type === "audio/webm" &&
      bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) ||
    (type === "audio/ogg" && bytes.subarray(0, 4).toString() === "OggS") ||
    (type === "audio/wav" &&
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WAVE");
  if (!valid) throw new Error("Use a valid WebM, OGG or WAV audio recording");
  if (type === "audio/wav") {
    let sampleRate = 0,
      channels = 0,
      bits = 0,
      pcm = 0;
    let samples: Buffer | undefined;
    for (let offset = 12; offset + 8 <= bytes.length; ) {
      const name = bytes.toString("ascii", offset, offset + 4),
        size = bytes.readUInt32LE(offset + 4);
      const start = offset + 8,
        end = start + size;
      if (end > bytes.length) throw new Error("Incomplete WAV recording");
      if (name === "fmt " && size >= 16) {
        pcm = bytes.readUInt16LE(start);
        channels = bytes.readUInt16LE(start + 2);
        sampleRate = bytes.readUInt32LE(start + 4);
        bits = bytes.readUInt16LE(start + 14);
      }
      if (name === "data") samples = bytes.subarray(start, end);
      offset = end + (size % 2);
    }
    if (
      pcm !== 1 ||
      bits !== 16 ||
      ![1, 2].includes(channels) ||
      sampleRate < 8000 ||
      sampleRate > 48000 ||
      !samples
    )
      throw new Error("Use a 16-bit PCM WAV recording");
    const duration = samples.length / (sampleRate * channels * 2);
    if (duration < 0.5 || duration > 35)
      throw new Error("Record between half a second and 30 seconds of speech");
    let peak = 0;
    for (let i = 0; i + 1 < samples.length; i += 2)
      peak = Math.max(peak, Math.abs(samples.readInt16LE(i)));
    if (peak < 200) throw new Error("No clear speech heard. Please try again.");
  }
  return { bytes, mimeType: type };
}
