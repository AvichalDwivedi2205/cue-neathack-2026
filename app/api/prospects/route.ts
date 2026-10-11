import { z } from "zod";
import { operator, sameOrigin } from "@/lib/access";
import { api, db, secret } from "@/lib/server-store";
import { prospectSearchInput } from "@/lib/crustdata";
import type { Id } from "@/convex/_generated/dataModel";
export const runtime = "nodejs";
const input = z.discriminatedUnion("action", [
  prospectSearchInput
    .extend({
      action: z.literal("search"),
      key: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("review"),
      companyId: z.string().min(1).max(100),
      disposition: z.enum(["candidate", "shortlisted", "dismissed"]),
    })
    .strict(),
]);
export async function GET(request: Request) {
  try {
    const user = await operator(request);
    const saved = await db().query(api.prospects.snapshot, {
      secret: secret(),
    });
    return Response.json(
      { ...saved, canResearch: ["owner", "product"].includes(user.role) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Sign in to Cue to view customer research" },
      { status: 401 },
    );
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const user = await operator(request);
    if (!["owner", "product"].includes(user.role))
      return Response.json(
        { error: "Owner or Product role required" },
        { status: 403 },
      );
    const raw = await request.text();
    if (raw.length > 2000) throw new Error("Invalid request");
    const a = input.parse(JSON.parse(raw)),
      actor = { id: user.email, name: user.name, role: user.role };
    if (a.action === "search") {
      const runId = await db().action(api.prospectResearch.run, {
        secret: secret(),
        actor,
        key: a.key,
        query: a.query,
        limit: a.limit,
      });
      return Response.json({ ok: true, runId });
    }
    await db().mutation(api.prospects.review, {
      secret: secret(),
      actor,
      companyId: a.companyId as Id<"prospectCompanies">,
      disposition: a.disposition,
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json(
      {
        error:
          "Research could not complete. Refresh to inspect the saved run; check access, balance and the daily search limit.",
      },
      { status: 400 },
    );
  }
}
