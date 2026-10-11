import { createHmac } from "node:crypto";
import { db, secret } from "./server";
import { api } from "../convex/_generated/api";
export async function attachCampaign(owner: string, token: string) {
  const key = process.env.BLOOM_GROWTH_EVENT_SECRET,
    appId = process.env.CUE_WIDGET_APP_ID,
    base = process.env.CUE_PUBLIC_URL;
  if (!key || !appId || !base)
    throw new Error("Campaign event connection unavailable");
  const origin = new URL(base).origin;
  const body = JSON.stringify({ action: "exchange", appId, token }),
    stamp = String(Date.now()),
    signature = createHmac("sha256", key)
      .update(stamp + "." + body)
      .digest("hex");
  const r = await fetch(origin + "/api/growth/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cue-timestamp": stamp,
      "x-cue-signature": signature,
    },
    body,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error("Campaign attribution rejected");
  const data = await r.json();
  if (
    typeof data.touchId !== "string" ||
    typeof data.expiresAt !== "number" ||
    typeof data.internal !== "boolean"
  )
    throw new Error("Invalid campaign exchange");
  const browser = createHmac("sha256", key)
    .update("growth-browser:" + appId + ":" + owner)
    .digest("hex");
  await db().mutation(api.growth.attach, {
    secret: secret(),
    owner,
    touchId: data.touchId,
    expiresAt: data.expiresAt,
    internal: data.internal,
    browser,
  });
}
