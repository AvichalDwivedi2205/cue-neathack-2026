import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
nextEnv.loadEnvConfig(process.cwd());
const { classifyReport } = await import("../lib/gemini");
const candidates = [
  {
    id: "upload",
    fingerprint: "bloom:upload:413",
    title: "Photos above 2 MB fail",
    kind: "bug",
    description:
      "Valid photos above 2 MB and up to 5 MB return 413 despite the promised 5 MB limit.",
  },
  {
    id: "pdf",
    title: "Export journals as PDF",
    kind: "feature",
    description:
      "Customers need to print entries, dates and photos for family.",
  },
  {
    id: "dark",
    title: "Dark mode",
    kind: "feature",
    description: "Comfortable journaling at night.",
  },
];
const heldOut = [
  {
    body: "I cannot upload a 2.8 MB camera photo, but the uploader allows 5 MB.",
    match: "upload",
  },
  { body: "My 2.2 MB camera image gets rotated after saving.", match: null },
  {
    body: "I want a printable keepsake of this journal with all its pictures and dates.",
    match: "pdf",
  },
  {
    body: "A 7.8 MB WebP fails to upload. The documented limit is 5 MB.",
    match: null,
  },
];
const results = [];
for (const example of heldOut) {
  const result = await classifyReport({
    report: { body: example.body },
    candidates,
  });
  results.push({
    body: example.body,
    expected: example.match,
    actual: result.matchedIssueId,
    reason: result.reason,
  });
  console.log(JSON.stringify(results.at(-1)));
  assert.equal(result.matchedIssueId, example.match);
}
await fs.mkdir(".cue", { recursive: true });
await fs.writeFile(
  ".cue/triage-evaluation.json",
  JSON.stringify(
    {
      model: process.env.GEMINI_MODEL,
      checkedAt: new Date().toISOString(),
      results,
      limitation:
        "Four held-out scenarios are a smoke evaluation, not a statistically meaningful accuracy estimate. Confidence is uncalibrated. Review uncertain reports; do not authorize code or deployment from classification alone.",
    },
    null,
    2,
  ),
);
