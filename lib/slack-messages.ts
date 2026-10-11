import type { Doc } from "../convex/_generated/dataModel";
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { replyFacts } from "./reply-policy";

type Case = Pick<
  Doc<"cases">,
  "_id" | "title" | "priority" | "status" | "tags"
>;
type Issue = Pick<Doc<"issues">, "title" | "kind" | "status">;
type Run = Pick<
  Doc<"runs">,
  | "_id"
  | "status"
  | "phase"
  | "commit"
  | "prUrl"
  | "deployed"
  | "verified"
  | "rootCause"
  | "after"
  | "kind"
  | "deploymentMode"
  | "releaseEvidence"
  | "releaseCommit"
>;
export type SlackMessage = { text: string; blocks: Record<string, unknown>[] };
const plain = (text: string) => ({ type: "plain_text", text, emoji: false });
const section = (text: string) => ({ type: "section", text: plain(text) });
const context = (text: string) => ({
  type: "context",
  elements: [plain(text)],
});
const header = (text: string) => ({
  type: "header",
  text: plain(text.slice(0, 150)),
});
const fields = (...items: string[]) => ({
  type: "section",
  fields: items.map((item) => {
    const [label, ...value] = item.split("\n");
    const safe = value
      .join("\n")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    return { type: "mrkdwn", text: `*${label}*\n${safe}`, verbatim: true };
  }),
});
const button = (text: string, url: string, target: "cue" | "pr") => ({
  type: "button",
  text: plain(text),
  url,
  action_id: `cue_open_${target}`,
});
function link(url?: string) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function cueLink(path: string) {
  const origin = link(process.env.CUE_PUBLIC_URL || "http://127.0.0.1:3000");
  if (!origin) return undefined;
  return new URL(`/cue#/${path}`, origin).href;
}
export function verifiedSlackFix(issue?: Issue, run?: Run) {
  return !!(
    issue?.kind === "bug" &&
    issue.status === "resolved" &&
    run?.status === "resolved" &&
    run.deployed &&
    run.verified &&
    run.commit
  );
}
function bodyBlocks(body: string) {
  // Plain text prevents customer/model output from pinging users or @channel.
  // Split without discarding text at Slack's 3,000-character section limit.
  const blocks = [];
  for (let offset = 0; offset < body.length; offset += 3000)
    blocks.push(section(body.slice(offset, offset + 3000)));
  return blocks;
}
export function supportMessage(
  body: string,
  c: Case,
  issue?: Issue,
  run?: Run,
): SlackMessage {
  const featureVerified = replyFacts({ issue, run }).featureVerified;
  const verified = verifiedSlackFix(issue, run) || featureVerified;
  const heading = verified
    ? featureVerified
      ? "Feature released"
      : "Fix verified"
    : issue?.kind === "feature"
      ? "Feature request update"
      : "Support update";
  const status = verified
    ? "Deployed and verified"
    : issue?.status === "approved"
      ? "Specification approved"
      : (issue?.status || c.status).replaceAll("_", " ");
  const cue = cueLink(`inbox/${c._id}`),
    pr = link(run?.prUrl);
  const actions = [
    cue && button("Open in Cue", cue, "cue"),
    verified && pr && button("View change", pr, "pr"),
  ].filter(Boolean);
  return {
    text: `${heading}\n${issue?.title || c.title}\n${body}\nPriority: ${c.priority}. Status: ${status}.${verified ? ` Verified commit: ${run?.commit}.` : ""}${cue ? `\nOpen in Cue: ${cue}` : ""}`,
    blocks: [
      header(heading),
      section((issue?.title || c.title).slice(0, 3000)),
      fields(`Priority\n${c.priority}`, `Status\n${status}`),
      ...bodyBlocks(body),
      ...(verified
        ? [context(`Verified deployment · commit ${run?.commit?.slice(0, 8)}`)]
        : []),
      ...(c.tags.length
        ? [context(`Tags · ${c.tags.slice(0, 6).join(" · ")}`)]
        : []),
      ...(actions.length ? [{ type: "actions", elements: actions }] : []),
      context("Cue · Replies stay in this support thread."),
    ],
  };
}
export function specVersion(spec: string) {
  return createHash("sha256").update(spec).digest("hex");
}
function reviewerBlock(ids: string[], role: string) {
  if (!ids.length)
    return context(
      `${role} reviewer is not connected. Assign a Slack member ID in Cue settings.`,
    );
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Assigned ${role} reviewer*\n${ids
        .filter((id) => /^[UW][A-Z0-9]+$/.test(id))
        .map((id) => `<@${id}>`)
        .join(" ")}`,
      verbatim: true,
    },
  };
}
export function specApprovalMessage(
  issue: Pick<Doc<"issues">, "_id" | "title" | "spec" | "status">,
  reviewerIds: string[] = [],
): SlackMessage {
  if (!issue.spec || issue.status !== "spec_ready")
    throw new Error("No pending specification");
  const spec = JSON.parse(issue.spec);
  const version = specVersion(issue.spec);
  const value = JSON.stringify({ issueId: issue._id, version });
  const cue = cueLink("features");
  return {
    text: `Product review required: ${issue.title}\n${spec.specification}\nAcceptance criteria:\n${spec.acceptanceCriteria.join("\n")}\nVersion: ${version}\nApproval covers this specification. It does not ship the feature.${cue ? `\nOpen in Cue: ${cue}` : ""}`,
    blocks: [
      header("Feature specification review"),
      section(issue.title.slice(0, 3000)),
      reviewerBlock(reviewerIds, "Product"),
      ...bodyBlocks(spec.specification),
      ...bodyBlocks(
        "Acceptance criteria\n" +
          spec.acceptanceCriteria
            .map((s: string, n: number) => `${n + 1}. ${s}`)
            .join("\n"),
      ),
      context(`Specification version · ${version}`),
      section(
        "Approve this exact specification for implementation planning. This does not deploy code or announce a shipped feature.",
      ),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: plain("Approve specification"),
            style: "primary",
            action_id: "cue_spec_approve",
            value,
            confirm: {
              title: plain("Approve specification?"),
              text: plain(
                "Record product approval for this exact specification. No code is deployed.",
              ),
              confirm: plain("Approve specification"),
              deny: plain("Cancel"),
            },
          },
          {
            type: "button",
            text: plain("Request changes"),
            action_id: "cue_spec_reject",
            value,
            confirm: {
              title: plain("Request changes?"),
              text: plain(
                "Reject this specification version. Cue will retain it for revision.",
              ),
              confirm: plain("Request changes"),
              deny: plain("Cancel"),
            },
          },
          ...(cue ? [button("Open in Cue", cue, "cue")] : []),
        ],
      },
    ],
  };
}
export function approvalMessage(
  run: Run,
  title: string,
  reviewerIds: string[] = [],
): SlackMessage {
  if (
    run.status !== "awaiting_approval" ||
    !run.commit ||
    !/^[a-f0-9]{40}$/.test(run.commit)
  )
    throw new Error("No pending exact-commit approval");
  const short = run.commit.slice(0, 8),
    cue = cueLink("agent"),
    pr = link(run.prUrl);
  const value = JSON.stringify({ runId: run._id, commit: run.commit });
  const prOnly = run.deploymentMode === "pull_request";
  const approvalDetail = prOnly
    ? "Approve this exact implementation commit for your repository's release process. This does not merge, deploy, or announce the feature."
    : "Approve to deploy this exact commit to the connected Bloom environment. Cue verifies the deployed change afterward.";
  const cleanValidation = stripVTControlCharacters(run.after || "");
  const tests = cleanValidation.match(/Tests\s+(\d+)\s+passed/),
    files = cleanValidation.match(/Test Files\s+(\d+)\s+passed/);
  const validation = tests
    ? `${cleanValidation.includes("tsc --noEmit") ? "TypeScript check passed. " : ""}${tests[1]} tests passed${files ? ` across ${files[1]} files` : ""}. Open Cue or the PR for the complete validation log.`
    : cleanValidation || "Review the recorded checks in Cue.";
  return {
    text: `Review required: ${title}\nCommit: ${run.commit}\n${run.rootCause || "Review the recorded investigation in Cue."}\nValidation: ${validation}\n${approvalDetail}\nOnly configured engineering operators may approve or reject.${pr ? `\nPull request: ${pr}` : ""}${cue ? `\nOpen in Cue: ${cue}` : ""}`,
    blocks: [
      header("Ready for review"),
      reviewerBlock(reviewerIds, "Engineering"),
      section(title.slice(0, 3000)),
      fields("Status\nApproval required", `Commit\n${short}`),
      section(
        `What changed\n${(run.rootCause || "Review the recorded investigation in Cue.").slice(0, 1200)}`,
      ),
      section(`Validation\n${validation.slice(0, 1800)}`),
      context(`Exact commit · ${run.commit}`),
      section(approvalDetail),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: plain(prOnly ? "Approve change" : "Approve & deploy"),
            style: "primary",
            action_id: "cue_approve",
            value,
            confirm: {
              title: plain(
                prOnly ? "Approve implementation?" : "Approve deployment?",
              ),
              text: plain(
                prOnly
                  ? `Approve commit ${short} for the repository release process. No code is deployed. This decision is recorded under your Slack member ID.`
                  : `Deploy commit ${short} to Bloom. This decision is recorded under your Slack member ID.`,
              ),
              confirm: plain(prOnly ? "Approve change" : "Approve & deploy"),
              deny: plain("Cancel"),
            },
          },
          {
            type: "button",
            text: plain("Reject"),
            style: "danger",
            action_id: "cue_reject",
            value,
            confirm: {
              title: plain("Reject this change?"),
              text: plain(
                `Reject commit ${short}. Cue will retain the investigation for review.`,
              ),
              confirm: plain("Reject change"),
              deny: plain("Cancel"),
            },
          },
          ...(pr ? [button("Review pull request", pr, "pr")] : []),
          ...(cue ? [button("Open in Cue", cue, "cue")] : []),
        ],
      },
      context("Cue · Only Engineering or the Owner can decide this change."),
    ],
  };
}

export function runMessage(
  run: Run,
  issue: Issue,
  reviewerIds: string[] = [],
): SlackMessage {
  if (run.status === "awaiting_approval")
    return approvalMessage(run, issue.title, reviewerIds);
  const featureVerified = replyFacts({ issue, run }).featureVerified;
  const verified = verifiedSlackFix(issue, run) || featureVerified;
  const failed = ["failed", "cancelled", "rejected"].includes(run.status);
  const heading = verified
    ? featureVerified
      ? "Feature release verified"
      : "Deployment verified"
    : failed
      ? "Investigation needs attention"
      : run.status === "approved"
        ? "Implementation approved"
        : "Investigation in progress";
  const status = verified
    ? "Deployed and verified"
    : run.phase.replaceAll("_", " ");
  const detail = verified
    ? "The approved change is deployed and has passed independent verification. Customer replies can now use this evidence."
    : failed
      ? "Work stopped. Review the investigation in Cue before retrying."
      : run.status === "approved"
        ? "Engineering approved the exact implementation commit. The PR remains subject to your repository's merge and deployment process; customer resolution has not been claimed."
        : run.phase === "implementing"
          ? run.kind === "feature"
            ? "Codex is implementing the approved specification in an isolated checkout. Independent checks and Engineering review follow."
            : "Cue reproduced the issue. Codex is preparing a scoped change in an isolated checkout."
          : run.phase === "deploying"
            ? "The exact commit was approved. Deployment is in progress; verification is still pending."
            : "Cue is investigating the reported problem. Review the timeline for current evidence.";
  const cue = cueLink("agent"),
    pr = link(run.prUrl);
  const actions = [
    cue && button("Follow investigation", cue, "cue"),
    pr && button("Review pull request", pr, "pr"),
  ].filter(Boolean);
  return {
    text: `${heading}\n${issue.title}\nStatus: ${status}\n${detail}${run.commit ? `\nCommit: ${run.commit}` : ""}${cue ? `\nFollow investigation: ${cue}` : ""}`,
    blocks: [
      header(heading),
      section(issue.title.slice(0, 3000)),
      fields(`Status\n${status}`, "Agent\nCodex"),
      section(detail),
      ...(run.commit ? [context(`Commit · ${run.commit}`)] : []),
      ...(actions.length ? [{ type: "actions", elements: actions }] : []),
      context("Cue · Engineering workflow"),
    ],
  };
}
