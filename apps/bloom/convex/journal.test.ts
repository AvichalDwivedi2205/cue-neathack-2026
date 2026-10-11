/// <reference types="vite/client" />
import { beforeEach, afterEach, describe, test, expect, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
const modules = import.meta.glob("./**/*.{ts,js}");
const secret = "bloom-test-secret-that-is-at-least-32-characters";
const auth = { secret, owner: "visitor-one" };
beforeEach(() => {
  vi.stubEnv("BLOOM_SERVER_SECRET", secret);
  vi.stubEnv("BLOOM_ALLOWED_ORIGINS", "https://bloom.test");
});
afterEach(() => vi.unstubAllEnvs());
async function photo(t: ReturnType<typeof convexTest>) {
  const fileId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["photo"], { type: "image/png" })),
  );
  await t.mutation(internal.uploads.record, { owner: auth.owner, fileId });
  return fileId;
}
const memory = {
  title: "First memory",
  caption: "green leaf",
  date: "2026-10-11",
  w: 4,
  h: 3,
};
describe("Bloom has its own journal and storage", () => {
  test("every public data function rejects missing or incorrect server authorization", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.query(api.journal.list, { ...auth, secret: "wrong" }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      t.mutation(api.uploads.issue, {
        ...auth,
        secret: "wrong",
        tokenHash: "a".repeat(64),
      }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      t.query(api.support.get, { ...auth, secret: "wrong", now: Date.now() }),
    ).rejects.toThrow("Unauthorized");
  });
  test("unverified and other visitors' photos cannot be saved or claimed", async () => {
    const t = convexTest(schema, modules),
      fileId = await photo(t);
    await expect(
      t.mutation(api.journal.save, { ...auth, ...memory, fileId }),
    ).rejects.toThrow("verified");
    await expect(
      t.query(api.uploads.get, { ...auth, owner: "other", fileId }),
    ).rejects.toThrow("not found");
    await expect(
      t.mutation(api.uploads.verify, {
        ...auth,
        owner: "other",
        fileId,
        w: 4,
        h: 3,
      }),
    ).rejects.toThrow("not found");
    await t.mutation(api.uploads.verify, { ...auth, fileId, w: 120, h: 80 });
    await expect(
      t.mutation(api.journal.save, {
        ...auth,
        owner: "other",
        ...memory,
        fileId,
      }),
    ).rejects.toThrow("verified");
  });
  test("save uses verified dimensions; edit, delete and undo remain owner-scoped", async () => {
    const t = convexTest(schema, modules),
      fileId = await photo(t);
    await t.mutation(api.uploads.verify, { ...auth, fileId, w: 120, h: 80 });
    const id = await t.mutation(api.journal.save, {
      ...auth,
      ...memory,
      fileId,
    });
    expect(await t.query(api.journal.list, auth)).toMatchObject([
      { id, w: 120, h: 80 },
    ]);
    expect(
      await t.query(api.journal.list, { ...auth, owner: "other" }),
    ).toEqual([]);
    await expect(
      t.mutation(api.journal.save, { ...auth, ...memory, id, owner: "other" }),
    ).rejects.toThrow("not found");
    await expect(
      t.mutation(api.journal.remove, { ...auth, id, owner: "other" }),
    ).rejects.toThrow("not found");
    await t.mutation(api.journal.save, {
      ...auth,
      ...memory,
      id,
      title: "Edited memory",
    });
    await t.mutation(api.journal.remove, { ...auth, id });
    expect(await t.query(api.journal.list, auth)).toEqual([]);
    await t.mutation(api.journal.remove, { ...auth, id, undo: true });
    expect(await t.query(api.journal.list, auth)).toMatchObject([
      { title: "Edited memory" },
    ]);
    await expect(
      t.mutation(api.uploads.discard, { ...auth, fileId }),
    ).rejects.toThrow("not found");
  });
  test("invalid calendar dates and decompression-size limits are rejected", async () => {
    const t = convexTest(schema, modules),
      fileId = await photo(t);
    await expect(
      t.mutation(api.uploads.verify, { ...auth, fileId, w: 10000, h: 10000 }),
    ).rejects.toThrow("dimensions");
    await t.mutation(api.uploads.verify, { ...auth, fileId, w: 4, h: 3 });
    await expect(
      t.mutation(api.journal.save, {
        ...auth,
        ...memory,
        fileId,
        date: "2026-02-30",
      }),
    ).rejects.toThrow("Invalid memory");
  });
  test("upload tickets are single-use, expire and cannot be invented", async () => {
    const t = convexTest(schema, modules),
      tokenHash = "a".repeat(64);
    await expect(
      t.mutation(internal.uploads.claim, { tokenHash }),
    ).rejects.toThrow("expired");
    await t.mutation(api.uploads.issue, { ...auth, tokenHash });
    expect(await t.mutation(internal.uploads.claim, { tokenHash })).toBe(
      auth.owner,
    );
    await expect(
      t.mutation(internal.uploads.claim, { tokenHash }),
    ).rejects.toThrow("already used");
    await t.run((ctx) =>
      ctx.db.insert("uploadTickets", {
        owner: auth.owner,
        tokenHash: "b".repeat(64),
        expiresAt: 1,
        claimed: false,
      }),
    );
    await expect(
      t.mutation(internal.uploads.claim, { tokenHash: "b".repeat(64) }),
    ).rejects.toThrow("expired");
  });
  test("support connection has one canonical token per visitor, separate from journal data", async () => {
    const t = convexTest(schema, modules);
    expect(
      await t.mutation(api.support.attach, { ...auth, token: "cue-token-one" }),
    ).toBe("cue-token-one");
    expect(
      await t.mutation(api.support.attach, { ...auth, token: "cue-token-two" }),
    ).toBe("cue-token-one");
    expect(await t.query(api.support.get, { ...auth, now: Date.now() })).toBe(
      "cue-token-one",
    );
    expect(
      await t.query(api.support.get, {
        ...auth,
        owner: "other",
        now: Date.now(),
      }),
    ).toBeNull();
    expect(
      await t.query(api.support.get, {
        ...auth,
        now: Date.now() + 31 * 86400000,
      }),
    ).toBeNull();
  });
  test("direct HTTP upload rejects foreign origins, oversized bytes, invalid MIME and missing tickets", async () => {
    const t = convexTest(schema, modules);
    const call = (
      headers: Record<string, string>,
      method = "POST",
      body?: string,
    ) => t.fetch("/upload", { method, headers, body });
    expect(
      (await call({ origin: "https://evil.test" }, "OPTIONS")).status,
    ).toBe(403);
    const preflight = await call({ origin: "https://bloom.test" }, "OPTIONS");
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://bloom.test",
    );
    expect(
      (
        await call({
          origin: "https://bloom.test",
          "content-length": String(5 * 1024 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call({
          origin: "https://bloom.test",
          "content-type": "image/svg+xml",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await call(
          { origin: "https://bloom.test", "content-type": "image/png" },
          "POST",
          "x",
        )
      ).status,
    ).toBe(401);
  });
});
