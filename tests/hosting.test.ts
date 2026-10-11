/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { hostedUploadStatus } from "../lib/bloom-upload";
import * as serverStore from "../lib/server-store";
import {
  readIntegrations,
  updateIntegrations,
} from "../lib/integration-config";
const modules = import.meta.glob("../convex/**/*.{ts,js}");
const auth = { secret: "hosting-test-secret" };
beforeEach(() => vi.stubEnv("CUE_DEMO_SECRET", auth.secret));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("cloud configuration persists encrypted credentials and merges updates", async () => {
  const t = convexTest(schema, modules);
  vi.stubEnv("CUE_SHARED_CONFIG", "true");
  vi.spyOn(serverStore, "db").mockReturnValue(
    t as unknown as ReturnType<typeof serverStore.db>,
  );
  await Promise.all([
    updateIntegrations((c) => ({
      ...c,
      email: { apiKey: "re_private_cloud_key", from: "support@example.com" },
    })),
    updateIntegrations((c) => ({
      ...c,
      apps: [
        ...c.apps,
        {
          id: "cloud-app",
          name: "Cloud",
          origins: ["https://example.com"],
          createdAt: 1,
        },
      ],
    })),
  ]);
  const config = await readIntegrations();
  expect(config.apps).toHaveLength(1);
  expect(config.email?.apiKey).toBe("re_private_cloud_key");
  const row = await t.query(api.serverState.read, {
    ...auth,
    key: "integrations",
  });
  expect(row?.value).not.toContain("re_private_cloud_key");
  expect(row?.value).not.toContain("support@example.com");
  expect(row?.version).toBe(2);
});

test("shared server state denies unauthenticated reads and writes", async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.query(api.serverState.read, { secret: "wrong", key: "integrations" }),
  ).rejects.toThrow("Unauthorized");
  await expect(
    t.mutation(api.serverState.write, {
      secret: "wrong",
      key: "integrations",
      value: "private",
      expectedVersion: 0,
    }),
  ).rejects.toThrow("Unauthorized");
  expect(
    await t.query(api.serverState.read, { ...auth, key: "integrations" }),
  ).toBeNull();
});
test("compare-and-swap protects concurrent configuration writes and separates worker state", async () => {
  const t = convexTest(schema, modules);
  const results = await Promise.all(
    ["a", "b"].map((value) =>
      t.mutation(api.serverState.write, {
        ...auth,
        key: "integrations",
        value,
        expectedVersion: 0,
      }),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  const row = await t.query(api.serverState.read, {
    ...auth,
    key: "integrations",
  });
  expect(row?.version).toBe(1);
  expect(
    await t.query(api.serverState.read, { ...auth, key: "worker" }),
  ).toBeNull();
  expect(
    await t.mutation(api.serverState.write, {
      ...auth,
      key: "integrations",
      value: "new",
      expectedVersion: 1,
    }),
  ).toBe(true);
  expect(
    await t.mutation(api.serverState.write, {
      ...auth,
      key: "integrations",
      value: "stale",
      expectedVersion: 1,
    }),
  ).toBe(false);
  expect(
    (await t.query(api.serverState.read, { ...auth, key: "integrations" }))
      ?.value,
  ).toBe("new");
});
test("server state bounds payloads and rejects invalid versions", async () => {
  const t = convexTest(schema, modules);
  for (const [value, expectedVersion] of [
    ["x".repeat(128001), 0],
    ["x", -1],
    ["x", 1.1],
  ] as const)
    await expect(
      t.mutation(api.serverState.write, {
        ...auth,
        key: "worker",
        value,
        expectedVersion,
      }),
    ).rejects.toThrow("Invalid server state");
});
test("private runtime state never appears in customer or operator snapshots", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.serverState.write, {
    ...auth,
    key: "integrations",
    value: "secret-ciphertext-marker",
    expectedVersion: 0,
  });
  expect(JSON.stringify(await t.query(api.cue.snapshot, auth))).not.toContain(
    "secret-ciphertext-marker",
  );
});
test("hosted upload keeps the reviewed 5 MB boundary and image signatures", () => {
  const valid = (n: number) => {
    const bytes = Buffer.alloc(n);
    bytes[0] = 255;
    bytes[1] = 216;
    return bytes;
  };
  expect(hostedUploadStatus(valid(3 * 1024 * 1024), "image/jpeg")).toBe(201);
  expect(hostedUploadStatus(valid(5 * 1024 * 1024), "image/jpeg")).toBe(201);
  expect(hostedUploadStatus(valid(5 * 1024 * 1024 + 1), "image/jpeg")).toBe(
    413,
  );
  expect(hostedUploadStatus(Buffer.from("not a photo"), "image/jpeg")).toBe(
    415,
  );
  expect(hostedUploadStatus(valid(20), "text/html")).toBe(415);
});
