/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { createNotificationPoller } from "../lib/notification-poller";
import {
  emailInput,
  emailConfigForSave,
  type EmailConfig,
} from "../lib/integration-config";

const modules = import.meta.glob("../convex/**/*.{ts,js}");
let directory: string;
const start = Date.parse("2026-10-10T00:00:00Z");
const config: EmailConfig = {
  apiKey: "re_test",
  from: "support@example.com",
  receivingAddress: "mentions@test.resend.app",
  notificationImport: true,
  pollReceiving: true,
  pollStartedAt: start,
};
const x = {
  id: "x-receipt",
  from: "X <notify@x.com>",
  subject: "Alice mentioned you",
  to: [config.receivingAddress!],
  created_at: new Date(start + 1000).toISOString(),
  text: "Upload fails https://x.com/alice/status/123456",
};
const reddit = {
  ...x,
  id: "reddit-receipt",
  from: "noreply@redditmail.com",
  text: "Upload fails https://www.reddit.com/r/bloom/comments/abc123/help/def456/",
};
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "cue-poll-test-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});
function setup() {
  const list = vi
    .fn()
    .mockResolvedValue({ data: [x, reddit], has_more: false });
  const get = vi
    .fn()
    .mockImplementation(async (id) => (id === x.id ? x : reddit));
  const receive = vi.fn().mockResolvedValue({ duplicate: false });
  const provider = vi.fn(() => ({ list, get }));
  const deps = {
    config: async () => config,
    provider,
    receive,
    checkpointFile: path.join(directory, "checkpoint.json"),
  };
  return { ...deps, list, get, poller: createNotificationPoller(deps) };
}
test("disabled polling makes no provider requests or storage writes", async () => {
  const s = setup();
  const poller = createNotificationPoller({
    ...s,
    config: async () => ({ ...config, pollReceiving: false }),
  });
  await poller.poll();
  expect(s.provider).not.toHaveBeenCalled();
  expect(poller.status().connected).toBe(false);
  await expect(fs.stat(s.checkpointFile)).rejects.toMatchObject({
    code: "ENOENT",
  });
});
test("only new notifications for the exact inbox can retrieve bodies", async () => {
  const s = setup();
  s.list.mockResolvedValue({
    data: [
      { ...x, id: "private", from: "alice@example.com" },
      { ...x, id: "security", subject: "Your verification code" },
      { ...x, id: "another-inbox", received_for: ["private@test.resend.app"] },
      { ...x, id: "old", created_at: new Date(start - 1).toISOString() },
      { ...x, id: "invalid-time", created_at: "bad date" },
      { ...x, id: "spoof-domain", from: "notify@x.com.evil.example" },
      {
        ...x,
        to: ["original@gmail.com"],
        received_for: [config.receivingAddress!],
      },
    ],
    has_more: false,
  });
  s.get.mockResolvedValue({
    ...x,
    to: ["original@gmail.com"],
    received_for: [config.receivingAddress!],
  });
  await s.poller.poll();
  expect(s.get.mock.calls).toEqual([[x.id]]);
  expect(s.receive).toHaveBeenCalledTimes(1);
  expect(s.poller.status()).toMatchObject({ connected: true, imported: 1 });
});
test("X and Reddit imports survive worker restarts with private checkpoints", async () => {
  const s = setup();
  await s.poller.poll();
  await createNotificationPoller(s).poll();
  expect(s.receive.mock.calls.map(([r]) => r.channel)).toEqual(["x", "reddit"]);
  expect(s.get).toHaveBeenCalledTimes(2);
  const file = await fs.readFile(s.checkpointFile, "utf8");
  expect(file).not.toContain(config.apiKey);
  expect(file).not.toContain("Upload fails");
  expect((await fs.stat(s.checkpointFile)).mode & 0o777).toBe(0o600);
});
test("support polling imports only its dedicated new mail and keeps social notifications separate", async () => {
  const s = setup();
  const supportConfig = {
    ...config,
    supportReceivingAddress: "support@test.resend.app",
    supportPollStartedAt: start + 2000,
  };
  const mail = {
    ...x,
    id: "support-receipt",
    from: "alice@example.com",
    subject: "My photo upload fails",
    text: "My 3 MB photo upload fails",
    message_id: "<support@example.com>",
    to: [supportConfig.supportReceivingAddress],
    created_at: new Date(start + 3000).toISOString(),
  };
  s.list.mockResolvedValue({
    data: [
      mail,
      x,
      {
        ...mail,
        id: "old-support",
        created_at: new Date(start + 1000).toISOString(),
      },
      { ...mail, id: "private", to: ["private@test.resend.app"] },
      { ...mail, id: "ambiguous", to: [mail.to[0], config.receivingAddress!] },
    ],
    has_more: false,
  });
  s.get.mockImplementation(async (id) => (id === mail.id ? mail : x));
  const deps = { ...s, config: async () => supportConfig };
  await createNotificationPoller(deps).poll();
  await createNotificationPoller(deps).poll();
  expect(s.get.mock.calls).toEqual([[mail.id], [x.id]]);
  expect(s.receive.mock.calls.map(([report]) => report.channel)).toEqual([
    "email",
    "x",
  ]);
  expect(s.receive.mock.calls[0][0]).toMatchObject({
    sourceKey: "email:support-receipt",
    customer: "alice@example.com",
    messageKey: "rfc822:<support@example.com>",
  });
});
test("support-only polling needs no notification opt-in and activation is server controlled", () => {
  const input = emailInput.parse({
    ...config,
    notificationImport: false,
    receivingAddress: undefined,
    supportReceivingAddress: "support@test.resend.app",
    supportPollStartedAt: 0,
  });
  const saved = emailConfigForSave(input, config, start + 2000);
  expect(saved.supportPollStartedAt).toBe(start + 2000);
  expect(saved.pollStartedAt).toBe(start + 2000);
  expect(
    emailConfigForSave(input, saved, start + 3000).supportPollStartedAt,
  ).toBe(start + 2000);
  expect(
    emailInput.safeParse({
      ...input,
      receivingAddress: input.supportReceivingAddress,
    }).success,
  ).toBe(false);
});
test("tracking-only notifications are held for review without creating cases", async () => {
  const s = setup();
  s.list.mockResolvedValue({ data: [x], has_more: false });
  s.get.mockResolvedValue({ ...x, text: "https://t.co/opaque" });
  await s.poller.poll();
  await s.poller.poll();
  expect(s.receive).not.toHaveBeenCalled();
  expect(s.get).toHaveBeenCalledTimes(1);
  expect(s.poller.status()).toMatchObject({ needsReview: 1, imported: 0 });
});
test("provider failures retry and never mark unavailable bodies as processed", async () => {
  const s = setup();
  s.list.mockResolvedValue({ data: [x], has_more: false });
  s.get.mockRejectedValueOnce(new Error("provider offline"));
  await s.poller.poll();
  expect(s.poller.status().connected).toBe(false);
  expect(
    JSON.parse(await fs.readFile(s.checkpointFile, "utf8")).processed,
  ).toEqual([]);
  await s.poller.poll();
  expect(s.receive).toHaveBeenCalledTimes(1);
  expect(s.poller.status().connected).toBe(true);
});
test("bounded pagination resumes backlog rather than dropping older pages", async () => {
  const s = setup();
  s.list.mockImplementation(async (after?: string) => {
    const index = after ? Number(after) + 1 : 1;
    return {
      data: [{ ...x, id: String(index), from: "private@example.com" }],
      has_more: index < 6,
    };
  });
  await s.poller.poll();
  expect(s.list).toHaveBeenCalledTimes(5);
  expect(s.poller.status().backlog).toBe(true);
  await createNotificationPoller(s).poll();
  expect(s.list.mock.calls.at(-1)).toEqual(["5"]);
  expect(s.get).not.toHaveBeenCalled();
});
test("overlapping refreshes share one poll and corrupt checkpoints fail closed", async () => {
  const s = setup();
  await Promise.all([s.poller.poll(), s.poller.poll(), s.poller.poll()]);
  expect(s.list).toHaveBeenCalledTimes(1);
  await fs.writeFile(s.checkpointFile, "corrupt");
  await s.poller.poll();
  expect(s.poller.status().connected).toBe(false);
  expect(s.list).toHaveBeenCalledTimes(1);
});
test("partial digest failures and later digests deduplicate through actual Convex intake", async () => {
  vi.stubEnv("CUE_DEMO_SECRET", "poll-test-secret");
  const t = convexTest(schema, modules),
    s = setup();
  s.list.mockResolvedValue({ data: [x], has_more: false });
  const digest = {
    ...x,
    subject: "New notifications",
    text: "Upload fails https://x.com/alice/status/123456\n\nDark mode https://x.com/bob/status/789012",
  };
  s.get.mockResolvedValue(digest);
  let failed = false;
  s.receive.mockImplementation(
    async (report: Omit<FunctionArgs<typeof api.intake.receive>, "secret">) => {
      if (report.sourceKey === "x:789012" && !failed) {
        failed = true;
        throw new Error("save failed");
      }
      return t.mutation(api.intake.receive, {
        ...report,
        secret: "poll-test-secret",
      });
    },
  );
  await s.poller.poll();
  expect(s.poller.status().connected).toBe(false);
  expect(
    JSON.parse(await fs.readFile(s.checkpointFile, "utf8")).processed,
  ).toEqual([]);
  await s.poller.poll();
  s.list.mockResolvedValue({
    data: [{ ...x, id: "second-digest" }, reddit],
    has_more: false,
  });
  s.get.mockImplementation(async (id: string) =>
    id === reddit.id ? reddit : { ...digest, id },
  );
  await createNotificationPoller(s).poll();
  const snapshot = await t.query(api.cue.snapshot, {
    secret: "poll-test-secret",
  });
  expect(snapshot.cases.map((c) => c.sourceKey).sort()).toEqual([
    "reddit:comment:def456",
    "x:123456",
    "x:789012",
  ]);
  expect(snapshot.messages.filter((m) => m.role === "customer")).toHaveLength(
    3,
  );
});
test("polling configuration cannot bypass opt-in or inject activation times", () => {
  expect(
    emailInput.safeParse({ ...config, notificationImport: false }).success,
  ).toBe(false);
  expect(
    emailInput.safeParse({ ...config, receivingAddress: undefined }).success,
  ).toBe(false);
  const input = emailInput.parse({ ...config, pollStartedAt: 0 });
  expect(emailConfigForSave(input, undefined, start).pollStartedAt).toBe(start);
  expect(emailConfigForSave(input, config, start + 1000).pollStartedAt).toBe(
    start,
  );
  expect(
    emailConfigForSave(input, { ...config, pollReceiving: false }, start + 1000)
      .pollStartedAt,
  ).toBe(start + 1000);
});
