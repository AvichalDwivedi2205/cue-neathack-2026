import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { secret } from "./server-store";
import type { WidgetApp } from "./integration-config";
const payload = z.object({
  app: z.string(),
  origin: z.string(),
  visitor: z.uuid(),
  expires: z.number(),
});
const signature = (value: string) =>
  createHmac("sha256", secret())
    .update("widget:" + value)
    .digest();
export function issueWidgetSession(app: WidgetApp, origin: string) {
  if (!app.origins.includes(origin))
    throw new Error("App origin is not allowed");
  const value = Buffer.from(
    JSON.stringify({
      app: app.id,
      origin,
      visitor: randomUUID(),
      expires: Date.now() + 30 * 86400000,
    }),
  ).toString("base64url");
  return value + "." + signature(value).toString("base64url");
}
export function verifyWidgetSession(
  token: string,
  app: WidgetApp,
  origin: string,
) {
  const [value, sig, extra] = token.split(".");
  if (!value || !sig || extra || token.length > 2000)
    throw new Error("Invalid widget session");
  const got = Buffer.from(sig, "base64url"),
    expected = signature(value);
  if (got.length !== expected.length || !timingSafeEqual(got, expected))
    throw new Error("Invalid widget session");
  const data = payload.parse(
    JSON.parse(Buffer.from(value, "base64url").toString()),
  );
  if (
    data.app !== app.id ||
    data.origin !== origin ||
    !app.origins.includes(origin) ||
    data.expires <= Date.now()
  )
    throw new Error("Widget session expired or belongs to another app");
  return "widget:" + app.id + ":" + data.visitor;
}
const limits = new Map<string, { start: number; count: number }>();
export function widgetRateLimit(key: string, max = 30) {
  const now = Date.now();
  if (limits.size > 10000)
    for (const [k, v] of limits) if (now - v.start > 60000) limits.delete(k);
  const current = limits.get(key);
  if (!current || now - current.start > 60000) {
    limits.set(key, { start: now, count: 1 });
    return;
  }
  if (++current.count > max)
    throw new Error("Too many requests. Try again in a minute.");
}
