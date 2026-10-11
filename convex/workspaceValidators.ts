import { v } from "convex/values";
export const agentId = v.union(
  v.literal("x"),
  v.literal("reddit"),
  v.literal("growth"),
  v.literal("engineering"),
);
export const taskState = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("awaiting"),
  v.literal("blocked"),
  v.literal("retrying"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("canceled"),
  v.literal("canceling"),
);
export const taskAction = v.union(
  v.literal("recommendation"),
  v.literal("discover"),
  v.literal("qualify"),
  v.literal("draft"),
  v.literal("collect"),
  v.literal("investigate"),
  v.literal("delegate"),
);
export const commandAction = v.union(
  v.literal("collect"),
  v.literal("investigate"),
  v.literal("delegate"),
);
export const actor = v.object({
  id: v.string(),
  name: v.string(),
  role: v.union(
    v.literal("owner"),
    v.literal("engineering"),
    v.literal("product"),
    v.literal("support"),
  ),
});
