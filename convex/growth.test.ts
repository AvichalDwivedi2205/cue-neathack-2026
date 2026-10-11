/// <reference types="vite/client" />
/// <reference types="node" />
import { convexTest } from "convex-test";
import workpool from "@convex-dev/workpool/test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import schema from "./schema";
import { api, internal } from "./_generated/api";
const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const auth = { secret: "growth-test-secret" },
  actor = { id: "holly-member-id", name: "Holly", role: "product" as const },
  owner = { id: "owner-member-id", name: "Owner", role: "owner" as const },
  appId = "bloom-test",
  release = "a".repeat(40);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
beforeEach(() => vi.stubEnv("CUE_DEMO_SECRET", auth.secret));
afterEach(() => vi.unstubAllEnvs());

test("editing discovery queries resets only query cursors and preserves spend, cooldown and published evidence", async () => {
  const s = await setup();
  const d = await published(s);
  const before = await s.t.query(api.growth.snapshot, { ...auth, appId });
  const retryAt = Date.now() + 300000;
  await s.t.run((ctx) =>
    ctx.db.patch("growthCampaigns", s.campaignId, {
      used: 10,
      paused: false,
      sinceId: "123",
      nextToken: "old-query-page",
      pendingSinceId: "456",
      retryAt,
      lastRunAt: Date.now(),
    }),
  );
  await s.t.mutation(api.growth.updateQuery, {
    ...auth,
    actor,
    appId,
    campaignId: s.campaignId,
    release,
    query: '  "photo journal" -is:retweet  ',
  });
  const after = await s.t.query(api.growth.snapshot, { ...auth, appId });
  expect(after.campaigns[0]).toMatchObject({
    query: '"photo journal" -is:retweet',
    used: 10,
    paused: true,
    retryAt,
  });
  for (const key of ["sinceId", "nextToken", "pendingSinceId", "lastRunAt"])
    expect(after.campaigns[0]).not.toHaveProperty(key);
  expect(after.opportunities).toEqual(before.opportunities);
  expect(after.drafts).toEqual(before.drafts);
  expect(after.touches).toEqual(before.touches);
  expect(after.touches[0].draftId).toBe(d.draftId);
});

test("query editing requires saved role, matching app, current capability and bounded valid text", async () => {
  const s = await setup();
  const args = {
    ...auth,
    actor,
    appId,
    campaignId: s.campaignId,
    release,
    query: "new query",
  };
  await expect(
    s.t.mutation(api.growth.updateQuery, {
      ...args,
      actor: { ...actor, role: "support" },
    }),
  ).rejects.toThrow("Saved role");
  await expect(
    s.t.mutation(api.growth.updateQuery, { ...args, appId: "another-app" }),
  ).rejects.toThrow("another app");
  await expect(
    s.t.mutation(api.growth.updateQuery, { ...args, release: "b".repeat(40) }),
  ).rejects.toThrow("current deployed");
  for (const query of [" ", "x".repeat(501), "photo\njournal"])
    await expect(
      s.t.mutation(api.growth.updateQuery, { ...args, query }),
    ).rejects.toThrow("1–500");
  expect(
    (await s.t.query(api.growth.snapshot, { ...auth, appId })).campaigns[0]
      .query,
  ).toBe("caption journal -is:retweet");
});

test("query editing cannot race a reserved page or queued discovery receipt", async () => {
  const s = await setup();
  const args = {
    ...auth,
    actor,
    appId,
    campaignId: s.campaignId,
    release,
    query: "new query",
  };
  await s.t.mutation(api.growthExecution.reservePage, {
    ...auth,
    campaignId: s.campaignId,
    token: "page-lease",
  });
  await expect(s.t.mutation(api.growth.updateQuery, args)).rejects.toThrow(
    "current discovery",
  );
  await s.t.mutation(api.growthExecution.page, {
    ...auth,
    campaignId: s.campaignId,
    token: "page-lease",
  });
  await s.t.mutation(api.growth.request, {
    ...auth,
    actor,
    appId,
    campaignId: s.campaignId,
    release,
    action: "discover",
  });
  await expect(s.t.mutation(api.growth.updateQuery, args)).rejects.toThrow(
    "current discovery",
  );
});
async function setup(
  text = "Anyone recommend a photo journal app to find older memories by caption?",
) {
  const t = convexTest(schema, modules);
  workpool.register(t, "triagePool");
  const evidence = JSON.stringify({
    appId,
    release,
    origin: "https://bloom.test",
    passed: true,
    checks: ["owned search", "all terms", "negative control"],
  });
  const capabilityId = await t.mutation(api.growth.verifyCapability, {
    ...auth,
    actor: owner,
    appId,
    release,
    name: "Caption search",
    need: "Find older memories by caption",
    claims: ["Search saved captions using all words"],
    evidence,
  });
  const campaignId = await t.mutation(api.growth.createCampaign, {
    ...auth,
    actor,
    appId,
    release,
    capabilityId,
    query: "caption journal -is:retweet",
  });
  const opportunityId = await t.mutation(api.growth.capture, {
    ...auth,
    appId,
    campaignId,
    sourceKey: "x:123",
    sourceUrl: "https://x.com/test/status/123",
    channel: "x",
    author: "@test",
    text,
    sourceAt: Date.now(),
    provenance: "Official read fixture",
    controlled: true,
    automatic: false,
  });
  return { t, capabilityId, campaignId, opportunityId, evidence };
}
test("new discovered sources automatically qualify, draft and enter exact review without operator stage clicks", async () => {
  const s = await setup();
  const opportunityId = await s.t.mutation(api.growth.capture, {
    ...auth,
    appId,
    campaignId: s.campaignId,
    sourceKey: "x:automatic-source",
    sourceUrl: "https://x.com/test/status/456",
    channel: "x",
    author: "@newtester",
    text: "Anyone recommend a photo journal app to find older memories by caption?",
    sourceAt: Date.now(),
    provenance: "Agent discovery · Official X recent search",
    controlled: true,
  });
  const receipts = await s.t.run((ctx) =>
    ctx.db.query("growthReceipts").take(20),
  );
  const qualification = receipts.find(
    (r) => r.opportunityId === opportunityId && r.action === "qualify",
  );
  expect(qualification).toBeDefined();
  if (!qualification) return;
  await s.t.mutation(api.growthExecution.begin, {
    ...auth,
    receiptId: qualification._id,
    token: "auto-qualify",
  });
  await s.t.mutation(api.growth.qualify, {
    ...auth,
    receiptId: qualification._id,
    token: "auto-qualify",
    release,
    need: "Find saved memories by caption",
    eligible: true,
    matched: true,
    fit: "High",
    reasons: ["Explicit request"],
  });
  const draft = (
    await s.t.run((ctx) => ctx.db.query("growthReceipts").take(20))
  ).find((r) => r.opportunityId === opportunityId && r.action === "draft");
  expect(draft).toBeDefined();
  if (!draft) return;
  const link = "https://cue.test/g/autonomous";
  await s.t.mutation(api.growthAttribution.prepare, {
    ...auth,
    actor,
    appId,
    opportunityId,
    tokenHash: hash("autonomous"),
    link,
    destination: "https://bloom.test",
    expiresAt: Date.now() + 60000,
  });
  await s.t.mutation(api.growthExecution.begin, {
    ...auth,
    receiptId: draft._id,
    token: "auto-draft",
  });
  const text = "Find your saved captions in Bloom: " + link;
  await s.t.mutation(api.growthExecution.commitDraft, {
    ...auth,
    receiptId: draft._id,
    token: "auto-draft",
    release,
    text,
    hash: hash(text),
  });
  const saved = await s.t.query(api.growth.snapshot, { ...auth, appId });
  expect(saved.opportunities.find((o) => o._id === opportunityId)?.status).toBe(
    "awaiting-review",
  );
  expect(
    saved.drafts.find((d) => d.opportunityId === opportunityId)?.status,
  ).toBe("requested");
  expect(saved.touches.every((t) => t.status === "unpublished")).toBe(true);
  await s.t.mutation(api.growth.capture, {
    ...auth,
    appId,
    campaignId: s.campaignId,
    sourceKey: "x:automatic-source",
    sourceUrl: "https://x.com/test/status/456",
    channel: "x",
    author: "@newtester",
    text: "Anyone recommend a photo journal app to find older memories by caption?",
    sourceAt: Date.now(),
    provenance: "Agent discovery · Official X recent search",
    controlled: true,
  });
  expect(
    (await s.t.query(api.growth.snapshot, { ...auth, appId })).drafts,
  ).toEqual(saved.drafts);
  expect(
    (await s.t.run((ctx) => ctx.db.query("growthReceipts").take(20))).filter(
      (r) => r.opportunityId === opportunityId,
    ),
  ).toHaveLength(2);
});

test("historical sources are dismissed rather than drafted even when the model claims a fit", async () => {
  const s = await setup();
  await s.t.run((ctx) =>
    ctx.db.patch("growthOpportunities", s.opportunityId, {
      sourceAt: Date.now() - 8 * 86400000,
    }),
  );
  await qualified(s);
  const o = (await s.t.query(api.growth.snapshot, { ...auth, appId }))
    .opportunities[0];
  expect(o).toMatchObject({ status: "dismissed", eligible: false, fit: "Low" });
  expect(o.reasons.join(" ")).toContain("outside the current seven-day");
  expect(
    (await s.t.query(api.growth.snapshot, { ...auth, appId })).drafts,
  ).toHaveLength(0);
});

test("new policy refresh cannot replace an existing reviewed publication", async () => {
  const s = await setup();
  await published(s);
  const r = (
    await s.t.run((ctx) => ctx.db.query("growthReceipts").take(20))
  ).find((r) => r.action === "qualify")!;
  await s.t.run((ctx) =>
    ctx.db.patch("growthReceipts", r._id, { qualificationPolicyVersion: 2 }),
  );
  const before = await s.t.query(api.growth.snapshot, { ...auth, appId });
  await expect(
    s.t.mutation(api.growth.request, {
      ...auth,
      actor,
      appId,
      campaignId: s.campaignId,
      opportunityId: s.opportunityId,
      release,
      action: "qualify",
      automatic: true,
    }),
  ).rejects.toThrow("Reviewed or published evidence");
  expect(await s.t.query(api.growth.snapshot, { ...auth, appId })).toEqual(
    before,
  );
});

test("starting Growth resumes source work but cannot exceed the discovery budget or saved role", async () => {
  const s = await setup();
  await s.t.run((ctx) =>
    ctx.db.patch("growthCampaigns", s.campaignId, { used: 20 }),
  );
  const args = {
    ...auth,
    actor,
    appId,
    campaignId: s.campaignId,
    release,
    paused: false,
  };
  await expect(
    s.t.mutation(api.growthExecution.pause, {
      ...args,
      actor: { ...actor, role: "support" },
    }),
  ).rejects.toThrow("Product role");
  await expect(
    s.t.mutation(api.growthExecution.pause, {
      ...args,
      release: "b".repeat(40),
    }),
  ).rejects.toThrow("verified capability");
  await s.t.mutation(api.growthExecution.pause, args);
  const receipts = await s.t.run((ctx) =>
    ctx.db.query("growthReceipts").take(20),
  );
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ action: "qualify", automatic: true });
  const c = (await s.t.query(api.growth.snapshot, { ...auth, appId }))
    .campaigns[0];
  expect(c).toMatchObject({ paused: false, used: 20, dailyLimit: 20 });
});

test("hosted schedule waits at exhausted budget and resumes once on a new UTC day", async () => {
  vi.stubEnv("CUE_BACKGROUND_ORIGIN", "https://cue.test");
  const s = await setup();
  await s.t.run((ctx) =>
    ctx.db.patch("growthCampaigns", s.campaignId, { paused: false, used: 20 }),
  );
  await s.t.mutation(internal.growthExecution.schedule, {});
  expect(
    await s.t.run((ctx) => ctx.db.query("growthReceipts").take(20)),
  ).toHaveLength(0);
  await s.t.run((ctx) =>
    ctx.db.patch("growthCampaigns", s.campaignId, {
      budgetDay: "2020-01-01",
      lastScheduledAt: 1577836800000,
      lastRunAt: 1577836800000,
    }),
  );
  await s.t.mutation(internal.growthExecution.schedule, {});
  await s.t.mutation(internal.growthExecution.schedule, {});
  const receipts = await s.t.run((ctx) =>
    ctx.db.query("growthReceipts").take(20),
  );
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ action: "discover", automatic: true });
});
async function qualified(s: Awaited<ReturnType<typeof setup>>) {
  const taskId = await s.t.mutation(api.growth.request, {
    ...auth,
    actor,
    appId,
    release,
    campaignId: s.campaignId,
    opportunityId: s.opportunityId,
    action: "qualify",
  });
  const r = (
    await s.t.run((ctx) => ctx.db.query("growthReceipts").take(10))
  ).find((r) => r.taskId === taskId)!;
  await s.t.mutation(api.growthExecution.begin, {
    ...auth,
    receiptId: r._id,
    token: "lease",
  });
  await s.t.mutation(api.growth.qualify, {
    ...auth,
    receiptId: r._id,
    token: "lease",
    release,
    need: "Search captions",
    eligible: true,
    matched: true,
    fit: "High",
    reasons: ["Explicit request"],
  });
  return r;
}

test("rejected source gates cannot retain model-invented high fit, need or approval reasons", async () => {
  for (const text of [
    "Shutora | Flutter Photo Diary App with Laravel Cloud Backup",
    "Try our photo journal app to search your memories!",
    "Can anyone recommend an app for a photo journal with audio captions?",
  ]) {
    const s = await setup(text);
    await qualified(s); // Intentionally supplies High fit and a fictional caption-search need.
    const o = (await s.t.query(api.growth.snapshot, { ...auth, appId }))
      .opportunities[0];
    expect(o).toMatchObject({
      status: "dismissed",
      eligible: false,
      fit: "Low",
      need: text,
    });
    expect(o.reasons.join(" ")).not.toContain("Explicit request");
    expect(o.reasons[0]).toMatch(/no explicit|Promotional|does not ask/);
    expect(o.capabilityId).toBeUndefined();
  }
});

test("an explicit qualification refresh recomputes old policy evidence once without changing capability or publication", async () => {
  const s = await setup("A photo diary app for sale");
  const receipt = await qualified(s);
  await s.t.run((ctx) =>
    ctx.db.patch("growthReceipts", receipt._id, {
      qualificationPolicyVersion: undefined,
    }),
  );
  const args = {
    ...auth,
    actor,
    appId,
    release,
    campaignId: s.campaignId,
    opportunityId: s.opportunityId,
    action: "qualify" as const,
  };
  const refreshed = await s.t.mutation(api.growth.request, args);
  expect(refreshed).not.toBe(receipt.taskId);
  expect(await s.t.mutation(api.growth.request, args)).toBe(refreshed);
  const snapshot = await s.t.query(api.growth.snapshot, { ...auth, appId });
  expect(snapshot.capabilities[0].version).toBe(1);
  expect(snapshot.drafts).toHaveLength(0);
  expect(snapshot.touches).toHaveLength(0);
});
async function drafted(s: Awaited<ReturnType<typeof setup>>) {
  await qualified(s);
  const link = "https://cue.test/g/opaque";
  const touch = await s.t.mutation(api.growthAttribution.prepare, {
    ...auth,
    actor,
    appId,
    opportunityId: s.opportunityId,
    tokenHash: "b".repeat(64),
    link,
    destination: "https://bloom.test",
    expiresAt: Date.now() + 86400000,
  });
  const text = "Search your saved memory captions in Bloom: " + link;
  const draftId = await s.t.mutation(api.growth.saveDraft, {
    ...auth,
    actor,
    appId,
    opportunityId: s.opportunityId,
    release,
    text,
    hash: hash(text),
  });
  return { draftId, text, hash: hash(text), touch };
}
async function published(s: Awaited<ReturnType<typeof setup>>) {
  const d = await drafted(s);
  await s.t.mutation(api.growth.requestReview, {
    ...auth,
    actor,
    appId,
    draftId: d.draftId,
    hash: d.hash,
    release,
  });
  await s.t.mutation(api.growth.decide, {
    ...auth,
    actor,
    appId,
    draftId: d.draftId,
    hash: d.hash,
    release,
    approve: true,
  });
  const url = "https://x.com/bloom/status/999";
  await s.t.mutation(api.growthAttribution.report, {
    ...auth,
    actor: owner,
    appId,
    draftId: d.draftId,
    hash: d.hash,
    publicationUrl: url,
    release,
  });
  await s.t.mutation(api.growthAttribution.verify, {
    ...auth,
    touchId: d.touch._id,
    hash: d.hash,
    publicationUrl: url,
    ok: true,
    method: "Isolated provider fixture; not live evidence",
  });
  return d;
}
test("capability and campaign gates reject wrong role, app and release; replay retains evidence version", async () => {
  const s = await setup();
  await expect(
    s.t.mutation(api.growth.verifyCapability, {
      ...auth,
      actor: { ...actor, role: "support" },
      appId,
      release,
      name: "Caption search",
      need: "Search",
      claims: ["Search"],
      evidence: s.evidence,
    }),
  ).rejects.toThrow("Saved role");
  expect(
    await s.t.mutation(api.growth.verifyCapability, {
      ...auth,
      actor: owner,
      appId,
      release,
      name: "Caption search",
      need: "Find older memories by caption",
      claims: ["Search saved captions using all words"],
      evidence: s.evidence,
    }),
  ).toBe(s.capabilityId);
  expect(
    (await s.t.query(api.growth.snapshot, { ...auth, appId })).capabilities[0]
      .version,
  ).toBe(1);
  await expect(
    s.t.mutation(api.growth.createCampaign, {
      ...auth,
      actor,
      appId: "other",
      release,
      capabilityId: s.capabilityId,
      query: "x",
    }),
  ).rejects.toThrow("app");
  await s.t.mutation(api.growth.observeRelease, {
    ...auth,
    appId,
    release: "b".repeat(40),
  });
  await expect(
    s.t.mutation(api.growth.request, {
      ...auth,
      actor,
      appId,
      release,
      campaignId: s.campaignId,
      action: "discover",
    }),
  ).rejects.toThrow("current deployed");
});
test("concurrent discovery instructions deduplicate receipts and daily reservation cannot exceed budget", async () => {
  const s = await setup();
  const args = {
    ...auth,
    actor,
    appId,
    release,
    campaignId: s.campaignId,
    action: "discover" as const,
  };
  const ids = await Promise.all([
    s.t.mutation(api.growth.request, args),
    s.t.mutation(api.growth.request, args),
  ]);
  expect(ids[0]).toBe(ids[1]);
  const page = { ...auth, campaignId: s.campaignId };
  expect(
    await s.t.mutation(api.growthExecution.reservePage, {
      ...page,
      token: "one",
    }),
  ).not.toBeNull();
  expect(
    await s.t.mutation(api.growthExecution.reservePage, {
      ...page,
      token: "overlap",
    }),
  ).toBeNull();
  await s.t.mutation(api.growthExecution.page, {
    ...page,
    token: "stale",
    newestId: "123",
  });
  expect(
    (await s.t.query(api.growth.snapshot, { ...auth, appId })).campaigns[0]
      .sinceId,
  ).toBeUndefined();
  await s.t.mutation(api.growthExecution.page, {
    ...page,
    token: "one",
    newestId: "123",
    nextToken: "page-two",
  });
  await s.t.mutation(api.growthExecution.reservePage, {
    ...page,
    token: "two",
  });
  await s.t.mutation(api.growthExecution.page, { ...page, token: "two" });
  await expect(
    s.t.mutation(api.growthExecution.reservePage, { ...page, token: "three" }),
  ).rejects.toThrow("budget exhausted");
  expect(
    (await s.t.query(api.growth.snapshot, { ...auth, appId })).campaigns[0],
  ).toMatchObject({ used: 20, sinceId: "123" });
});
test("unsupported PDF export cannot become a recommendation even when model proposes a match", async () => {
  const s = await setup(
    "Anyone recommend a photo journal app with PDF export and caption search?",
  );
  await qualified(s);
  const o = (await s.t.query(api.growth.snapshot, { ...auth, appId }))
    .opportunities[0];
  expect(o).toMatchObject({ eligible: false, status: "needs-feature" });
  await expect(
    s.t.mutation(api.growth.request, {
      ...auth,
      actor,
      appId,
      release,
      campaignId: s.campaignId,
      opportunityId: s.opportunityId,
      action: "draft",
    }),
  ).rejects.toThrow("eligible");
});
test("exact draft review cannot be reused after edit, capability revision or by wrong role", async () => {
  const s = await setup(),
    d = await drafted(s),
    review = {
      ...auth,
      actor,
      appId,
      draftId: d.draftId,
      hash: d.hash,
      release,
    };
  await s.t.mutation(api.growth.requestReview, review);
  await expect(
    s.t.mutation(api.growth.decide, {
      ...review,
      actor: { ...actor, role: "engineering" },
      approve: true,
    }),
  ).rejects.toThrow("Saved role");
  const changed = "Find saved captions with Bloom: " + d.touch.link;
  await s.t.mutation(api.growth.saveDraft, {
    ...auth,
    actor,
    appId,
    opportunityId: s.opportunityId,
    release,
    text: changed,
    hash: hash(changed),
  });
  await expect(
    s.t.mutation(api.growth.decide, { ...review, approve: true }),
  ).rejects.toThrow("changed");
  expect(
    (await s.t.query(api.growth.snapshot, { ...auth, appId })).drafts.filter(
      (d) => d.status === "approved",
    ),
  ).toHaveLength(0);
});
test("publication requires current reviewed content and Owner; unpublished links cannot attribute visits", async () => {
  const s = await setup(),
    d = await drafted(s);
  expect(
    await s.t.query(api.growthAttribution.lookup, {
      ...auth,
      tokenHash: d.touch.tokenHash,
      now: Date.now(),
    }),
  ).toBeNull();
  await expect(
    s.t.mutation(api.growthAttribution.report, {
      ...auth,
      actor,
      appId,
      draftId: d.draftId,
      hash: d.hash,
      release,
      publicationUrl: "https://x.com/bloom/status/999",
    }),
  ).rejects.toThrow("Owner");
  await expect(
    s.t.mutation(api.growthAttribution.report, {
      ...auth,
      actor: owner,
      appId,
      draftId: d.draftId,
      hash: d.hash,
      release,
      publicationUrl: "https://x.com/bloom/status/999",
    }),
  ).rejects.toThrow("approved");
  await expect(
    s.t.mutation(api.growth.saveDraft, {
      ...auth,
      actor,
      appId,
      opportunityId: s.opportunityId,
      release,
      text: "Bloom exports PDF " + d.touch.link,
      hash: "a".repeat(64),
    }),
  ).rejects.toThrow("unsupported");
});
test("trusted event IDs deduplicate; wrong apps, replay changes and future times are rejected; click is not session", async () => {
  const s = await setup(),
    d = await published(s);
  await s.t.mutation(api.growthAttribution.click, {
    ...auth,
    touchId: d.touch._id,
  });
  expect(
    (await s.t.query(api.growth.snapshot, { ...auth, appId })).browsers,
  ).toHaveLength(0);
  const event = {
    ...auth,
    appId,
    touchId: d.touch._id,
    browser: "c".repeat(64),
    eventId: "event-1",
    type: "session_confirmed" as const,
    occurredAt: Date.now(),
    internal: true,
    returning: false,
  };
  expect(await s.t.mutation(api.growthAttribution.ingest, event)).toBe(true);
  expect(await s.t.mutation(api.growthAttribution.ingest, event)).toBe(false);
  await expect(
    s.t.mutation(api.growthAttribution.ingest, {
      ...event,
      type: "memory_created",
    }),
  ).rejects.toThrow("changed payload");
  await expect(
    s.t.mutation(api.growthAttribution.ingest, {
      ...event,
      appId: "other",
      eventId: "wrong-app",
    }),
  ).rejects.toThrow("app");
  await expect(
    s.t.mutation(api.growthAttribution.ingest, {
      ...event,
      eventId: "future",
      occurredAt: Date.now() + 120000,
    }),
  ).rejects.toThrow("Invalid");
  expect(
    (await s.t.query(api.growth.snapshot, { ...auth, appId })).events,
  ).toHaveLength(1);
});
test("canceled and stale generation cannot overwrite operator edits", async () => {
  const s = await setup(),
    d = await drafted(s);
  const taskId = await s.t.mutation(api.growth.request, {
    ...auth,
    actor,
    appId,
    release,
    campaignId: s.campaignId,
    opportunityId: s.opportunityId,
    action: "draft",
  });
  const receipt = (
    await s.t.run((ctx) => ctx.db.query("growthReceipts").take(10))
  ).find((r) => r.taskId === taskId)!;
  await s.t.mutation(api.growthExecution.begin, {
    ...auth,
    receiptId: receipt._id,
    token: "one",
  });
  await expect(
    s.t.mutation(api.growthExecution.commitDraft, {
      ...auth,
      receiptId: receipt._id,
      token: "stale",
      release,
      text: d.text,
      hash: d.hash,
    }),
  ).rejects.toThrow("Stale");
  const edit = "Try caption search in Bloom: " + d.touch.link;
  await s.t.mutation(api.growth.saveDraft, {
    ...auth,
    actor,
    appId,
    opportunityId: s.opportunityId,
    release,
    text: edit,
    hash: hash(edit),
  });
  await expect(
    s.t.mutation(api.growthExecution.commitDraft, {
      ...auth,
      receiptId: receipt._id,
      token: "one",
      release,
      text: d.text,
      hash: d.hash,
    }),
  ).rejects.toThrow("edited during");
  await s.t.mutation(api.workspace.cancel, { ...auth, actor, appId, taskId });
  await s.t.mutation(api.growthExecution.commitDraft, {
    ...auth,
    receiptId: receipt._id,
    token: "one",
    release,
    text: d.text,
    hash: d.hash,
  });
  expect(
    (await s.t.query(api.growth.snapshot, { ...auth, appId })).drafts[0].text,
  ).toBe(edit);
});

test("completed qualification and draft commands attach to evidence; an explicit revision creates fresh work", async () => {
  const s = await setup(),
    d = await drafted(s);
  const qualifyArgs = {
    ...auth,
    actor,
    appId,
    release,
    campaignId: s.campaignId,
    opportunityId: s.opportunityId,
    action: "qualify" as const,
  };
  const original = (
    await s.t.run((ctx) => ctx.db.query("growthReceipts").take(20))
  ).find((r) => r.action === "qualify")!;
  expect(await s.t.mutation(api.growth.request, qualifyArgs)).toBe(
    original.taskId,
  );
  const args = { ...qualifyArgs, action: "draft" as const };
  const taskId = await s.t.mutation(api.growth.request, args);
  const receipt = (
    await s.t.run((ctx) => ctx.db.query("growthReceipts").take(20))
  ).find((r) => r.taskId === taskId)!;
  await s.t.mutation(api.growthExecution.begin, {
    ...auth,
    receiptId: receipt._id,
    token: "new-draft-lease",
  });
  const text = "Find your saved captions in Bloom: " + d.touch.link;
  await s.t.mutation(api.growthExecution.commitDraft, {
    ...auth,
    receiptId: receipt._id,
    token: "new-draft-lease",
    release,
    text,
    hash: hash(text),
  });
  expect(await s.t.mutation(api.growth.request, args)).toBe(taskId);
  expect(
    await s.t.mutation(api.growth.request, { ...args, revision: true }),
  ).not.toBe(taskId);
});

test("human edits cannot bypass claim or exact-destination policy", async () => {
  const s = await setup(),
    d = await drafted(s);
  for (const text of [
    "Bloom supports collaborative albums: " + d.touch.link,
    "Bloom syncs memories across devices: " + d.touch.link,
    "Find captions using any query word: " + d.touch.link,
    "Find saved captions: " + d.touch.link + " " + d.touch.link,
    "Find saved captions: " + d.touch.link + " https://unrelated.test",
  ]) {
    await expect(
      s.t.mutation(api.growth.saveDraft, {
        ...auth,
        actor,
        appId,
        opportunityId: s.opportunityId,
        release,
        text,
        hash: hash(text),
      }),
    ).rejects.toThrow("unsupported claims");
  }
  const saved = await s.t.query(api.growth.snapshot, { ...auth, appId });
  expect(saved.drafts.map((x) => x._id)).toEqual([d.draftId]);
  expect(saved.drafts[0].text).toBe(d.text);
});
