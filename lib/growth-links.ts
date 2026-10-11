import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { secret } from "./server-store";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function issueGrowthToken() {
  const opaque = randomBytes(24).toString("base64url");
  return (
    opaque +
    "." +
    createHmac("sha256", secret())
      .update("growth-link:" + opaque)
      .digest("hex")
  );
}
export function validGrowthToken(token: string) {
  const [opaque, sig, extra] = token.split(".");
  if (
    extra ||
    !opaque ||
    !/^[-_a-zA-Z0-9]{32}$/.test(opaque) ||
    !sig ||
    !/^[a-f0-9]{64}$/.test(sig)
  )
    return false;
  const expected = createHmac("sha256", secret())
    .update("growth-link:" + opaque)
    .digest();
  return timingSafeEqual(Buffer.from(sig, "hex"), expected);
}
export function growthEventSecret(appId: string) {
  const map = JSON.parse(
    process.env.CUE_GROWTH_EVENT_SECRETS || "{}",
  ) as Record<string, string>;
  const key = map[appId];
  if (!key || key.length < 32)
    throw new Error("App event signing not configured");
  return key;
}
export function validEventSignature(
  appId: string,
  body: string,
  stamp: string,
  sig: string,
) {
  if (
    !/^\d{13}$/.test(stamp) ||
    Math.abs(Date.now() - Number(stamp)) > 300000 ||
    !/^[a-f0-9]{64}$/.test(sig)
  )
    return false;
  const expected = createHmac("sha256", growthEventSecret(appId))
    .update(stamp + "." + body)
    .digest();
  return timingSafeEqual(Buffer.from(sig, "hex"), expected);
}
