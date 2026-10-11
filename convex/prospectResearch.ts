"use node";
import { v, ConvexError } from "convex/values";
import { action, env } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { actor } from "./workspaceValidators";
import { createCrustdata, prospectSearchInput } from "../lib/crustdata";
import {
  currentTraceId,
  observed,
  flushObservability,
} from "../lib/observability";
export const run = action({
  args: {
    secret: v.string(),
    actor,
    key: v.string(),
    query: v.string(),
    limit: v.number(),
  },
  returns: v.id("prospectRuns"),
  handler: async (ctx, a): Promise<Id<"prospectRuns">> => {
    if (!env.CUE_DEMO_SECRET || a.secret !== env.CUE_DEMO_SECRET)
      throw new ConvexError("Unauthorized");
    if (!["owner", "product"].includes(a.actor.role))
      throw new ConvexError("Owner or Product role required");
    const input = prospectSearchInput.parse({ query: a.query, limit: a.limit });
    if (!env.CRUSTDATA_API_KEY)
      throw new ConvexError("Crustdata is not configured");
    const provider = createCrustdata(env.CRUSTDATA_API_KEY);
    const reservedCredits = await provider.pricing(input.limit);
    const reservation = await ctx.runMutation(internal.prospects.begin, {
      ...input,
      actor: a.actor,
      key: a.key,
      reservedCredits,
    });
    if (!reservation.started) return reservation.runId;
    const execute = observed(
      "Cue potential customer research",
      async () => {
        try {
          const result = await provider.research(input);
          await ctx.runMutation(internal.prospects.finish, {
            runId: reservation.runId,
            ...result,
            traceId: currentTraceId() || null,
          });
        } catch (e) {
          const message =
            e instanceof Error && e.message.startsWith("Crustdata")
              ? e.message
              : "Crustdata research could not finish; saved reservation retained";
          await ctx.runMutation(internal.prospects.fail, {
            runId: reservation.runId,
            message,
            traceId: currentTraceId() || null,
          });
          throw new Error(message);
        }
        return { runId: reservation.runId };
      },
      { input: () => input },
    );
    try {
      await execute();
    } finally {
      await flushObservability();
    }
    return reservation.runId;
  },
});
