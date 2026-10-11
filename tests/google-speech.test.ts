import { afterEach, beforeEach, expect, test, vi } from "vitest";
const getRequestHeaders = vi.hoisted(() => vi.fn());
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return { getRequestHeaders };
    }
  },
}));
import { synthesizeReply, spokenReply } from "../lib/google-speech";
beforeEach(() => {
  vi.stubEnv("GOOGLE_CLOUD_PROJECT", "test-voice-project");
  getRequestHeaders.mockResolvedValue(
    new Headers({ authorization: "Bearer test-only" }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
test("synthesizes bounded plain text with server credentials and a Chirp voice", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({ audioContent: Buffer.alloc(120).toString("base64") }),
    );
  vi.stubGlobal("fetch", fetcher);
  const audio = await synthesizeReply("Which part of Bloom isn't working?");
  const [, request] = fetcher.mock.calls[0];
  expect(JSON.parse(request.body)).toEqual({
    input: { text: "Which part of Bloom isn't working?" },
    voice: { languageCode: "en-US", name: "en-US-Chirp3-HD-Aoede" },
    audioConfig: { audioEncoding: "MP3" },
  });
  expect(request.headers.get("x-goog-user-project")).toBe("test-voice-project");
  expect(audio.mimeType).toBe("audio/mpeg");
  expect(audio).not.toHaveProperty("authorization");
  await expect(synthesizeReply("x".repeat(1201))).rejects.toThrow("Invalid");
  expect(fetcher).toHaveBeenCalledOnce();
});
test("synthesis failure retains a readable reply without exposing provider errors", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("private provider request", { status: 403 }),
      ),
  );
  const fallback = await spokenReply("Which step failed?");
  expect(fallback.audio).toBeNull();
  expect(fallback.playbackError).toContain("reply is saved");
  expect(JSON.stringify(fallback)).not.toContain("private provider");
});
test("rejects malformed provider audio", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ audioContent: "not audio" })),
  );
  await expect(synthesizeReply("Hello")).rejects.toThrow();
});
