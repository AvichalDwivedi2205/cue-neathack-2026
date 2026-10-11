"use node";
import { v } from "convex/values";
import { internalAction, env } from "./_generated/server";

async function dispatch(body: unknown) {
  if (!env.CUE_BACKGROUND_ORIGIN || !env.CUE_DEMO_SECRET)
    throw new Error("Hosted processing is not configured");
  const origin = new URL(env.CUE_BACKGROUND_ORIGIN);
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error("Invalid hosted processing origin");
  const response = await fetch(origin.origin + "/api/background", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout((body as { action?: string }).action === "knowledge" ? 240000 : 55000),
    headers: {
      authorization: "Bearer " + env.CUE_DEMO_SECRET,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok || (await response.json()).ok !== true)
    throw new Error("Hosted processing failed");
}
export const triage = internalAction({
  args: { receiptId: v.id("triageReceipts") },
  returns: v.null(),
  handler: async (_ctx, a) => {
    await dispatch({ action: "triage", receiptId: a.receiptId });
    return null;
  },
});
export const pollX = internalAction({
  args: {},
  returns: v.null(),
  handler: async () => {
    if (!env.CUE_BACKGROUND_ORIGIN) return null;
    await dispatch({ action: "poll-x" });
    return null;
  },
});
export const workspace = internalAction({
  args: { taskId: v.id("agentTasks") },
  returns: v.null(),
  handler: async (_ctx, a) => {
    await dispatch({ action: "workspace", taskId: a.taskId });
    return null;
  },
});
export const growth = internalAction({
  args: { receiptId: v.id("growthReceipts") },
  returns: v.null(),
  handler: async (_ctx, a) => {
    await dispatch({ action: "growth", receiptId: a.receiptId });
    return null;
  },
});
export const workspaceAnswer = internalAction({
  args: { commandId: v.id("agentCommands") },
  returns: v.null(),
  handler: async (_ctx, a) => {
    await dispatch({ action: "workspace-answer", commandId: a.commandId });
    return null;
  },
});
export const knowledge = internalAction({
  args: { sourceId: v.id("knowledgeSources"), versionId: v.id("knowledgeVersions") },
  returns: v.null(),
  handler: async (_ctx, a) => { await dispatch({ action: "knowledge", ...a }); return null; },
});
