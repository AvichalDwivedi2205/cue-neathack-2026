import { Resend } from "resend";
import { api, db, secret } from "@/lib/server-store";
import { emailConfig } from "@/lib/integration-config";
import { triage } from "@/lib/triage";
import { normalizeEmail } from "@/lib/email-intake";
import { receivingMode } from "@/lib/email-routing";
import { after } from "next/server";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const config = await emailConfig();
  if (!config?.webhookSecret)
    return Response.json({ error: "Email not configured" }, { status: 503 });
  try {
    const resend = new Resend(config.apiKey),
      raw = await request.text();
    const event = resend.webhooks.verify({
      payload: raw,
      headers: {
        id: request.headers.get("svix-id") || "",
        timestamp: request.headers.get("svix-timestamp") || "",
        signature: request.headers.get("svix-signature") || "",
      },
      webhookSecret: config.webhookSecret,
    });
    if (event.type !== "email.received") return Response.json({ ok: true });
    const mode = receivingMode(event.data, config);
    if (!mode)
      return Response.json({
        ok: true,
        imported: 0,
        ignored: "Outside configured inbox or activation boundary",
      });
    const email = await resend.emails.receiving.get(event.data.email_id);
    if (email.error || !email.data) throw new Error("Email body unavailable");
    if (
      email.data.id !== event.data.email_id ||
      receivingMode(email.data, config) !== mode
    )
      throw new Error("Received email metadata changed");
    const normalized = normalizeEmail(email.data, mode === "notification");
    const store = db(),
      auth = secret();
    let imported = 0;
    for (const report of normalized.reports) {
      const result = await store.mutation(api.intake.receive, {
        secret: auth,
        ...report,
      });
      if (!result.duplicate) {
        imported++;
        after(async () => {
          await triage(result.caseId).catch(() => {});
        });
      }
    }
    return Response.json({ ok: true, imported, ignored: normalized.ignored });
  } catch {
    return Response.json(
      { error: "Invalid or unavailable email event" },
      { status: 400 },
    );
  }
}
