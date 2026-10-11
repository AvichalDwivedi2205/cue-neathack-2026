import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { api, db, secret } from "@/lib/server-store";
import { pollHostedX } from "@/lib/hosted-background";
import { classifySavedReport } from "@/lib/triage";
import type { Id } from "@/convex/_generated/dataModel";
import { randomUUID } from "node:crypto";
import { processGrowth } from "@/lib/growth";
import { answerWorkspace } from "@/lib/workspace-answer";
import { indexKnowledge } from "@/lib/knowledge-embedding";
export const runtime = "nodejs";
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("knowledge"), sourceId: z.string().min(1).max(100), versionId: z.string().min(1).max(100) }).strict(),
  z
    .object({
      action: z.literal("workspace-answer"),
      commandId: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("growth"),
      receiptId: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("workspace"),
      taskId: z.string().min(1).max(100),
    })
    .strict(),
  z.object({ action: z.literal("poll-x") }).strict(),
  z
    .object({
      action: z.literal("triage"),
      receiptId: z.string().min(1).max(100),
    })
    .strict(),
]);
export async function POST(request: Request) {
  const expected = Buffer.from("Bearer " + secret()),
    supplied = Buffer.from(request.headers.get("authorization") || "");
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  )
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const raw = await request.text();
    if (raw.length > 512)
      return Response.json({ error: "Invalid job" }, { status: 400 });
    const parsed = input.safeParse(JSON.parse(raw));
    if (!parsed.success)
      return Response.json({ error: "Invalid job" }, { status: 400 });
    if (parsed.data.action === "knowledge")
      await indexKnowledge(parsed.data.sourceId as Id<"knowledgeSources">, parsed.data.versionId as Id<"knowledgeVersions">);
    else if (parsed.data.action === "workspace-answer")
      await answerWorkspace(parsed.data.commandId as Id<"agentCommands">);
    else if (parsed.data.action === "growth")
      await processGrowth(parsed.data.receiptId as Id<"growthReceipts">);
    else if (parsed.data.action === "workspace") {
      const taskId = parsed.data.taskId as Id<"agentTasks">,
        token = randomUUID();
      const task = await db().mutation(api.workspace.begin, {
        secret: secret(),
        taskId,
        token,
      });
      if (task) {
        try {
          const status = await pollHostedX();
          if (!status?.connected)
            throw new Error("Collection skipped or unavailable");
          await db().mutation(api.workspace.finish, {
            secret: secret(),
            taskId,
            token,
            ok: true,
            detail: status.detail,
          });
        } catch {
          await db().mutation(api.workspace.finish, {
            secret: secret(),
            taskId,
            token,
            ok: false,
            detail:
              "Official collection unavailable. Shared checkpoint preserved; bounded retry pending.",
          });
          throw new Error("Collection unavailable");
        }
      }
    } else if (parsed.data.action === "poll-x") await pollHostedX();
    else {
      const receiptId = parsed.data.receiptId as Id<"triageReceipts">;
      const receipt = await db().query(api.triageQueue.receipt, {
        secret: secret(),
        receiptId,
      });
      if (!receipt)
        return Response.json({ error: "Unknown job" }, { status: 400 });
      if (receipt.status === "queued") {
        if (!receipt.latest)
          await db().mutation(api.triageQueue.supersede, {
            secret: secret(),
            receiptId,
          });
        else await classifySavedReport(receipt.caseId, receiptId);
      }
    }
    return Response.json({ ok: true });
  } catch {
    return Response.json(
      { error: "Processing unavailable; job remains saved" },
      { status: 503 },
    );
  }
}
