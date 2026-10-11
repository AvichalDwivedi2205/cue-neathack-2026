/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { createXApi, xReports, XApiError, type XPage } from "../lib/x-api";
import { createXPoller } from "../lib/x-poller";
import {
  xInput,
  xConfigForSave,
  type XConfig,
} from "../lib/integration-config";

const modules = import.meta.glob("../convex/**/*.{ts,js}");
const startedAt = Date.parse("2026-10-11T00:00:00Z");
const config: XConfig = {
  bearerToken: "test-private-bearer-token",
  username: "bloomwithcue",
  userId: "100",
  enabled: true,
  startedAt,
};
const post = {
  id: "2109012253718773827",
  text: "@bloomwithcue Please add caption search",
  author_id: "200",
  created_at: new Date(startedAt + 1000).toISOString(),
  entities: { mentions: [{ id: "100", username: "bloomwithcue" }] },
};
const page: XPage = {
  data: [post],
  includes: { users: [{ id: "200", username: "alice" }] },
};
const balances = {
  data: {
    free_balance: 20,
    prepaid_balance: 0,
    total_balance: 20,
    free_grants: [
      { amount: 20, expires_at: new Date(Date.now() + 86400000).toISOString() },
    ],
  },
};
let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "cue-x-test-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});
function setup() {
  const credits = vi.fn().mockResolvedValue({ freeBalance: 20 });
  const mentions = vi.fn().mockResolvedValue(page);
  const verifyBrand = vi.fn().mockResolvedValue(undefined);
  const receive = vi.fn().mockResolvedValue({ duplicate: false });
  const provider = vi.fn(() => ({ credits, mentions, verifyBrand }));
  const deps = {
    config: async () => config,
    provider,
    receive,
    checkpointFile: path.join(directory, "checkpoint.json"),
  };
  return { ...deps, credits, mentions, poller: createXPoller(deps) };
}
test("only exact brand mentions with provider-supplied authors enter intake", () => {
  expect(xReports(page, config)[0]).toMatchObject({
    channel: "x",
    transport: "x_api",
    customer: "@alice",
    externalId: "x-api:x:" + post.id,
    sourceKey: "x:" + post.id,
    sourceUrl: `https://x.com/alice/status/${post.id}`,
  });
  const variants = [
    {
      ...post,
      entities: { mentions: [{ id: "999", username: "bloomwithcue" }] },
    },
    { ...post, entities: { mentions: [{ username: "bloomwithcue_other" }] } },
    { ...post, created_at: new Date(startedAt - 1).toISOString() },
    { ...post, referenced_tweets: [{ type: "retweeted", id: "1" }] },
  ];
  expect(xReports({ ...page, data: variants }, config)).toEqual([]);
  expect(
    xReports(
      {
        ...page,
        data: [{ ...post, author_id: "100" }],
        includes: { users: [{ id: "100", username: "bloomwithcue" }] },
      },
      config,
    ),
  ).toEqual([]);
  expect(() => xReports({ ...page, includes: {} }, config)).toThrow(
    "incomplete response",
  );
});
test("disabled polling makes no provider requests or checkpoint", async () => {
  const s = setup();
  await createXPoller({
    ...s,
    config: async () => ({ ...config, enabled: false }),
  }).poll();
  expect(s.provider).not.toHaveBeenCalled();
  await expect(fs.stat(s.checkpointFile)).rejects.toMatchObject({
    code: "ENOENT",
  });
});
test("free credit failures never make paid mention requests", async () => {
  for (const balance of [
    {
      ...balances.data,
      free_balance: 0,
      prepaid_balance: 500,
      total_balance: 500,
    },
    { ...balances.data, free_balance: 0.99 },
    {
      ...balances.data,
      free_grants: [
        { amount: 20, expires_at: new Date(Date.now() - 1000).toISOString() },
      ],
    },
  ]) {
    const request = vi.fn().mockResolvedValue(Response.json({ data: balance }));
    await expect(createXApi(config, request).credits()).rejects.toMatchObject({
      reason: "credits",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("https://api.x.com/2/usage/credits");
  }
  const s = setup();
  s.credits.mockRejectedValue(new XApiError("credits"));
  await s.poller.poll();
  expect(s.mentions).not.toHaveBeenCalled();
  expect(s.receive).not.toHaveBeenCalled();
  expect(s.poller.status()).toMatchObject({ connected: false });
});
test("API credentials never follow redirects, errors never expose provider bodies", async () => {
  const request = vi
    .fn()
    .mockResolvedValue(new Response("leaked-private-token", { status: 403 }));
  await expect(createXApi(config, request).credits()).rejects.toMatchObject({
    reason: "auth",
  });
  expect(request.mock.calls[0][1]).toMatchObject({
    redirect: "error",
    cache: "no-store",
    headers: { authorization: "Bearer " + config.bearerToken },
  });
});
test("connection checks reject a different brand identity", async () => {
  const request = vi
    .fn()
    .mockResolvedValue(
      Response.json({ data: { id: "100", username: "someone_else" } }),
    );
  await expect(createXApi(config, request).verifyBrand()).rejects.toMatchObject(
    { reason: "auth" },
  );
});
test("partial API errors and malformed authors do not commit or advance", async () => {
  const request = vi
    .fn()
    .mockResolvedValue(
      Response.json({ ...page, errors: [{ detail: "unavailable user" }] }),
    );
  await expect(createXApi(config, request).mentions({})).rejects.toMatchObject({
    reason: "provider",
  });
  const s = setup();
  s.mentions.mockResolvedValue({ ...page, includes: {} });
  await s.poller.poll();
  expect(s.receive).not.toHaveBeenCalled();
  expect(s.poller.status().connected).toBe(false);
  await expect(fs.stat(s.checkpointFile)).rejects.toMatchObject({
    code: "ENOENT",
  });
});
test("empty timelines need an explicit successful API shape", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(Response.json({ meta: { result_count: 0 } }));
  const provider = createXApi(config, request);
  await expect(provider.mentions({})).rejects.toMatchObject({
    reason: "provider",
  });
  expect(await provider.mentions({})).toEqual({ meta: { result_count: 0 } });
});
test("configuration read failures visibly pause intake", async () => {
  const s = setup();
  const poller = createXPoller({
    ...s,
    config: async () => {
      throw new Error("private cipher data");
    },
  });
  await poller.poll();
  expect(poller.status()).toMatchObject({
    connected: false,
    detail: "X configuration could not be read. Intake paused.",
  });
  expect(s.provider).not.toHaveBeenCalled();
});
test("pagination retains its original lower bound until every page commits, including restart", async () => {
  const s = setup();
  s.mentions.mockResolvedValueOnce({
    ...page,
    meta: { next_token: "next-page" },
  });
  await s.poller.poll();
  expect(s.poller.status().backlog).toBe(true);
  const saved = JSON.parse(await fs.readFile(s.checkpointFile, "utf8"));
  expect(saved.sinceId).toBeUndefined();
  expect(saved.candidateId).toBe(post.id);
  s.mentions.mockResolvedValueOnce({
    ...page,
    data: [{ ...post, id: "2109012253718773826" }],
  });
  await createXPoller(s).poll();
  const completed = JSON.parse(await fs.readFile(s.checkpointFile, "utf8"));
  expect(completed.sinceId).toBe(post.id);
  expect(completed.nextToken).toBeUndefined();
  expect(s.mentions.mock.calls[1][0]).toMatchObject({ nextToken: "next-page" });
  expect(s.credits).toHaveBeenCalledTimes(2);
  expect(saved.fingerprint).not.toContain(config.bearerToken);
  expect((await fs.stat(s.checkpointFile)).mode & 0o777).toBe(0o600);
});
test("rate limits back off and prevent overlapping polls", async () => {
  const s = setup();
  s.mentions.mockRejectedValue(new XApiError("rate"));
  await Promise.all([s.poller.poll(), s.poller.poll()]);
  await s.poller.poll();
  expect(s.credits).toHaveBeenCalledTimes(1);
  expect(s.poller.status().retryAt).toBeGreaterThan(Date.now() + 14 * 60000);
});
test("a shared checkpoint resumes pagination across stateless server instances", async () => {
  const s = setup();
  let checkpoint: unknown = null;
  const deps = {
    ...s,
    checkpointFile: undefined,
    checkpointStorage: {
      load: async () => checkpoint,
      save: async (value: unknown) => {
        checkpoint = structuredClone(value);
      },
    },
  };
  s.mentions.mockResolvedValueOnce({
    ...page,
    meta: { next_token: "next-page" },
  });
  await createXPoller(deps).poll();
  expect(checkpoint).toMatchObject({
    candidateId: post.id,
    nextToken: "next-page",
    imported: 1,
  });
  s.mentions.mockResolvedValueOnce({ meta: { result_count: 0 } });
  await createXPoller(deps).poll();
  expect(s.mentions.mock.calls[1][0]).toMatchObject({ nextToken: "next-page" });
  expect(checkpoint).toMatchObject({ sinceId: post.id, imported: 1 });
  expect(checkpoint).not.toHaveProperty("nextToken");
  expect(s.receive).toHaveBeenCalledTimes(1);
});
test("shared storage conflict cannot advance the cursor or claim healthy collection", async () => {
  const s = setup();
  const poller = createXPoller({
    ...s,
    checkpointFile: undefined,
    checkpointStorage: {
      load: async () => null,
      save: async () => {
        throw new Error("Conflicting storage write");
      },
    },
  });
  await poller.poll();
  expect(poller.status().connected).toBe(false);
  expect(poller.status().detail).toContain("checkpoint");
  expect(s.receive).toHaveBeenCalledTimes(1);
});
test("failed report commit keeps cursor and retries idempotently after restart", async () => {
  const s = setup();
  s.receive.mockRejectedValueOnce(new Error("DB unavailable"));
  await s.poller.poll();
  expect(s.poller.status().connected).toBe(false);
  await createXPoller(s).poll();
  expect(s.receive).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await fs.readFile(s.checkpointFile, "utf8")).sinceId).toBe(
    post.id,
  );
});
test("native X plus email replay creates one real Convex case and one customer message", async () => {
  vi.stubEnv("CUE_DEMO_SECRET", "test-native-x-secret");
  const t = convexTest(schema, modules);
  const report = xReports(page, config)[0];
  const first = await t.mutation(api.intake.receive, {
    secret: "test-native-x-secret",
    ...report,
  });
  const second = await t.mutation(api.intake.receive, {
    secret: "test-native-x-secret",
    ...report,
  });
  const third = await t.mutation(api.intake.receive, {
    secret: "test-native-x-secret",
    ...report,
    transport: "notification_email",
    eventKey: "email:actual-provider-receipt",
    externalId: "actual-provider-receipt",
  });
  expect(first.duplicate).toBe(false);
  expect(second.duplicate).toBe(true);
  expect(third.caseId).toBe(first.caseId);
  const state = await t.query(api.cue.snapshot, {
    secret: "test-native-x-secret",
  });
  expect(state.cases).toHaveLength(1);
  expect(state.cases[0].provenance).toContain("official X API");
  expect(state.messages.filter((m) => m.role === "customer")).toHaveLength(1);
});
test("trusted native intake rejects invalid provenance, source identity and secret", async () => {
  vi.stubEnv("CUE_DEMO_SECRET", "test-native-x-secret");
  const t = convexTest(schema, modules),
    report = xReports(page, config)[0];
  for (const input of [
    { ...report, externalId: "email-receipt" },
    { ...report, sourceKey: "x:999" },
    { ...report, eventKey: "x-api:x:999" },
    {
      ...report,
      channel: "reddit" as const,
      sourceUrl: "https://www.reddit.com/r/test/comments/abc123/title/def456/",
    },
  ])
    await expect(
      t.mutation(api.intake.receive, {
        secret: "test-native-x-secret",
        ...input,
      }),
    ).rejects.toThrow();
  await expect(
    t.mutation(api.intake.receive, { secret: "wrong", ...report }),
  ).rejects.toThrow();
});
test("credential input rejects destinations and injection strings", () => {
  expect(xInput.parse(config).username).toBe("bloomwithcue");
  expect(
    xInput.safeParse({ ...config, userId: "100/../../users/me" }).success,
  ).toBe(false);
  expect(
    xInput.safeParse({ ...config, bearerToken: "test\r\nAuthorization: evil" })
      .success,
  ).toBe(false);
  expect(
    xInput.safeParse({ ...config, username: "bloomwithcue.evil" }).success,
  ).toBe(false);
});
test("saving inactive credentials cannot begin history collection; activation time is server controlled", () => {
  const paused = xConfigForSave(
    xInput.parse({ ...config, enabled: false, startedAt: 1 }),
    undefined,
    100,
  );
  expect(paused.startedAt).toBe(0);
  const active = xConfigForSave(xInput.parse(config), paused, 200);
  expect(active.startedAt).toBe(200);
  const pausedAgain = xConfigForSave(
    { ...active, enabled: false },
    active,
    300,
  );
  expect(xConfigForSave(active, pausedAgain, 400).startedAt).toBe(200);
  expect(
    xConfigForSave({ ...active, username: "other", userId: "300" }, active, 500)
      .startedAt,
  ).toBe(500);
});
