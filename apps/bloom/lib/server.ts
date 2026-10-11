import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { cookies } from "next/headers";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error("Bloom connection is not configured");
  return value;
};
export const secret = () => required("BLOOM_SERVER_SECRET");
export const db = () => new ConvexHttpClient(required("BLOOM_CONVEX_URL"));
export const origin = () => new URL(required("BLOOM_PUBLIC_URL")).origin;
export function sameOrigin(request: Request) {
  if (
    request.headers.get("origin") !== origin() ||
    request.headers.get("host") !== new URL(origin()).host
  )
    throw new Error("Origin not allowed");
}
export function validGuest(
  value: string | undefined,
  signingSecret: string,
): string | null {
  const [id, sig, extra] = (value || "").split(".");
  if (
    !id ||
    !/^[a-f0-9-]{36}$/.test(id) ||
    !sig ||
    !/^[a-f0-9]{64}$/.test(sig) ||
    extra
  )
    return null;
  const expected = createHmac("sha256", signingSecret)
    .update("bloom:" + id)
    .digest();
  return timingSafeEqual(Buffer.from(sig, "hex"), expected) ? id : null;
}
export async function guest() {
  const jar = await cookies();
  let id = validGuest(jar.get("bloom_visitor")?.value, secret());
  if (!id) {
    id = randomUUID();
    const sig = createHmac("sha256", secret())
      .update("bloom:" + id)
      .digest("hex");
    jar.set("bloom_visitor", id + "." + sig, {
      httpOnly: true,
      secure: origin().startsWith("https:"),
      sameSite: "strict",
      path: "/",
      maxAge: 30 * 86400,
    });
  }
  return id;
}
export function ticket() {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    hash: createHash("sha256").update(token).digest("hex"),
    url: required("BLOOM_CONVEX_SITE_URL") + "/upload",
  };
}
export async function supportToken(owner: string) {
  const store = db(),
    auth = { secret: secret(), owner };
  const saved = await store.query(api.support.get, {
    ...auth,
    now: Date.now(),
  });
  if (saved) return saved;
  const issued = await cue("/api/widget", { action: "session" });
  if (typeof issued.token !== "string" || issued.token.length > 2000)
    throw new Error("Support connection failed");
  return await store.mutation(api.support.attach, {
    ...auth,
    token: issued.token,
  });
}
export async function cue(
  path: "/api/widget" | "/api/voice",
  body: Record<string, unknown>,
) {
  const base = new URL(required("CUE_PUBLIC_URL")).origin;
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      ...body,
      app: required("CUE_WIDGET_APP_ID"),
      origin: origin(),
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(115000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : "Support temporarily unavailable",
    );
  return data as Record<string, unknown>;
}
export async function boundedJSON(
  request: Request,
  limit = 4_250_000,
): Promise<unknown> {
  if (Number(request.headers.get("content-length") || 0) > limit)
    throw new Error("Request too large");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > limit) throw new Error("Request too large");
  return JSON.parse(new TextDecoder().decode(bytes));
}
