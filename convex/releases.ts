import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { authorize } from "./cue";
import { fallbackReply } from "../lib/reply-policy";

// A trusted repository release verifier supplies deployed acceptance evidence.
// Engineering approval alone never makes this transition or sends a reply.
export const confirmFeature = mutation({
  args: {
    secret: v.string(),
    runId: v.id("runs"),
    commit: v.string(),
    releaseCommit: v.string(),
    evidence: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    authorize(a.secret);
    const r = await ctx.db.get("runs", a.runId);
    if (
      !r ||
      r.kind !== "feature" ||
      r.deploymentMode !== "pull_request" ||
      !/^[a-f0-9]{40}$/.test(a.commit) ||
      r.commit !== a.commit ||
      !r.approval
    )
      throw new ConvexError("Release must match an approved feature commit");
    if (
      !/^[a-f0-9]{40}$/.test(a.releaseCommit) ||
      a.evidence.trim().length < 80 ||
      a.evidence.length > 12000
    )
      throw new ConvexError("Deployed acceptance evidence required");
    if (
      r.status === "resolved" &&
      r.releaseCommit === a.releaseCommit &&
      r.releaseEvidence === a.evidence.trim()
    )
      return null;
    if (r.status !== "approved")
      throw new ConvexError(
        "Engineering approval required before release verification",
      );
    const issue = await ctx.db.get("issues", r.issueId);
    if (!issue?.specApprovedAt || issue.spec !== r.approvedSpec)
      throw new ConvexError(
        "Product approval changed after implementation review",
      );
    const cases = await ctx.db
      .query("cases")
      .withIndex("by_issueId", (q) => q.eq("issueId", r.issueId))
      .take(201);
    if (cases.length > 200)
      throw new ConvexError(
        "Release notification requires batched verification",
      );
    const now = Date.now(),
      fields = {
        status: "resolved",
        phase: "verified",
        deployed: true,
        verified: true,
        releaseEvidence: a.evidence.trim(),
        releaseCommit: a.releaseCommit,
        updatedAt: now,
      };
    await ctx.db.patch("runs", r._id, fields);
    await ctx.db.patch("issues", issue._id, { status: "resolved" });
    for (const c of cases) {
      const body = fallbackReply({
        case: c,
        issue: { ...issue, status: "resolved" },
        run: { ...r, ...fields },
      });
      await ctx.db.patch("cases", c._id, {
        ...(c.channel === "chat" ? { status: "resolved" } : {}),
        updatedAt: now,
      });
      await ctx.db.insert("messages", {
        caseId: c._id,
        author: "Cue",
        role: c.channel === "chat" ? "cue" : "draft",
        body,
        createdAt: now,
      });
    }
    await ctx.db.insert("events", {
      runId: r._id,
      issueId: issue._id,
      title: "Feature release verified",
      detail: a.evidence.trim(),
      kind: "verification",
      createdAt: now,
    });
    return null;
  },
});
