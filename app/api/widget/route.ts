import { z } from "zod";
import { sameOrigin } from "@/lib/access";
import { readIntegrations } from "@/lib/integration-config";
import {
  issueWidgetSession,
  verifyWidgetSession,
  widgetRateLimit,
} from "@/lib/widget-session";
import { api, db, secret } from "@/lib/server-store";
import { saveAttachment } from "@/lib/attachment";
import { triage } from "@/lib/triage";
import { supportProgress } from "@/lib/support-progress";
import { draft, geminiReady } from "@/lib/gemini";
import { fallbackReply } from "@/lib/reply-policy";
const input = z.object({
  action: z.enum(["session", "read", "message"]),
  app: z.string().max(100),
  origin: z.string().url(),
  token: z.string().max(2000).optional(),
  text: z.string().trim().min(1).max(12000).optional(),
  name: z.string().trim().max(80).optional(),
  page: z.string().max(2000).optional(),
  attachment: z.string().max(6000000).optional(),
});
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    if (Number(request.headers.get("content-length") || 0) > 6500000)
      throw new Error("Request too large");
    const b = input.parse(await request.json());
    const app = (await readIntegrations()).apps.find((a) => a.id === b.app);
    if (!app || !app.origins.includes(b.origin))
      return Response.json(
        { error: "App origin is not allowed" },
        { status: 403 },
      );
    if (b.action === "session") {
      widgetRateLimit("session:" + app.id, 120);
      return Response.json(
        { token: issueWidgetSession(app, b.origin), name: app.name },
        { headers: { "cache-control": "no-store" } },
      );
    }
    const owner = verifyWidgetSession(b.token || "", app, b.origin);
    widgetRateLimit(owner + ":" + b.action, b.action === "message" ? 12 : 60);
    const store = db(),
      auth = secret();
    if (b.action === "read") {
      const previous = await store.query(api.bloom.conversation, {
        secret: auth,
        owner,
      });
      return Response.json(
        {
          name: app.name,
          progress: previous ? supportProgress(previous) : null,
          attachments: previous?.attachments || [],
          case: previous?.case
            ? {
                id: previous.case._id,
                status: previous.case.status,
                title: previous.case.title,
              }
            : null,
          messages:
            previous?.messages
              .filter((m) => ["customer", "cue", "staff"].includes(m.role))
              .map((m) => ({
                id: m._id,
                body: m.body,
                author: m.author,
                role: m.role,
              })) || [],
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (!b.text) throw new Error("Write a message");
    const customer = b.name || "Guest";
    const context =
      b.page && new URL(b.page).origin === b.origin
        ? new URL(b.page).origin + new URL(b.page).pathname
        : b.origin;
    const replyContext = {
      customer,
      appName: app.name,
      channel: "chat",
      message: b.text,
      conversation: await store.query(api.bloom.conversation, {
        secret: auth,
        owner,
      }),
    };
    let ack = fallbackReply({ ...replyContext.conversation, ...replyContext });
    if (geminiReady())
      try {
        ack = await draft(replyContext);
      } catch {}
    const { caseId: id, created } = await store.mutation(
      api.intake.widgetMessage,
      {
        secret: auth,
        owner,
        customer,
        appId: app.id,
        title: `${app.name}: ${b.text.slice(0, 100)}`,
        body: b.text,
        initialBody: b.text,
        sourceUrl: context,
        ack,
      },
    );
    if (b.attachment) await saveAttachment(b.attachment, owner, id);
    if (created) await triage(id);
    return Response.json({ id });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Widget request failed";
    return Response.json(
      { error },
      {
        status: /session|belongs/.test(error)
          ? 401
          : /Too many/.test(error)
            ? 429
            : 400,
      },
    );
  }
}
