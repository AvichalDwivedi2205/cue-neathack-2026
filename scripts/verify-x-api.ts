import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { socialSource } from "../lib/social-source";
import { createXApi } from "../lib/x-api";

nextEnv.loadEnvConfig(process.cwd());
const { api, db, secret } = await import("../lib/server-store");
const { readIntegrations } = await import("../lib/integration-config");
const { xRuntimeStatus } = await import("../lib/integration-checks");
const { readHostedBackground } = await import("../lib/hosted-background");
const [url, marker, kind, ...tags] = process.argv.slice(2);
assert(
  url &&
    marker?.length >= 5 &&
    ["bug", "feature"].includes(kind) &&
    tags.length <= 10,
  "Usage: npx tsx scripts/verify-x-api.ts <fresh-real-X-post-url> <marker> <bug|feature> [expected-tags...]",
);
const config = (await readIntegrations()).x;
assert(config?.enabled, "Official X API intake must be configured and enabled");
const source = socialSource("x", url);
const postId = source.key.slice(2);
const snapshot = await db().query(api.cue.snapshot, { secret: secret() });
const cases = snapshot.cases.filter((c) => c.sourceKey === source.key);
assert.equal(
  cases.length,
  1,
  "Fresh native post must produce exactly one case",
);
const c = cases[0];
assert.equal(c.externalId, "x-api:" + source.key);
assert(
  c.provenance.includes("official X API"),
  "Manual or email capture cannot pass this check",
);
assert.equal(c.sourceUrl, source.url);
assert(c.createdAt >= config.startedAt && c.body.includes(marker));
const checks: string[] = [];
const pass = (name: string) => {
  checks.push(name);
  console.log("PASS · " + name);
};
pass(
  "Native X API receipt created one case after activation, preserving the exact public permalink",
);

// Read the native source again. No publishing, synthetic mail or operator intake.
await createXApi(config).credits();
const query = new URLSearchParams({
  expansions: "author_id",
  "tweet.fields": "author_id,created_at,entities",
  "user.fields": "username",
});
const response = await fetch(`https://api.x.com/2/tweets/${postId}?${query}`, {
  headers: { authorization: "Bearer " + config.bearerToken },
  redirect: "error",
  cache: "no-store",
  signal: AbortSignal.timeout(10000),
});
assert(response.ok, "Actual X post lookup must succeed");
const live = await response.json();
assert.equal(live.data?.id, postId);
assert.equal(live.data?.text, c.body);
assert(Date.parse(live.data?.created_at) >= config.startedAt);
const author = live.includes?.users?.find(
  (u: { id: string; username: string }) => u.id === live.data?.author_id,
);
assert(
  author?.username &&
    c.customer.toLowerCase() === "@" + author.username.toLowerCase(),
);
assert(
  live.data?.entities?.mentions?.some((m: { id?: string; username: string }) =>
    m.id
      ? m.id === config.userId
      : m.username.toLowerCase() === config.username.toLowerCase(),
  ),
);
pass("Actual X API confirms the post, author and exact brand mention");

const messages = snapshot.messages.filter((m) => m.caseId === c._id);
assert.equal(
  messages.filter((m) => m.role === "customer" && m.body.includes(marker))
    .length,
  1,
);
assert(
  messages.some(
    (m) => m.role === "note" && m.body.startsWith("Gemini triage suggestion:"),
  ),
);
assert.equal(snapshot.issues.find((i) => i._id === c.issueId)?.kind, kind);
for (const tag of tags)
  assert(
    c.tags.some((t) => t.toLowerCase().includes(tag.toLowerCase())),
    "Missing expected tag: " + tag,
  );
assert.equal(new Set(c.tags.map((t) => t.toLowerCase())).size, c.tags.length);
pass(
  "Customer message, Gemini classification and expected tags persist without duplication",
);

const hosted = (await readHostedBackground()).value.enabled;
const cursor = hosted
  ? (
      await db().query(api.serverState.read, {
        secret: secret(),
        key: "x-checkpoint",
      })
    )?.value
  : await fs.readFile(".cue/x-poll.json", "utf8");
assert(cursor, "Collection checkpoint must exist");
const checkpoint = JSON.parse(cursor);
assert(checkpoint.sinceId && BigInt(checkpoint.sinceId) >= BigInt(postId));
assert((await xRuntimeStatus()).connected);
pass(
  `${hosted ? "Hosted collection" : "Persistent local worker"} completed the native cursor and remains connected`,
);
await fs.writeFile(
  hosted ? ".cue/x-hosted-verification.json" : ".cue/x-api-verification.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      checks,
      caseId: c._id,
      sourceUrl: c.sourceUrl,
      receipt: c.externalId,
      tags: c.tags,
      hosting: hosted ? "cloud" : "local",
      limits: [
        "Public reply delivery requires a separate native browser check",
        hosted
          ? "Free credits and the hosted Convex scheduler remain prerequisites"
          : "Free credits and a connected local worker remain prerequisites",
      ],
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(`${checks.length} live official X intake checks passed.`);
