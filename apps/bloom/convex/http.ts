import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { allowedOrigin } from "./access";
const http = httpRouter(),
  maxBytes = 5 * 1024 * 1024;
const cors = (origin: string) => ({
  "access-control-allow-origin": origin,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type",
  vary: "Origin",
  "cache-control": "no-store",
});
http.route({
  path: "/upload",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, req) => {
    const origin = req.headers.get("origin");
    return new Response(null, {
      status: allowedOrigin(origin) ? 204 : 403,
      headers: origin && allowedOrigin(origin) ? cors(origin) : {},
    });
  }),
});
http.route({
  path: "/upload",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const origin = req.headers.get("origin");
    if (!origin || !allowedOrigin(origin))
      return Response.json({ error: "Origin not allowed" }, { status: 403 });
    const headers = cors(origin);
    if (Number(req.headers.get("content-length") || 0) > maxBytes)
      return Response.json(
        { error: "Photo must be 5 MB or smaller" },
        { status: 413, headers },
      );
    const mime = req.headers.get("content-type") || "";
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime))
      return Response.json(
        { error: "Use JPG, PNG or WebP" },
        { status: 415, headers },
      );
    const token =
      req.headers.get("authorization")?.replace(/^Bearer /, "") || "";
    if (!/^[a-f0-9]{64}$/.test(token))
      return Response.json(
        { error: "Invalid upload ticket" },
        { status: 401, headers },
      );
    const bytes = await req.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > maxBytes)
      return Response.json(
        { error: "Photo must be 5 MB or smaller" },
        { status: 413, headers },
      );
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
      ),
    )
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    let owner: string;
    try {
      owner = await ctx.runMutation(internal.uploads.claim, {
        tokenHash: hash,
      });
    } catch {
      return Response.json(
        { error: "Upload ticket expired or already used" },
        { status: 401, headers },
      );
    }
    const fileId = await ctx.storage.store(new Blob([bytes], { type: mime }));
    try {
      await ctx.runMutation(internal.uploads.record, { owner, fileId });
    } catch {
      await ctx.storage.delete(fileId);
      return Response.json(
        { error: "Photo storage failed. Try again." },
        { status: 503, headers },
      );
    }
    return Response.json({ fileId }, { status: 201, headers });
  }),
});
export default http;
