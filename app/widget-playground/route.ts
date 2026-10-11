import { readIntegrations } from "@/lib/integration-config";
const escape = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export async function GET(request: Request) {
  const url = new URL(request.url),
    origin =
      process.env.CUE_PUBLIC_URL ||
      `${url.protocol}//${request.headers.get("host") || url.host}`,
    app = (await readIntegrations()).apps.find(
      (a) => a.id === url.searchParams.get("app"),
    );
  if (!app || !app.origins.includes(origin))
    return new Response(
      "Add this Cue origin to the app's allowed origins to use this playground.",
      { status: 403 },
    );
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(app.name)} · Cue widget test</title><body style="font:16px system-ui;padding:60px;color:#26392e;background:#fafbf7"><a href="/setup#widget">← Widget setup</a><h1>${escape(app.name)}</h1><p>This page uses the same public install script as your app.</p><p>Click Get help. Send a message, reload, and check that your conversation remains.</p><script async src="/widget.js" data-app="${escape(app.id)}" data-name="Visitor"></script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}
