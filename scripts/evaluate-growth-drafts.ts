import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { createHash, randomInt } from "node:crypto";
import { promises as fs } from "node:fs";
nextEnv.loadEnvConfig(process.cwd());
const { api, db, secret } = await import("../lib/server-store");
const { draftGrowth } = await import("../lib/growth-model");
const appId = process.env.CUE_GROWTH_APP;
assert(appId, "Select the release-verified registered app");
const raw = await fs.readFile(
  "evaluation/growth-draft-heldout-2026-10-11.json",
  "utf8",
);
const cases = JSON.parse(raw) as { id: string; text: string }[];
const saved = await db().query(api.growth.snapshot, {
  secret: secret(),
  appId,
});
const capability = saved.capabilities.find((c) => c.valid);
assert(capability);
const touch = saved.touches.find((t) =>
  saved.opportunities.some(
    (o) => o._id === t.opportunityId && o.capabilityId === capability._id,
  ),
);
assert(touch);
const deployed = await (await fetch(touch.destination + "/api/health")).json();
assert.equal(deployed.appId, appId);
assert.equal(deployed.release, capability.release);
const baseline =
  "Bloom lets you save a photo with a caption, then find it using all query words in the saved caption. " +
  touch.link;
assert(baseline.length <= 280);
const rows: {
  id: string;
  source: string;
  model: string | null;
  modelMs: number;
  A: string;
  B: string;
  modelArm: string;
}[] = [];
for (const item of cases) {
  const began = Date.now();
  let model: string | null = null;
  try {
    model = await draftGrowth(
      item.text,
      capability.claims,
      touch.link,
      "Bloom",
    );
  } catch {
    // Preserve a rejected generation; do not retry until one passes.
  }
  const modelArm = randomInt(2) ? "A" : "B";
  rows.push({
    id: item.id,
    source: item.text,
    model,
    modelMs: Date.now() - began,
    modelArm,
    A: modelArm === "A" ? model || "Draft unavailable; abstained" : baseline,
    B: modelArm === "B" ? model || "Draft unavailable; abstained" : baseline,
  });
}
const result = {
  checkedAt: new Date().toISOString(),
  fixtureSHA256: createHash("sha256").update(raw).digest("hex"),
  appId,
  capabilityId: capability._id,
  release: capability.release,
  model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  budget:
    "One model call per inquiry, one call at a time; fixed answer uses zero model calls. Identical verified facts, full destination and 280-character limit.",
  guardPassed: rows.filter((r) => r.model).length,
  total: rows.length,
  humanPreference: "Unmeasured",
  humanCorrections: "Unmeasured",
  medianHumanReviewMs: "Unmeasured",
  limitation:
    "Synthetic supported inquiries; no provider opportunity or publication created. Guard checks common explicit overclaims and destination policy, not all semantic errors. Human factual/usefulness/edit/time review remains required.",
  rows,
};
await fs.writeFile(
  ".cue/quality-draft-blind-key-2026-10-11.json",
  JSON.stringify(result, null, 2),
  { mode: 0o600 },
);
const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
const review =
  "# Blind draft review\n\nTwenty synthetic inquiries; no live outreach. For each response record factual corrections, usefulness (1–5), substantive edits and review seconds. Keep the answer key hidden until judgments are saved. An unavailable draft means the system abstained. The link is part of the exact text budget; this exercise does not publish a recommendation.\n\n| ID | Inquiry | Response A | Response B |\n| --- | --- | --- | --- |\n" +
  rows
    .map((r) => `| ${r.id} | ${cell(r.source)} | ${cell(r.A)} | ${cell(r.B)} |`)
    .join("\n") +
  "\n";
await fs.writeFile(".cue/growth-blind-review-2026-10-11.md", review, {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    guardPassed: result.guardPassed,
    total: result.total,
    humanReview: "Pending",
    review: ".cue/growth-blind-review-2026-10-11.md",
  }),
);
