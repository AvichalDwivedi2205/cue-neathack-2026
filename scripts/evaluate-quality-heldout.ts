import nextEnv from "@next/env";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
nextEnv.loadEnvConfig(process.cwd());
const { qualifyGrowth, draftGrowth } = await import("../lib/growth-model");
const { sourcePolicy } = await import("../convex/growthPolicy");
const { classifyReport } = await import("../lib/gemini");
const files = [
  process.env.CUE_GROWTH_EVALUATION_FILE ||
    "evaluation/growth-heldout-2026-10-11.json",
  "evaluation/grouping-heldout-2026-10-11.json",
];
const raw = await Promise.all(files.map((f) => fs.readFile(f, "utf8")));
const growth = JSON.parse(raw[0]) as {
  id: string;
  text: string;
  eligible: boolean;
}[];
const grouping = JSON.parse(raw[1]) as {
  id: string;
  body: string;
  match: string | null;
}[];
const claims = [
  "Save a photo memory with a caption in the browser",
  "Find saved memories using all words in a caption query",
];
const destination = "https://bloom-with-cue.vercel.app";
const baseline =
  "Bloom lets you save a photo with a caption, then search saved captions using every query word: " +
  destination;
const growthResults: Array<
  (typeof growth)[number] & {
    simple: boolean;
    result?: Awaited<ReturnType<typeof qualifyGrowth>>;
    draft?: string | null;
    baseline?: string | null;
    error?: string;
  }
> = [];
for (const item of growth) {
  const p = sourcePolicy(item.text),
    simple = p.matched && p.explicit && !p.unsupported && !p.promotional;
  try {
    const result = await qualifyGrowth(item.text, { claims });
    const draft = result.eligible
      ? await draftGrowth(item.text, claims, destination, "Bloom")
      : null;
    growthResults.push({
      ...item,
      simple,
      result,
      draft,
      baseline: item.eligible ? baseline : null,
    });
  } catch {
    growthResults.push({
      ...item,
      simple,
      error:
        "Model or bounded draft check failed; no work or publication authorized",
    });
  }
}
const candidates = [
  {
    id: "upload",
    fingerprint: "bloom:upload:413",
    title: "Photos above 2 MB fail",
    kind: "bug",
    description:
      "Valid photos above 2 MB and up to 5 MB return 413 despite promised 5 MB limit.",
  },
  {
    id: "calendar",
    title: "Monthly journal calendar",
    kind: "feature",
    description:
      "Month grid shows which dates have saved memories; tap a day to see entries.",
  },
  {
    id: "caption",
    title: "Caption search",
    kind: "feature",
    description: "Find saved journal memories by words in their captions.",
  },
  {
    id: "pdf",
    title: "Photo journal PDF",
    kind: "feature",
    description:
      "Download a printable PDF containing entries, dates and photographs.",
  },
];
const simpleMatch = (text: string) =>
  /\b413\b/i.test(text) && /[234](?:\.\d+)?\s?MB/i.test(text)
    ? "upload"
    : /\bPDF\b/i.test(text) && /photo|picture/i.test(text)
      ? "pdf"
      : /month|monthly/i.test(text) &&
          /memory|memories|entry|entries|journal/i.test(text)
        ? "calendar"
        : /search|find/i.test(text) && /caption/i.test(text)
          ? "caption"
          : null;
const groupingResults = [];
const skipGrouping = process.env.CUE_EVALUATE_GROUPING === "false";
for (const item of skipGrouping ? [] : grouping) {
  try {
    const result = await classifyReport({
      report: { body: item.body },
      candidates,
    });
    const actual = result.confidence >= 0.95 ? result.matchedIssueId : null;
    groupingResults.push({
      ...item,
      simple: simpleMatch(item.body),
      result,
      actual,
    });
  } catch {
    groupingResults.push({
      ...item,
      simple: simpleMatch(item.body),
      error: "Classification unavailable; operator review required",
      actual: null,
    });
  }
}
const gFalse = growthResults.filter(
    (r) => r.result?.eligible && !r.eligible,
  ).length,
  gExpected = growth.filter((r) => r.eligible).length,
  gTrue = growthResults.filter(
    (r) => r.result?.eligible && r.eligible && r.draft,
  ).length;
const tFalse = groupingResults.filter(
    (r) => r.actual !== null && r.actual !== r.match,
  ).length,
  tExpected = grouping.filter((r) => r.match).length,
  tTrue = groupingResults.filter(
    (r) => r.actual && r.actual === r.match,
  ).length;
const summary = {
  growth: {
    falseEligible: gFalse,
    supportedRecall: gTrue / gExpected,
    modelFailures: growthResults.filter((r) => r.error).length,
    simpleFalseEligible: growthResults.filter((r) => r.simple && !r.eligible)
      .length,
    structuralGatePassed: gFalse === 0 && gTrue / gExpected >= 0.8,
    humanPreference: "Unmeasured",
  },
  grouping: skipGrouping
    ? {
        skipped: true,
        reason: "Unchanged classifier/gate; preserve first evaluation",
      }
    : {
        falseMerges: tFalse,
        missedMerges: groupingResults.filter(
          (r) => r.match && r.actual !== r.match,
        ).length,
        recall: tTrue / tExpected,
        simpleFalseMerges: groupingResults.filter(
          (r) => r.simple !== null && r.simple !== r.match,
        ).length,
        gate: 0.95,
        structuralGatePassed: tFalse === 0 && tTrue / tExpected >= 0.8,
      },
};
const result = {
  checkedAt: new Date().toISOString(),
  fixtureSHA256: raw.map((s) => createHash("sha256").update(s).digest("hex")),
  model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  limits:
    "At most one call in flight; shared source/facts/destination and 280-character output budget. Fixed baselines use zero model calls. Synthetic labeled sample cannot establish growth or voice naturalness.",
  summary,
  growthResults,
  groupingResults,
};
await fs.mkdir(".cue", { recursive: true });
await fs.writeFile(
  process.env.CUE_VERIFY_OUTPUT || ".cue/quality-heldout-2026-10-11.json",
  JSON.stringify(result, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(summary, null, 2));
