import { api, db, secret } from "./server-store";
import { classifyReport, geminiReady } from "./gemini";
import type { Id } from "../convex/_generated/dataModel";
import { observed } from "./observability";
function provisionalIssue(issue: { fingerprint: string; appId?: string }) {
  return issue.fingerprint.startsWith(
    issue.appId ? `${issue.appId}:report:` : "report:",
  );
}
export async function triage(caseId: Id<"cases">) {
  const queued = await db().mutation(api.triageQueue.request, {
    secret: secret(),
    caseId,
  });
  if (queued) return;
  try {
    await classifySavedReport(caseId);
  } catch {
    await db().mutation(api.cue.event, {
      secret: secret(),
      title: "AI triage unavailable",
      detail:
        "Report is saved. Symptom matching and operator review remain available.",
      kind: "failure",
    });
  }
}

async function classifySavedReportImpl(
  caseId: Id<"cases">,
  receiptId?: Id<"triageReceipts">,
) {
  if (!geminiReady()) throw new Error("AI triage unavailable");
  const store = db(),
    auth = secret(),
    state = await store.query(api.cue.snapshot, { secret: auth }),
    report = state.cases.find((c) => c._id === caseId);
  if (!report) throw new Error("Saved report unavailable");
  const result = await classifyReport({
    report: {
      title: report.title,
      body: report.body,
      recentCustomerMessages: state.messages
        .filter((m) => m.caseId === caseId && m.role === "customer")
        .slice(-6)
        .map((m) => m.body),
    },
    candidates: state.issues
      .filter(
        (i) =>
          i.appId === report.appId &&
          (i._id !== report.issueId || !provisionalIssue(i)),
      )
      .map((i) => ({
        id: i._id,
        title: i.title,
        description: i.description,
        kind: i.kind,
        fingerprint: i.fingerprint,
        appId: i.appId,
      })),
  });
  const match = state.issues.find(
    (i) =>
      i._id === result.matchedIssueId &&
      i.kind === result.kind &&
      i.appId === report.appId,
  );
  // Preserve strong symptom matches; model-only merges stay conservative.
  const existing = state.issues.find((i) => i._id === report.issueId);
  await store.mutation(api.cue.triage, {
    secret: auth,
    caseId,
    receiptId,
    issueId:
      existing &&
      provisionalIssue(existing) &&
      match &&
      result.confidence >= 0.95
        ? match._id
        : undefined,
    priority: result.priority,
    tags: result.tags,
    reason: result.reason,
    kind: result.kind,
  });
}

export const classifySavedReport = observed(
  "Cue saved report triage",
  classifySavedReportImpl,
);
