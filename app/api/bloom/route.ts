import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { api, db, secret } from "@/lib/server-store";
import { guest, sameOrigin } from "@/lib/access";
import { saveAttachment } from "@/lib/attachment";
import { draft, geminiReady } from "@/lib/gemini";
import { z } from "zod";
import { triage } from "@/lib/triage";
import { hostedUploadHealth, hostedUploadStatus } from "@/lib/bloom-upload";
import { supportProgress } from "@/lib/support-progress";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const owner = await guest(request),
      store = db(),
      auth = secret();
    let health =
      process.env.CUE_HOSTED_UPLOAD === "true" ? hostedUploadHealth() : null;
    if (!health)
      try {
        health = await (
          await fetch("http://127.0.0.1:4318/health", {
            signal: AbortSignal.timeout(2000),
            cache: "no-store",
          })
        ).json();
      } catch {}
    const conversation = await store.query(api.bloom.conversation, {
      secret: auth,
      owner,
    });
    return NextResponse.json({
      memories: await store.query(api.bloom.memories, { secret: auth, owner }),
      conversation: conversation
        ? {
            progress: supportProgress(conversation),
            case: {
              _id: conversation.case._id,
              title: conversation.case.title,
              status: conversation.case.status,
            },
            messages: conversation.messages
              .filter((m) => ["customer", "cue", "staff"].includes(m.role))
              .map((m) => ({
                _id: m._id,
                role: m.role,
                author: m.author,
                body: m.body,
                createdAt: m.createdAt,
              })),
            issue: conversation.issue
              ? {
                  kind: conversation.issue.kind,
                  title: conversation.issue.title,
                  status: conversation.issue.status,
                }
              : null,
            run: conversation.run
              ? {
                  status: conversation.run.status,
                  deployed: conversation.run.deployed,
                  verified: conversation.run.verified,
                  commit: conversation.run.commit,
                }
              : null,
          }
        : null,
      health,
      customer: "Bloom user",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    const owner = await guest(request),
      store = db(),
      auth = secret();
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await request.formData(),
        file = form.get("file");
      if (!(file instanceof File) || file.size > 8 * 1024 * 1024)
        throw new Error("Invalid photo");
      const bytes = Buffer.from(await file.arrayBuffer());
      const meta = await sharp(bytes, {
        limitInputPixels: 40000000,
      }).metadata();
      const mime = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[
        meta.format as "jpeg" | "png" | "webp"
      ];
      if (!mime || mime !== file.type)
        throw new Error("Use a valid JPG, PNG or WebP photo");
      const r =
        process.env.CUE_HOSTED_UPLOAD === "true"
          ? {
              status: hostedUploadStatus(bytes, mime),
              ok: hostedUploadStatus(bytes, mime) === 201,
            }
          : await fetch("http://127.0.0.1:4318/upload", {
              method: "POST",
              headers: {
                "content-type": mime,
                "x-file-name": encodeURIComponent(file.name),
              },
              body: bytes,
              signal: AbortSignal.timeout(15000),
            });
      if (!r.ok)
        return NextResponse.json(
          {
            error: "Couldn't upload your photo. Please try again.",
            code: r.status,
          },
          { status: r.status },
        );
      const url = await store.mutation(api.bloom.uploadUrl, { secret: auth });
      const uploaded = await fetch(url, {
        method: "POST",
        headers: { "content-type": mime },
        body: bytes,
      });
      if (!uploaded.ok) throw new Error("Photo storage failed");
      const { storageId } = await uploaded.json();
      await store.mutation(api.bloom.recordPhoto, {
        secret: auth,
        owner,
        fileId: storageId,
      });
      return NextResponse.json(
        { fileId: storageId, w: meta.width, h: meta.height },
        { status: 201 },
      );
    }
    const b = await request.json();
    switch (b.action) {
      case "seed":
        await store.mutation(api.bloom.seed, {
          secret: auth,
          owner,
          memories: b.memories,
        });
        break;
      case "save": {
        const memory = z
          .object({
            id: z.string().optional(),
            fileId: z.string().optional(),
            title: z.string().min(1).max(80),
            caption: z.string().max(280),
            date: z.string(),
            w: z.number().positive(),
            h: z.number().positive(),
          })
          .parse(b.memory);
        return NextResponse.json({
          id: await store.mutation(api.bloom.save, {
            ...memory,
            id: memory.id as
              | import("@/convex/_generated/dataModel").Id<"memories">
              | undefined,
            fileId: memory.fileId as
              | import("@/convex/_generated/dataModel").Id<"_storage">
              | undefined,
            secret: auth,
            owner,
          }),
        });
      }
      case "delete":
        await store.mutation(api.bloom.remove, {
          secret: auth,
          owner,
          id: b.id,
          undo: !!b.undo,
        });
        break;
      case "message": {
        if (
          typeof b.text !== "string" ||
          !b.text.trim() ||
          b.text.length > 12000
        )
          throw new Error("Write a message");
        const previous = await store.query(api.bloom.conversation, {
            secret: auth,
            owner,
          }),
          newFeature = /pdf|dark mode|feature request/i.test(b.text);
        const c = newFeature ? null : previous;
        let ack: string | undefined;
        if (geminiReady())
          try {
            ack = await draft({
              customer: "Bloom user",
              channel: "chat",
              message: b.text,
              conversation: c,
            });
          } catch {}
        if (c) {
          await store.mutation(api.cue.message, {
            secret: auth,
            caseId: c.case._id,
            body: b.text,
            author: "Bloom user",
            role: "customer",
          });
          await store.mutation(api.cue.message, {
            secret: auth,
            caseId: c.case._id,
            body: ack || "Thanks — I've added that detail to your case.",
            author: "Cue",
            role: "cue",
          });
          if (b.attachment)
            await saveAttachment(b.attachment, owner, c.case._id);
          return NextResponse.json({ id: c.case._id });
        }
        const id = await store.mutation(api.cue.createCase, {
          secret: auth,
          title: b.text.slice(0, 80),
          body: b.text,
          customer: "Bloom user",
          channel: "chat",
          owner,
          ack,
        });
        if (b.attachment) await saveAttachment(b.attachment, owner, id);
        await triage(id);
        return NextResponse.json({ id });
      }
      default:
        throw new Error("Unknown action");
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
