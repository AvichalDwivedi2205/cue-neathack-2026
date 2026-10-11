import { mutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { authorize } from "./cue";
import type { Id } from "./_generated/dataModel";
import { socialSource } from "../lib/social-source";
import { knowledgeReply } from "./knowledgeSchema";
import { currentHits } from "./knowledge";

export const widgetMessage = mutation({
  args: {
    secret: v.string(),
    owner: v.string(),
    appId: v.string(),
    customer: v.string(),
    title: v.string(),
    body: v.string(),
    initialBody: v.string(),
    sourceUrl: v.string(),
    ack: v.optional(v.string()),
    knowledge: v.optional(knowledgeReply),
  },
  returns: v.object({ caseId: v.id("cases"), created: v.boolean() }),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const knowledge = a.knowledge;
    const validKnowledge =
      !knowledge ||
      (knowledge.usedChunkIds.length <= 4 &&
        knowledge.citedChunkIds.every((id) =>
          knowledge.usedChunkIds.includes(id),
        ) &&
        (
          await currentHits(
            ctx,
            knowledge.usedChunkIds,
            knowledge.workspaceId,
            a.appId,
            "customer",
          )
        ).length === knowledge.usedChunkIds.length);
    const ack = validKnowledge
      ? a.ack
      : "The published information changed while I was answering. Please ask again so I can use the current version.";
    const recordEvidence = async (
      caseId: Id<"cases">,
      messageId: Id<"messages">,
    ) => {
      if (!knowledge || !validKnowledge) return;
      await ctx.db.insert("knowledgeEvidence", {
        messageId,
        caseId,
        workspaceId: knowledge.workspaceId,
        appId: a.appId,
        chunkIds: knowledge.citedChunkIds,
        usedChunkIds: knowledge.usedChunkIds,
        ...(knowledge.retrieval ? { retrieval: knowledge.retrieval } : {}),
        status: knowledge.status,
        provider: knowledge.provider,
        model: knowledge.model,
        inputTokens: knowledge.inputTokens,
        outputTokens: knowledge.outputTokens,
        createdAt: Date.now(),
      });
    };
    if (
      !a.owner.startsWith(`widget:${a.appId}:`) ||
      !a.body.trim() ||
      a.body.length > 12000
    )
      throw new ConvexError("Invalid widget message");
    const existing = await ctx.db
      .query("cases")
      .withIndex("by_sourceKey", (q) => q.eq("sourceKey", a.owner))
      .unique();
    if (existing) {
      if (
        existing.owner !== a.owner ||
        existing.appId !== a.appId ||
        existing.channel !== "chat"
      )
        throw new ConvexError("Wrong app conversation");
      await ctx.db.insert("messages", {
        caseId: existing._id,
        author: a.customer,
        body: a.body,
        role: "customer",
        createdAt: Date.now(),
      });
      if (ack) {
        const messageId = await ctx.db.insert("messages", {
          caseId: existing._id,
          author: "Cue",
          body: ack,
          role: "cue",
          createdAt: Date.now(),
        });
        await recordEvidence(existing._id, messageId);
      }
      await ctx.db.patch("cases", existing._id, { updatedAt: Date.now() });
      await ctx.runMutation(internal.triageQueue.enqueue, {
        caseId: existing._id,
      });
      return { caseId: existing._id, created: false };
    }
    const caseId: Id<"cases"> = await ctx.runMutation(api.cue.createCase, {
      secret: a.secret,
      owner: a.owner,
      sourceKey: a.owner,
      appId: a.appId,
      customer: a.customer,
      channel: "chat",
      title: a.title,
      body: a.initialBody,
      sourceUrl: a.sourceUrl,
      ack,
    });
    if (ack) {
      const message = await ctx.db
        .query("messages")
        .withIndex("by_caseId_and_role_and_createdAt", (q) =>
          q.eq("caseId", caseId).eq("role", "cue"),
        )
        .order("desc")
        .first();
      if (message) await recordEvidence(caseId, message._id);
    }
    return { caseId, created: true };
  },
});

// Trusted gateways call this after verifying provider signatures or Socket Mode.
// Receipt, thread append and case creation commit together, including nested calls.
export const receive = mutation({
  args: {
    secret: v.string(),
    channel: v.union(
      v.literal("slack"),
      v.literal("email"),
      v.literal("x"),
      v.literal("reddit"),
    ),
    transport: v.optional(
      v.union(v.literal("notification_email"), v.literal("x_api")),
    ),
    eventKey: v.string(),
    sourceKey: v.string(),
    messageKey: v.optional(v.string()),
    references: v.optional(v.array(v.string())),
    externalId: v.optional(v.string()),
    customer: v.string(),
    title: v.string(),
    body: v.string(),
    sourceUrl: v.optional(v.string()),
  },
  returns: v.object({ caseId: v.id("cases"), duplicate: v.boolean() }),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const social = a.channel === "x" || a.channel === "reddit";
    if (social) {
      const source = socialSource(
        a.channel as "x" | "reddit",
        a.sourceUrl || "",
      );
      const nativeX = a.channel === "x" && a.transport === "x_api";
      if (
        (!nativeX && a.transport !== "notification_email") ||
        source.key !== a.sourceKey ||
        (nativeX &&
          (a.eventKey !== `x-api:${source.key}` ||
            a.externalId !== `x-api:${source.key}`))
      )
        throw new ConvexError("Invalid notification source");
    } else if (a.transport) throw new ConvexError("Wrong notification channel");
    if (
      !a.body.trim() ||
      a.body.length > 12000 ||
      a.title.length > 200 ||
      a.customer.length > 100 ||
      a.eventKey.length > 1000 ||
      a.sourceKey.length > 1000 ||
      (a.references?.length || 0) > 20
    )
      throw new ConvexError("Invalid provider event");
    const receipt = await ctx.db
      .query("externalEvents")
      .withIndex("by_key", (q) => q.eq("key", a.eventKey))
      .unique();
    if (receipt) return { caseId: receipt.caseId, duplicate: true };
    if (a.messageKey) {
      const messageReceipt = await ctx.db
        .query("externalEvents")
        .withIndex("by_messageKey", (q) => q.eq("messageKey", a.messageKey))
        .unique();
      if (messageReceipt)
        return { caseId: messageReceipt.caseId, duplicate: true };
    }
    let c = await ctx.db
      .query("cases")
      .withIndex("by_sourceKey", (q) => q.eq("sourceKey", a.sourceKey))
      .unique();
    for (const messageKey of [...(a.references || [])].reverse()) {
      if (c) break;
      const parent = await ctx.db
        .query("externalEvents")
        .withIndex("by_messageKey", (q) => q.eq("messageKey", messageKey))
        .unique();
      if (parent) c = await ctx.db.get("cases", parent.caseId);
      if (c && a.channel === "email" && c.customer !== a.customer) c = null;
    }
    let caseId: Id<"cases">;
    if (c) {
      if (c.channel !== a.channel)
        throw new ConvexError("Wrong channel for thread");
      caseId = c._id;
      if (social) {
        await ctx.db.insert("externalEvents", {
          key: a.eventKey,
          caseId,
          createdAt: Date.now(),
        });
        return { caseId, duplicate: true };
      }
      await ctx.db.insert("messages", {
        caseId,
        body: a.body,
        author: a.customer,
        role: "customer",
        createdAt: Date.now(),
      });
      await ctx.db.patch("cases", caseId, {
        updatedAt: Date.now(),
        externalId: a.externalId,
      });
      await ctx.runMutation(internal.triageQueue.enqueue, { caseId });
    } else {
      caseId = await ctx.runMutation(api.cue.createCase, {
        secret: a.secret,
        channel: a.channel,
        sourceKey: a.sourceKey,
        sourceUrl: a.sourceUrl,
        body: a.body,
        customer: a.customer,
        title: a.title,
      });
      if (a.externalId)
        await ctx.db.patch("cases", caseId, { externalId: a.externalId });
      if (social)
        await ctx.db.patch("cases", caseId, {
          provenance:
            a.transport === "x_api"
              ? "Imported from official X API · public post and author supplied by X"
              : `Imported ${a.channel === "x" ? "X" : "Reddit"} notification email · content and author unverified`,
        });
    }
    await ctx.db.insert("externalEvents", {
      key: a.eventKey,
      messageKey: a.messageKey,
      caseId,
      createdAt: Date.now(),
    });
    return { caseId, duplicate: false };
  },
});
