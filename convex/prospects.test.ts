/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const actor = { id: "owner", name: "Owner", role: "owner" as const };
const args = {
  key: "unique-key-1",
  query: "Consumer mobile app companies",
  limit: 5,
  actor,
  reservedCredits: 11.15,
};
const c = {
  companyId: 123,
  name: "Team",
  domain: "team.example",
  description: "A consumer app",
  employees: 5,
  country: "India",
  enriched: true,
  fit: "potential" as const,
  reasons: ["Target size"],
  gaps: ["Buying intent unknown"],
};
beforeEach(() => vi.stubEnv("CUE_DEMO_SECRET", "secret"));
afterEach(() => vi.unstubAllEnvs());
test("research keys prevent duplicate paid reservations, including concurrent calls and changed payloads", async () => {
  const t = convexTest(schema, modules);
  const results = await Promise.all([
    t.mutation(internal.prospects.begin, args),
    t.mutation(internal.prospects.begin, args),
  ]);
  expect(results.map((r) => r.started).sort()).toEqual([false, true]);
  expect(results[0].runId).toBe(results[1].runId);
  await expect(
    t.mutation(internal.prospects.begin, {
      ...args,
      query: "Another company request",
    }),
  ).rejects.toThrow("another request");
  await expect(
    t.mutation(internal.prospects.begin, { ...args, key: "unique-key-2" }),
  ).rejects.toThrow("already running");
});
test("failed searches keep reservations and daily ceiling is atomic and bounded", async () => {
  const t = convexTest(schema, modules);
  for (let i = 0; i < 5; i++) {
    const { runId } = await t.mutation(internal.prospects.begin, {
      ...args,
      key: "unique-key-" + i,
    });
    await t.mutation(internal.prospects.fail, {
      runId,
      message: "Provider unavailable",
      traceId: null,
    });
  }
  await expect(
    t.mutation(internal.prospects.begin, { ...args, key: "unique-key-6" }),
  ).rejects.toThrow("Five research");
  expect(
    (await t.query(api.prospects.snapshot, { secret: "secret" })).runs,
  ).toHaveLength(5);
});
test("refreshes deduplicate exact company IDs and preserve human decisions", async () => {
  const t = convexTest(schema, modules);
  const first = await t.mutation(internal.prospects.begin, args);
  await t.mutation(internal.prospects.finish, {
    runId: first.runId,
    companies: [c],
    usedCredits: 2.23,
    warning: null,
    traceId: "trace",
  });
  const id = (await t.query(api.prospects.snapshot, { secret: "secret" }))
    .companies[0]._id;
  await t.mutation(api.prospects.review, {
    secret: "secret",
    actor,
    companyId: id,
    disposition: "shortlisted",
  });
  const second = await t.mutation(internal.prospects.begin, {
    ...args,
    key: "unique-key-2",
  });
  await t.mutation(internal.prospects.finish, {
    runId: second.runId,
    companies: [{ ...c, name: "Updated team" }],
    usedCredits: null,
    warning: null,
    traceId: null,
  });
  const saved = (await t.query(api.prospects.snapshot, { secret: "secret" }))
    .companies;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    _id: id,
    name: "Updated team",
    disposition: "shortlisted",
  });
});
test("secret, role, reservation ceiling and result count are enforced", async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.query(api.prospects.snapshot, { secret: "bad" }),
  ).rejects.toThrow("Unauthorized");
  await expect(
    t.mutation(internal.prospects.begin, {
      ...args,
      actor: { ...actor, role: "support" },
    }),
  ).rejects.toThrow("Owner or Product");
  await expect(
    t.mutation(internal.prospects.begin, { ...args, reservedCredits: 16 }),
  ).rejects.toThrow("Invalid");
  const { runId } = await t.mutation(internal.prospects.begin, {
    ...args,
    limit: 1,
  });
  await expect(
    t.mutation(internal.prospects.finish, {
      runId,
      companies: [c, { ...c, companyId: 456 }],
      usedCredits: null,
      warning: null,
      traceId: null,
    }),
  ).rejects.toThrow("reservation");
  await t.mutation(internal.prospects.finish, {
    runId,
    companies: [c],
    usedCredits: null,
    warning: null,
    traceId: null,
  });
  const companyId = (
    await t.query(api.prospects.snapshot, { secret: "secret" })
  ).companies[0]._id;
  await expect(
    t.mutation(api.prospects.review, {
      secret: "secret",
      actor: { ...actor, role: "engineering" },
      companyId,
      disposition: "dismissed",
    }),
  ).rejects.toThrow("Owner or Product");
});
