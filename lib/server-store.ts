import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
export function db() {
  const url = process.env.CUE_CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("Convex URL is not configured");
  return new ConvexHttpClient(url);
}
export function secret() {
  if (!process.env.CUE_DEMO_SECRET)
    throw new Error("Cue server secret is not configured");
  return process.env.CUE_DEMO_SECRET;
}
export { api };
