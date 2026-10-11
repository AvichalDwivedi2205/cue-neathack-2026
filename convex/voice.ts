import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { authorize } from "./cue";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { knowledgeReply } from "./knowledgeSchema";
import { currentHits } from "./knowledge";

function active(session: Doc<"voiceSessions"> | null, owner: string) {
  if (!session || session.owner !== owner)
    throw new ConvexError("Voice session not found");
  if (
    session.status !== "active" ||
    Date.now() - session.createdAt > 15 * 60_000
  )
    throw new ConvexError("Voice session ended. Start a new conversation.");
  return session;
}
export const start = mutation({
  args: {
    secret: v.string(),
    owner: v.string(),
    customer: v.string(),
    appId: v.optional(v.string()),
  },
  returns: v.id("voiceSessions"),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const old = await ctx.db
      .query("voiceSessions")
      .withIndex("by_owner_and_status", (q) =>
        q.eq("owner", a.owner).eq("status", "active"),
      )
      .first();
    if (old && Date.now() - old.createdAt < 15 * 60_000) return old._id;
    if (old)
      await ctx.db.patch("voiceSessions", old._id, {
        status: "ended",
        endedAt: Date.now(),
      });
    const c = await ctx.db
      .query("cases")
      .withIndex("by_owner", (q) => q.eq("owner", a.owner))
      .order("desc")
      .first();
    return await ctx.db.insert("voiceSessions", {
      owner: a.owner,
      customer: a.customer.slice(0, 80),
      appId: a.appId,
      caseId: c?.appId === a.appId ? c?._id : undefined,
      status: "active",
      createdAt: Date.now(),
      turnCount: 0,
    });
  },
});
export const get = query({
  args: {
    secret: v.string(),
    owner: v.string(),
    sessionId: v.id("voiceSessions"),
  },
  returns: schema.doc("voiceSessions"),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const s = await ctx.db.get("voiceSessions", a.sessionId);
    if (!s || s.owner !== a.owner)
      throw new ConvexError("Voice session not found");
    return s;
  },
});
export const claim = mutation({
  args: {
    secret: v.string(),
    owner: v.string(),
    sessionId: v.id("voiceSessions"),
    key: v.string(),
  },
  returns: v.union(v.null(), schema.doc("voiceTurns")),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const s = active(await ctx.db.get("voiceSessions", a.sessionId), a.owner);
    if (!/^[a-f0-9-]{36}$/.test(a.key))
      throw new ConvexError("Invalid voice turn");
    const done = await ctx.db
      .query("voiceTurns")
      .withIndex("by_sessionId_and_key", (q) =>
        q.eq("sessionId", s._id).eq("key", a.key),
      )
      .unique();
    if (done) return done;
    if (s.turnCount >= 30) throw new ConvexError("Voice session limit reached");
    if (s.pendingTurn && Date.now() - (s.pendingAt || 0) < 120_000)
      throw new ConvexError("Voice turn is still processing");
    await ctx.db.patch("voiceSessions", s._id, {
      pendingTurn: a.key,
      pendingAt: Date.now(),
    });
    return null;
  },
});
export const release = mutation({
  args: {
    secret: v.string(),
    owner: v.string(),
    sessionId: v.id("voiceSessions"),
    key: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const s = await ctx.db.get("voiceSessions", a.sessionId);
    if (s?.owner === a.owner && s.pendingTurn === a.key)
      await ctx.db.patch("voiceSessions", s._id, {
        pendingTurn: undefined,
        pendingAt: undefined,
      });
    return null;
  },
});
export const finish = mutation({
  args: {
    secret: v.string(),
    owner: v.string(),
    sessionId: v.id("voiceSessions"),
    key: v.string(),
    transcript: v.string(),
    reply: v.string(),
    knowledge: v.optional(knowledgeReply),
  },
  returns: v.id("cases"),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const s = active(await ctx.db.get("voiceSessions", a.sessionId), a.owner);
    const done = await ctx.db
      .query("voiceTurns")
      .withIndex("by_sessionId_and_key", (q) =>
        q.eq("sessionId", s._id).eq("key", a.key),
      )
      .unique();
    if (done && s.caseId) return s.caseId;
    if (s.pendingTurn !== a.key)
      throw new ConvexError("Voice turn changed or ended");
    if (
      !a.transcript.trim() ||
      a.transcript.length > 6000 ||
      !a.reply.trim() ||
      a.reply.length > 12000
    )
      throw new ConvexError("Invalid voice transcript");
    const k = a.knowledge;
    const validKnowledge =
      !k ||
      (!!s.appId &&
        k.usedChunkIds.length <= 4 &&
        k.citedChunkIds.every((id) => k.usedChunkIds.includes(id)) &&
        (
          await currentHits(
            ctx,
            k.usedChunkIds,
            k.workspaceId,
            s.appId,
            "customer",
          )
        ).length === k.usedChunkIds.length);
    const reply = validKnowledge
      ? a.reply
      : "The published information changed while I was answering. Please ask again so I can use the current version.";
    let id: Id<"cases">;
    if (s.caseId) {
      const c = await ctx.db.get("cases", s.caseId);
      if (!c || c.owner !== a.owner || c.appId !== s.appId)
        throw new ConvexError("Voice case not found");
      id = c._id;
      for (const [role, author, body] of [
        ["customer", s.customer, a.transcript],
        ["cue", "Cue", reply],
      ])
        await ctx.db.insert("messages", {
          caseId: id,
          role,
          author,
          body,
          createdAt: Date.now(),
        });
      await ctx.db.patch("cases", id, { updatedAt: Date.now() });
    } else {
      id = await ctx.runMutation(api.cue.createCase, {
        secret: a.secret,
        owner: a.owner,
        appId: s.appId,
        customer: s.customer,
        title: a.transcript.slice(0, 100),
        body: a.transcript,
        channel: "chat",
        ack: reply,
      });
    }
    await ctx.db.insert("voiceTurns", {
      sessionId: s._id,
      key: a.key,
      transcript: a.transcript,
      reply,
      createdAt: Date.now(),
    });
    if (k && validKnowledge && s.appId) {
      const message = await ctx.db
        .query("messages")
        .withIndex("by_caseId_and_role_and_createdAt", (q) =>
          q.eq("caseId", id).eq("role", "cue"),
        )
        .order("desc")
        .first();
      if (message)
        await ctx.db.insert("knowledgeEvidence", {
          messageId: message._id,
          caseId: id,
          workspaceId: k.workspaceId,
          appId: s.appId,
          chunkIds: k.citedChunkIds,
          usedChunkIds: k.usedChunkIds,
          status: k.status,
          provider: k.provider,
          model: k.model,
          inputTokens: k.inputTokens,
          outputTokens: k.outputTokens,
          createdAt: Date.now(),
          ...(k.retrieval ? { retrieval: k.retrieval } : {}),
        });
    }
    await ctx.db.patch("voiceSessions", s._id, {
      caseId: id,
      turnCount: s.turnCount + 1,
      pendingTurn: undefined,
      pendingAt: undefined,
    });
    if (s.turnCount === 0)
      await ctx.db.insert("messages", {
        caseId: id,
        author: "Cue",
        role: "note",
        body: "Customer opted into a voice session. Spoken turns are transcribed in this conversation; raw audio is not stored.",
        createdAt: Date.now(),
      });
    await ctx.runMutation(internal.triageQueue.enqueue, { caseId: id });
    return id;
  },
});
export const turn = query({
  args: {
    secret: v.string(),
    owner: v.string(),
    sessionId: v.id("voiceSessions"),
    key: v.string(),
  },
  returns: v.union(v.null(), schema.doc("voiceTurns")),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const s = await ctx.db.get("voiceSessions", a.sessionId);
    if (!s || s.owner !== a.owner)
      throw new ConvexError("Voice session not found");
    return ctx.db
      .query("voiceTurns")
      .withIndex("by_sessionId_and_key", (q) =>
        q.eq("sessionId", s._id).eq("key", a.key),
      )
      .unique();
  },
});
export const end = mutation({
  args: {
    secret: v.string(),
    owner: v.string(),
    sessionId: v.id("voiceSessions"),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const s = await ctx.db.get("voiceSessions", a.sessionId);
    if (!s || s.owner !== a.owner)
      throw new ConvexError("Voice session not found");
    if (s.status === "ended") return null;
    await ctx.db.patch("voiceSessions", s._id, {
      status: "ended",
      endedAt: Date.now(),
      pendingTurn: undefined,
      pendingAt: undefined,
    });
    if (s.caseId)
      await ctx.db.insert("messages", {
        caseId: s.caseId,
        author: "Cue",
        role: "note",
        body: `Voice session ended. ${s.turnCount} spoken turn${s.turnCount === 1 ? "" : "s"} recorded in the customer conversation.`,
        createdAt: Date.now(),
      });
    return null;
  },
});

// Called only by the trusted verification harness. Preserve transcripts and
// failures while accurately excluding generated test reports from live intake.
export const markVerificationCase = mutation({
  args: {
    secret: v.string(),
    caseId: v.id("cases"),
    expectedTranscript: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const c = await ctx.db.get("cases", a.caseId);
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_caseId_and_createdAt", (q) => q.eq("caseId", a.caseId))
      .take(100);
    if (
      !c ||
      c.channel !== "chat" ||
      c.sourceUrl ||
      c.externalId ||
      c.body !== a.expectedTranscript ||
      !messages.some(
        (m) =>
          m.role === "note" &&
          m.body.startsWith("Customer opted into a voice session."),
      )
    )
      throw new ConvexError("Verification fixture does not match");
    if (c.provenance === "Synthetic voice verification") return null;
    await ctx.db.patch("cases", c._id, {
      provenance: "Synthetic voice verification",
    });
    await ctx.db.insert("messages", {
      caseId: c._id,
      author: "Verification harness",
      role: "note",
      body: `Generated audio fixture, not a customer report. Original provenance: ${c.provenance}. Transcript and any failure evidence retained.`,
      createdAt: Date.now(),
    });
    return null;
  },
});
