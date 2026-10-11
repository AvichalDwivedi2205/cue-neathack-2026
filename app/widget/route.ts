import { readIntegrations } from "@/lib/integration-config";
export async function GET(request: Request) {
  const url = new URL(request.url),
    origin = url.searchParams.get("origin");
  const app = (await readIntegrations()).apps.find(
    (a) => a.id === url.searchParams.get("app"),
  );
  if (!app || !origin || !app.origins.includes(origin))
    return new Response("This app is not connected to Cue.", { status: 403 });
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cue support</title><link rel="stylesheet" href="/widget-frame.css"><link rel="stylesheet" href="/cue-voice.css"><body><header><div><strong id="brand">App support</strong><small>We’re here to help</small></div><button id="close" aria-label="Close support">×</button></header><main id="messages" aria-live="polite"></main><footer><p id="status" role="status">Connecting…</p><form id="composer"><textarea id="message" aria-label="Support message" placeholder="Describe your issue…" maxlength="12000" required></textarea><div><label class="file">Add screenshot<input id="attachment" aria-label="Add screenshot" type="file" accept="image/png,image/jpeg,image/webp"></label><button type="button" id="voice">Talk to Cue</button><button id="send" disabled>Send</button></div></form></footer><script src="/cue-voice.js"></script><script src="/widget-frame.js"></script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors ${app.origins.join(" ")}; form-action 'none'; base-uri 'none'`,
      },
    },
  );
}
