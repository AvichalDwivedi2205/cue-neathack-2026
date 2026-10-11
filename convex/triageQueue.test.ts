/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import workpool from "@convex-dev/workpool/test";
import type { WorkId } from "@convex-dev/workpool";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const auth = { secret: "background-test-secret" };
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CUE_DEMO_SECRET", auth.secret);
  vi.stubEnv("CUE_BACKGROUND_ORIGIN", "https://cue.example.test");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ ok: true })),
  );
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function setup() {
  const t = convexTest(schema, modules);
  workpool.register(t, "triagePool");
  const caseId = await t.mutation(api.cue.createCase, {
    ...auth,
    channel: "slack",
    sourceKey: "slack:TEAM:SUPPORT:1.0",
    customer: "Holly",
    title: "Journal text",
    body: "Please add larger journal text",
  });
  const receipt = (
    await t.run((ctx) => ctx.db.query("triageReceipts").take(10))
  )[0];
  const triage = {
    ...auth,
    caseId,
    receiptId: receipt._id,
    priority: "P2" as const,
    tags: ["Readable"],
    reason: "A readable text preference",
    kind: "feature",
  };
  return { t, caseId, receipt, triage };
}
test("intake and its durable classification job commit together and duplicate requests reuse it", async () => {
  const { t, caseId, receipt } = await setup();
  expect(receipt.status).toBe("queued");
  expect(receipt.workId).toBeTruthy();
  expect(await t.mutation(api.triageQueue.request, { ...auth, caseId })).toBe(
    receipt._id,
  );
  expect(await t.mutation(api.triageQueue.request, { ...auth, caseId })).toBe(
    receipt._id,
  );
  expect(
    await t.run((ctx) => ctx.db.query("triageReceipts").take(10)),
  ).toHaveLength(1);
});
test("retry after an ambiguous response cannot duplicate classification notes or audit events", async () => {
  const { t, triage, receipt } = await setup();
  await t.mutation(api.cue.triage, triage);
  await t.mutation(api.cue.triage, triage);
  const snapshot = await t.query(api.cue.snapshot, auth);
  expect(snapshot.messages.filter((m) => m.role === "note")).toHaveLength(1);
  expect(
    snapshot.events.filter((e) => e.title === "Feedback triaged"),
  ).toHaveLength(1);
  expect(
    (
      await t.query(api.triageQueue.receipt, {
        ...auth,
        receiptId: receipt._id,
      })
    )?.status,
  ).toBe("completed");
});
test("late classification for an older message cannot overwrite a follow-up", async () => {
  const { t, triage, caseId, receipt } = await setup();
  vi.setSystemTime(Date.now() + 100);
  await t.mutation(api.intake.receive, {
    ...auth,
    channel: "slack",
    sourceKey: "slack:TEAM:SUPPORT:1.0",
    eventKey: "slack:TEAM:SUPPORT:2.0",
    customer: "Holly",
    title: "Text",
    body: "Use that size when reading and writing",
  });
  await t.mutation(api.cue.triage, { ...triage, tags: ["Stale"] });
  expect(
    (
      await t.query(api.triageQueue.receipt, {
        ...auth,
        receiptId: receipt._id,
      })
    )?.status,
  ).toBe("superseded");
  const nextId = await t.mutation(api.triageQueue.request, { ...auth, caseId });
  await t.mutation(api.cue.triage, { ...triage, receiptId: nextId! });
  expect((await t.query(api.cue.snapshot, auth)).cases[0].tags).not.toContain(
    "Stale",
  );
});
test("exhausted work is visible and a reviewed retry retains one receipt", async () => {
  const { t, receipt, caseId } = await setup();
  const failure = {
    workId: receipt.workId! as WorkId,
    context: { receiptId: receipt._id },
    result: { kind: "failed" as const, error: "Unavailable" },
  };
  await t.mutation(internal.triageQueue.completed, failure);
  await t.mutation(internal.triageQueue.completed, failure);
  expect(
    (
      await t.query(api.triageQueue.receipt, {
        ...auth,
        receiptId: receipt._id,
      })
    )?.status,
  ).toBe("failed");
  expect(
    (await t.query(api.cue.snapshot, auth)).events.filter(
      (e) => e.title === "AI triage needs review",
    ),
  ).toHaveLength(1);
  await t.mutation(api.triageQueue.request, { ...auth, caseId });
  const newReceipt = await t.query(api.triageQueue.receipt, {
    ...auth,
    receiptId: receipt._id,
  });
  expect(newReceipt?.workId).not.toBe(receipt.workId);
  await t.mutation(internal.triageQueue.completed, failure);
  expect(
    (
      await t.query(api.triageQueue.receipt, {
        ...auth,
        receiptId: receipt._id,
      })
    )?.status,
  ).toBe("queued");
});
test("classification receipt cannot authorize a different case", async () => {
  const { t, triage } = await setup();
  const other = await t.mutation(api.cue.createCase, {
    ...auth,
    channel: "chat",
    customer: "Aria",
    title: "Another",
    body: "An unrelated report",
  });
  await expect(
    t.mutation(api.cue.triage, { ...triage, caseId: other }),
  ).rejects.toThrow("Wrong triage receipt");
});
test("background lease fences overlaps and expired owners cannot release a newer lease", async () => {
  const { t } = await setup();
  expect(
    await t.mutation(api.background.acquire, {
      ...auth,
      token: "first-lease-token",
    }),
  ).toBe(true);
  expect(
    await t.mutation(api.background.acquire, {
      ...auth,
      token: "second-lease-token",
    }),
  ).toBe(false);
  vi.setSystemTime(Date.now() + 60001);
  expect(
    await t.mutation(api.background.acquire, {
      ...auth,
      token: "second-lease-token",
    }),
  ).toBe(true);
  await t.mutation(api.background.release, {
    ...auth,
    token: "first-lease-token",
  });
  expect(
    await t.mutation(api.background.acquire, {
      ...auth,
      token: "third-lease-token",
    }),
  ).toBe(false);
  await expect(
    t.mutation(api.background.acquire, {
      secret: "wrong",
      token: "third-lease-token",
    }),
  ).rejects.toThrow("Unauthorized");
});
test("workpool retries a transient hosted failure then commits exactly once", async () => {
  const { t, triage } = await setup();
  const request = vi.mocked(fetch);
  request.mockRejectedValueOnce(new Error("Transient failure"));
  request.mockImplementation(async () => {
    await t.mutation(api.cue.triage, triage);
    return Response.json({ ok: true });
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(request).toHaveBeenCalledTimes(2);
  expect(
    (await t.query(api.cue.snapshot, auth)).messages.filter(
      (m) => m.role === "note",
    ),
  ).toHaveLength(1);
});
