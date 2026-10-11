import { NextRequest, after } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { guest, sameOrigin } from "@/lib/access";
import { api, db, secret } from "@/lib/server-store";
import { readIntegrations } from "@/lib/integration-config";
import { verifyWidgetSession, widgetRateLimit } from "@/lib/widget-session";
import { draft, geminiReady, transcribeAudio } from "@/lib/gemini";
import { VOICE_DISCLOSURE, publicVoiceError } from "@/lib/voice-audio";
import { decodeVoiceAudio } from "@/lib/voice-decoder";
import { triage } from "@/lib/triage";
import { spokenReply } from "@/lib/google-speech";
import type { Id } from "@/convex/_generated/dataModel";
export const runtime = "nodejs";
const input = z.object({
  action: z.enum(["start", "turn", "end"]),
  consent: z.boolean().optional(),
  sessionId: z.string().max(100).optional(),
  key: z.uuid().optional(),
  audio: z.string().max(4_200_000).optional(),
  mimeType: z.string().max(60).optional(),
  app: z.string().max(100).optional(),
  origin: z.string().url().optional(),
  token: z.string().max(2000).optional(),
  name: z.string().max(80).optional(),
});
export async function POST(request: NextRequest) {
  let phase = "validation";
  let claimed:
    | { owner: string; sessionId: Id<"voiceSessions">; key: string }
    | undefined;
  try {
    sameOrigin(request);
    if (Number(request.headers.get("content-length") || 0) > 4_250_000)
      throw new Error("Recording too large");
    const b = input.parse(await request.json());
    let owner: string,
      appId: string | undefined,
      appName = "Bloom";
    if (b.app) {
      const app = (await readIntegrations()).apps.find((a) => a.id === b.app);
      if (!app || !b.origin || !app.origins.includes(b.origin))
        throw new Error("App origin is not allowed");
      owner = verifyWidgetSession(b.token || "", app, b.origin);
      appId = app.id;
      appName = app.name;
    } else owner = await guest(request);
    widgetRateLimit(owner + ":voice:" + b.action, b.action === "turn" ? 8 : 20);
    const store = db(),
      auth = secret();
    if (b.action === "start") {
      if (!b.consent)
        throw new Error("Consent is required before starting voice");
      if (!geminiReady())
        throw new Error("Voice is unavailable. Please use support chat.");
      const sessionId = await store.mutation(api.voice.start, {
        secret: auth,
        owner,
        appId,
        customer: b.app ? b.name || "Guest" : "Bloom user",
      });
      return Response.json(
        { sessionId, disclosure: VOICE_DISCLOSURE },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (!b.sessionId) throw new Error("Start a voice session first");
    const sessionId = b.sessionId as Id<"voiceSessions">;
    const session = await store.query(api.voice.get, {
      secret: auth,
      owner,
      sessionId,
    });
    if (session.appId !== appId)
      throw new Error("Voice session belongs to another app");
    if (b.action === "end") {
      await store.mutation(api.voice.end, { secret: auth, owner, sessionId });
      return Response.json({ ended: true, caseId: session.caseId });
    }
    if (!b.audio || !b.mimeType)
      throw new Error("Record a voice message first");
    phase = "decode";
    const audio = await decodeVoiceAudio(b.audio, b.mimeType),
      key = b.key || randomUUID();
    phase = "claim";
    const done = await store.mutation(api.voice.claim, {
      secret: auth,
      owner,
      sessionId,
      key,
    });
    if (done)
      return Response.json({
        transcript: done.transcript,
        reply: done.reply,
        caseId: session.caseId,
        ...(await spokenReply(done.reply)),
      });
    claimed = { owner, sessionId, key };
    phase = "transcribe";
    const transcript = await transcribeAudio(audio.bytes, audio.mimeType);
    const conversation = await store.query(api.bloom.conversation, {
      secret: auth,
      owner,
    });
    phase = "reply";
    const reply = await draft({
      conversation:
        conversation?.case._id === session.caseId ? conversation : null,
      appName,
      channel: "chat",
      medium: "voice",
      message: transcript,
    });
    phase = "persist";
    const caseId = await store.mutation(api.voice.finish, {
      secret: auth,
      ...claimed,
      transcript,
      reply,
    });
    claimed = undefined;
    phase = "triage";
    if (!session.caseId) after(() => triage(caseId));
    return Response.json(
      { transcript, reply, caseId, ...(await spokenReply(reply)) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    if (phase !== "validation") {
      // Diagnose hosted failures without logging audio, transcripts, identity,
      // provider messages or private Convex arguments.
      const status = (e as { status?: unknown } | null)?.status;
      console.error("Cue voice processing failed", {
        phase,
        status: typeof status === "number" ? status : null,
      });
    }
    if (claimed)
      await db()
        .mutation(api.voice.release, { secret: secret(), ...claimed })
        .catch(() => {});
    const error = publicVoiceError(e);
    return Response.json(
      { error },
      {
        status: /Too many/.test(error)
          ? 429
          : /session not found|belongs/.test(error)
            ? 403
            : 400,
      },
    );
  }
}
