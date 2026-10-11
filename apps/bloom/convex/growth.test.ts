/// <reference types="vite/client" />
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const auth = {
  secret: "bloom-test-secret-that-is-at-least-32-characters",
  owner: "fresh-browser",
};
beforeEach(() => vi.stubEnv("BLOOM_SERVER_SECRET", auth.secret));
afterEach(() => vi.unstubAllEnvs());
async function setup() {
  const t = convexTest(schema, modules);
  const fileId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["photo"], { type: "image/png" })),
  );
  await t.mutation(internal.uploads.record, { owner: auth.owner, fileId });
  await t.mutation(api.uploads.verify, { ...auth, fileId, w: 16, h: 16 });
  return { t, fileId };
}
const memory = {
  title: "Private title",
  caption: "Private Green Cafe memory",
  date: "2026-10-11",
  w: 16,
  h: 16,
};
const attribution = {
  ...auth,
  touchId: "cue-touch-1",
  browser: "a".repeat(64),
  internal: true,
  expiresAt: Date.now() + 86400000,
};
test("first save atomically records private-safe outbox; all search terms must return that owned memory", async () => {
  const { t, fileId } = await setup();
  await t.mutation(api.growth.attach, attribution);
  const id = await t.mutation(api.journal.save, { ...auth, ...memory, fileId });
  let rows = await t.run((ctx) => ctx.db.query("growthOutbox").take(20));
  expect(rows.map((r) => r.type)).toEqual([
    "session_confirmed",
    "memory_created",
  ]);
  expect(JSON.stringify(rows)).not.toMatch(
    /Private|Green|Cafe|fresh-browser|caption.*memory/,
  );
  expect(
    await t.mutation(api.growth.search, { ...auth, query: "GREEN missing" }),
  ).toEqual([]);
  expect(
    await t.mutation(api.growth.search, { ...auth, query: "Private title" }),
  ).toEqual([]);
  expect(
    await t.mutation(api.growth.search, { ...auth, query: "   " }),
  ).toEqual([id]);
  expect(
    (await t.run((ctx) => ctx.db.query("growthOutbox").take(20))).length,
  ).toBe(2);
  expect(
    await t.mutation(api.growth.search, { ...auth, query: " GREEN   cafe " }),
  ).toEqual([id]);
  await t.mutation(api.growth.search, { ...auth, query: "green cafe" });
  rows = await t.run((ctx) => ctx.db.query("growthOutbox").take(20));
  expect(rows.map((r) => r.type)).toEqual([
    "session_confirmed",
    "memory_created",
    "caption_search_match",
  ]);
  expect(rows.every((r) => r.internal && !r.returning)).toBe(true);
});
test("wrong visitor cannot claim memory match; repeated attribution never replaces first touch", async () => {
  const { t, fileId } = await setup();
  await t.mutation(api.growth.attach, attribution);
  await t.mutation(api.growth.attach, {
    ...attribution,
    touchId: "replacement",
  });
  await t.mutation(api.journal.save, { ...auth, ...memory, fileId });
  expect(
    await t.mutation(api.growth.search, {
      ...auth,
      owner: "other",
      query: "green cafe",
    }),
  ).toEqual([]);
  const rows = await t.run((ctx) => ctx.db.query("growthOutbox").take(20));
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.touchId === "cue-touch-1")).toBe(true);
  await expect(
    t.mutation(api.growth.search, { ...auth, secret: "wrong", query: "green" }),
  ).rejects.toThrow("Unauthorized");
});
test("returning and expired visitors do not count as new browser activation; unavailable Cue leaves journal usable", async () => {
  const { t, fileId } = await setup();
  const id = await t.mutation(api.journal.save, { ...auth, ...memory, fileId });
  await t.mutation(api.journal.remove, { ...auth, id });
  await t.mutation(api.growth.attach, attribution);
  expect(
    (await t.run((ctx) => ctx.db.query("growthOutbox").take(20)))[0].returning,
  ).toBe(true);
  await t.mutation(api.journal.save, { ...auth, ...memory, fileId });
  await t.mutation(api.growth.search, { ...auth, query: "green cafe" });
  expect(await t.query(api.journal.list, auth)).toHaveLength(1);
  await expect(
    t.mutation(api.growth.attach, {
      ...attribution,
      owner: "expired",
      expiresAt: Date.now() - 1,
    }),
  ).rejects.toThrow("rejected");
});
test("delivery lease fences concurrent workers and failed receipt retries without deleting events", async () => {
  const { t } = await setup();
  await t.mutation(api.growth.attach, attribution);
  const one = await t.mutation(internal.growth.claim, { lease: "one" });
  expect(one).toHaveLength(1);
  expect(
    await t.mutation(internal.growth.claim, { lease: "two" }),
  ).toHaveLength(0);
  await t.mutation(internal.growth.finish, {
    id: one[0]._id,
    lease: "stale",
    ok: true,
  });
  expect(
    (await t.run((ctx) => ctx.db.get("growthOutbox", one[0]._id)))?.state,
  ).toBe("pending");
  await t.mutation(internal.growth.finish, {
    id: one[0]._id,
    lease: "one",
    ok: false,
  });
  expect(
    (await t.run((ctx) => ctx.db.get("growthOutbox", one[0]._id)))?.state,
  ).toBe("pending");
  expect(
    await t.mutation(internal.growth.claim, { lease: "early" }),
  ).toHaveLength(0);
});
