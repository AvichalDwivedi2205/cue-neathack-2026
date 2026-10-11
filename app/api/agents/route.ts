import { z } from "zod";
import { operator, sameOrigin } from "@/lib/access";
import {
  workspaceInput,
  workspaceApp,
  workspaceSnapshot,
  postWorkspace,
} from "@/lib/workspace";
import { api, db, secret } from "@/lib/server-store";
import type { Id } from "@/convex/_generated/dataModel";
import { ConvexError } from "convex/values";
function publicError(e: unknown) {
  if (e instanceof ConvexError && typeof e.data === "string") return e.data;
  if (e instanceof z.ZodError) return "Invalid instruction or context";
  return "Agent request unavailable. Check sign-in and selected app, then retry.";
}
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const user = await operator(request),
      actor = { id: user.email, name: user.name, role: user.role };
    const { app } = await workspaceApp(
      new URL(request.url).searchParams.get("app") || undefined,
    );
    return Response.json(await workspaceSnapshot(app.id, actor), {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    return Response.json({ error: publicError(e) }, { status: 401 });
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const user = await operator(request),
      actor = { id: user.email, name: user.name, role: user.role };
    const raw = await request.text();
    if (raw.length > 8000) throw new Error("Instruction too long");
    const body = JSON.parse(raw);
    if (["cancel", "retry"].includes(body.action)) {
      const a = z
        .object({
          action: z.enum(["cancel", "retry"]),
          appId: z.string(),
          taskId: z.string(),
        })
        .strict()
        .parse(body);
      await workspaceApp(a.appId);
      await db().mutation(
        a.action === "cancel" ? api.workspace.cancel : api.workspace.retry,
        {
          secret: secret(),
          appId: a.appId,
          taskId: a.taskId as Id<"agentTasks">,
          actor,
        },
      );
      return Response.json({ ok: true });
    }
    return Response.json(
      await postWorkspace(workspaceInput.parse(body), actor),
    );
  } catch (e) {
    return Response.json({ error: publicError(e) }, { status: 400 });
  }
}
