import { ConvexError } from "convex/values";
import { env } from "./_generated/server";
export function authorize(secret: string) {
  const expected = env.BLOOM_SERVER_SECRET;
  if (!expected || expected.length < 32 || secret !== expected)
    throw new ConvexError("Unauthorized");
}
export function allowedOrigin(origin: string | null) {
  return (
    !!origin && (env.BLOOM_ALLOWED_ORIGINS || "").split(",").includes(origin)
  );
}
