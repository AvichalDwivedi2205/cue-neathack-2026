import { z } from "zod";
import {
  guest,
  sameOrigin,
  supportToken,
  cue,
  boundedJSON,
} from "../../../lib/server";
export const runtime = "nodejs";
export const maxDuration = 120;
const input = z.object({
  action: z.enum(["start", "turn", "end"]),
  consent: z.boolean().optional(),
  sessionId: z.string().max(100).optional(),
  key: z.uuid().optional(),
  audio: z.string().max(4_200_000).optional(),
  mimeType: z.string().max(60).optional(),
});
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = input.parse(await boundedJSON(request));
    const token = await supportToken(await guest());
    return Response.json(
      await cue("/api/voice", { ...body, token, name: "Bloom user" }),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Voice temporarily unavailable";
    return Response.json(
      {
        error: /Origin not allowed|Consent|session|Recording|too large/i.test(
          message,
        )
          ? message
          : "Voice temporarily unavailable. Please use support chat.",
      },
      { status: message === "Origin not allowed" ? 403 : 400 },
    );
  }
}
