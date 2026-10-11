import sharp from "sharp";
import { attachCampaign } from "../../../lib/growth";
import { z } from "zod";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  guest,
  sameOrigin,
  db,
  secret,
  ticket,
  cue,
  supportToken,
  boundedJSON,
  MAX_PHOTO_BYTES,
} from "../../../lib/server";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function GET() {
  try {
    const owner = await guest();
    const memories = await db().query(api.journal.list, {
      secret: secret(),
      owner,
    });
    let conversation = null,
      supportAvailable = true;
    try {
      const current = await cue("/api/widget", {
        action: "read",
        token: await supportToken(owner),
      });
      if (current.case) {
        const c = z
          .object({ id: z.string(), title: z.string(), status: z.string() })
          .parse(current.case);
        conversation = {
          case: { ...c, _id: c.id },
          messages: current.messages,
          attachments: current.attachments,
          progress: current.progress,
        };
      }
    } catch {
      supportAvailable = false;
    }
    return Response.json(
      {
        memories,
        conversation,
        supportAvailable,
        customer: "Bloom user",
        health: {
          maxUploadBytes: MAX_PHOTO_BYTES,
          hosting: "vercel",
          release:
            process.env.BLOOM_RELEASE ||
            process.env.VERCEL_GIT_COMMIT_SHA ||
            "local",
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Couldn't load your journal. Please try again." },
      { status: 503 },
    );
  }
}
const input = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("attribution"), token: z.string().max(200) })
    .strict(),
  z
    .object({ action: z.literal("search"), query: z.string().max(280) })
    .strict(),
  z.object({ action: z.literal("uploadTicket") }),
  z.object({ action: z.literal("finishUpload"), fileId: z.string().max(100) }),
  z.object({
    action: z.literal("save"),
    memory: z.object({
      id: z.string().max(100).optional(),
      fileId: z.string().max(100).optional(),
      title: z.string().trim().min(1).max(80),
      caption: z.string().max(280),
      date: z.string().max(10),
      w: z.number().positive(),
      h: z.number().positive(),
    }),
  }),
  z.object({
    action: z.literal("delete"),
    id: z.string().max(100),
    undo: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("message"),
    text: z.string().trim().min(1).max(12000),
    attachment: z.string().max(4_000_000).optional(),
  }),
]);
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const b = input.parse(await boundedJSON(request)),
      owner = await guest(),
      store = db(),
      auth = { secret: secret(), owner };
    switch (b.action) {
      case "attribution":
        await attachCampaign(owner, b.token);
        return Response.json({ ok: true });
      case "search":
        return Response.json({
          ids: await store.mutation(api.growth.search, {
            ...auth,
            query: b.query,
          }),
        });
      case "uploadTicket": {
        const t = ticket();
        await store.mutation(api.uploads.issue, { ...auth, tokenHash: t.hash });
        return Response.json(
          { token: t.token, url: t.url },
          { headers: { "cache-control": "no-store" } },
        );
      }
      case "finishUpload": {
        const fileId = b.fileId as Id<"_storage">;
        const photo = await store.query(api.uploads.get, { ...auth, fileId });
        if (photo.size > MAX_PHOTO_BYTES)
          throw new Error("Photo must be 5 MB or smaller");
        try {
          const response = await fetch(photo.src, {
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw new Error("Photo unavailable");
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > MAX_PHOTO_BYTES)
            throw new Error("Photo must be 5 MB or smaller");
          const image = sharp(bytes, { limitInputPixels: 40000000 });
          const meta = await image.metadata();
          const mime = {
            jpeg: "image/jpeg",
            png: "image/png",
            webp: "image/webp",
          }[meta.format as "jpeg" | "png" | "webp"];
          if (!mime || mime !== photo.mime || !meta.width || !meta.height)
            throw new Error("Use a valid JPG, PNG or WebP photo");
          await image.stats();
          await store.mutation(api.uploads.verify, {
            ...auth,
            fileId,
            w: meta.width,
            h: meta.height,
          });
          return Response.json({ fileId, w: meta.width, h: meta.height });
        } catch {
          await store
            .mutation(api.uploads.discard, { ...auth, fileId })
            .catch(() => {});
          throw new Error("Use a valid JPG, PNG or WebP photo");
        }
      }
      case "save": {
        const { id, fileId, ...memory } = b.memory;
        return Response.json({
          id: await store.mutation(api.journal.save, {
            ...auth,
            ...memory,
            ...(id ? { id: id as Id<"memories"> } : {}),
            ...(fileId ? { fileId: fileId as Id<"_storage"> } : {}),
          }),
        });
      }
      case "delete":
        await store.mutation(api.journal.remove, {
          ...auth,
          id: b.id as Id<"memories">,
          undo: b.undo,
        });
        return Response.json({ ok: true });
      case "message":
        return Response.json(
          await cue("/api/widget", {
            action: "message",
            token: await supportToken(owner),
            text: b.text,
            attachment: b.attachment,
            name: "Bloom user",
            page: process.env.BLOOM_PUBLIC_URL,
          }),
        );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Request failed";
    const safe =
      /Origin not allowed|Request too large|valid JPG|5 MB|Too many/.test(
        message,
      )
        ? message
        : "Couldn't complete that request. Please try again.";
    return Response.json(
      { error: safe },
      {
        status:
          message === "Origin not allowed"
            ? 403
            : /Too many/.test(message)
              ? 429
              : 400,
      },
    );
  }
}
