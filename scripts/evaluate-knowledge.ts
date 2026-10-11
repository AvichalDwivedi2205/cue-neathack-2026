import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { api, db, secret } from "../lib/server-store";
import { answerKnowledge } from "../lib/knowledge-answer";
import { chunkKnowledge, KNOWLEDGE_WORKSPACE } from "../lib/knowledge-policy";
import { shutdownObservability } from "../lib/observability";
import type { Id } from "../convex/_generated/dataModel";
type Question = {
  id: string;
  question: string;
  type: string;
  patterns?: string[];
};
type Source = {
  title: string;
  text: string;
  visibility?: "internal";
  draft?: boolean;
  appSuffix?: string;
  workspace?: string;
};
const fixture = JSON.parse(
  readFileSync(
    process.env.CUE_EVALUATION_FIXTURE ||
      "tests/fixtures/knowledge-evaluation.json",
    "utf8",
  ),
) as { sources: Source[]; development: Question[]; heldOut: Question[] };
const appId =
  process.env.CUE_EVALUATION_APP || "cue-knowledge-evaluation-20261012";
process.env.LITELLM_API_KEY ||= readFileSync(".cue/litellm.key", "utf8").trim();
const saved: {
  sourceId: Id<"knowledgeSources">;
  workspaceId: string;
  appId: string;
}[] = [];
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  fixtureHash: createHash("sha256")
    .update(JSON.stringify(fixture))
    .digest("hex"),
  synthetic: true,
  results: [],
};
const output =
  process.env.CUE_EVALUATION_OUTPUT || ".cue/knowledge-evaluation.json";
const results = report.results as Record<string, unknown>[];
const pause = () => new Promise((resolve) => setTimeout(resolve, 1500));
try {
  for (const source of fixture.sources) {
    const scope = {
      secret: secret(),
      workspaceId: source.workspace || KNOWLEDGE_WORKSPACE,
      appId: appId + (source.appSuffix || ""),
    };
    const existing = (await db().query(api.knowledge.snapshot, scope)).find(
      (s) => s.title === source.title,
    );
    const sourceId = await db().mutation(api.knowledge.save, {
      ...scope,
      ...(existing
        ? { sourceId: existing._id, expectedRevision: existing.revision }
        : {}),
      title: source.title,
      kind: "text",
      visibility: source.visibility || "customer",
      text: source.text,
      hash: createHash("sha256").update(source.text).digest("hex"),
      passages: chunkKnowledge([{ text: source.text, heading: source.title }]),
      actor: "synthetic evaluation",
    });
    saved.push({ ...scope, sourceId });
    if (!source.draft) {
      const revision = (
        await db().query(api.knowledge.detail, { ...scope, sourceId })
      ).source.revision;
      await db().mutation(api.knowledge.publish, {
        ...scope,
        sourceId,
        expectedRevision: revision,
      });
      let complete = false;
      for (let i = 0; i < 80; i++) {
        const { source: s } = await db().query(api.knowledge.detail, {
          ...scope,
          sourceId,
        });
        if (s.indexStatus === "failed")
          throw new Error("Evaluation source indexing failed: " + source.title);
        if (
          s.indexStatus === "idle" &&
          s.activeVersionId === s.latestVersionId
        ) {
          complete = true;
          break;
        }
        await pause();
      }
      if (!complete) throw new Error("Evaluation index timed out");
    }
  }
  // Development questions are intentionally separate from the frozen held-out set.
  const models = ["gemini-2.5-flash", "nova-lite", "claude-haiku"];
  for (const split of ["development", "heldOut"] as const) {
    for (const q of fixture[split]) {
      // Calls share the same context and token cap; no retries or model fallback.
      await Promise.all(
        models.map(async (model) => {
          const start = Date.now();
          const a = await answerKnowledge(
            appId,
            {
              appName: "Synthetic Bloom",
              message: q.question,
              channel: "chat",
            },
            { model, allowDirectFaq: false },
          );
          const leaked =
            /VIOLET-CANARY|OTHER-APP-CANARY|OTHER-WORKSPACE-CANARY/i.test(
              a.text,
            );
          const pass =
            !leaked &&
            (q.type === "fact"
              ? a.status === "answered" &&
                a.citedIds.length > 0 &&
                q.patterns!.every((p) => new RegExp(p, "i").test(a.text))
              : q.type === "conflict"
                ? a.status === "conflict"
                : ["needs_review", "clarification"].includes(a.status));
          const row = {
            split,
            id: q.id,
            model,
            question: q.question,
            expected: q.type,
            status: a.status,
            answer: a.text,
            citations: a.citedIds.length,
            sources: a.hits.map((h) => h.title),
            retrieval: a.retrieval,
            inputTokens: a.inputTokens,
            outputTokens: a.outputTokens,
            elapsedMs: Date.now() - start,
            leaked,
            pass,
          };
          results.push(row);
          writeFileSync(output, JSON.stringify(report, null, 2), {
            mode: 0o600,
          });
          console.log(
            JSON.stringify({
              split,
              id: q.id,
              model,
              status: a.status,
              pass,
              elapsedMs: row.elapsedMs,
            }),
          );
        }),
      );
    }
  }
  // Matched Haiku keyword baseline across the identical held-out questions.
  for (const q of fixture.heldOut) {
    const start = Date.now(),
      a = await answerKnowledge(
        appId,
        { appName: "Synthetic Bloom", message: q.question, channel: "chat" },
        { model: "claude-haiku", mode: "keyword", allowDirectFaq: false },
      );
    const leaked =
      /VIOLET-CANARY|OTHER-APP-CANARY|OTHER-WORKSPACE-CANARY/i.test(a.text);
    const pass =
      !leaked &&
      (q.type === "fact"
        ? a.status === "answered" &&
          a.citedIds.length > 0 &&
          q.patterns!.every((p) => new RegExp(p, "i").test(a.text))
        : q.type === "conflict"
          ? a.status === "conflict"
          : ["needs_review", "clarification"].includes(a.status));
    results.push({
      split: "heldOut",
      id: q.id,
      model: "claude-haiku",
      mode: "keyword",
      question: q.question,
      expected: q.type,
      status: a.status,
      answer: a.text,
      citations: a.citedIds.length,
      sources: a.hits.map((h) => h.title),
      retrieval: a.retrieval,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      elapsedMs: Date.now() - start,
      leaked,
      pass,
    });
    writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(
      JSON.stringify({ baseline: true, id: q.id, status: a.status, pass }),
    );
  }
} finally {
  for (const s of saved)
    await db().mutation(api.knowledge.withdraw, {
      secret: secret(),
      workspaceId: s.workspaceId,
      appId: s.appId,
      sourceId: s.sourceId,
    });
  report.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  await shutdownObservability();
}
