/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.{ts,js}");
const secret = "isolated-test-secret";
const auth = { secret };
const setup = async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.cue.seed, auth);
  const s = await t.query(api.cue.snapshot, auth);
  return {
    t,
    issue: s.issues.find((i) => i.kind === "bug")!,
    feature: s.issues.find((i) => i.kind === "feature")!,
    caseId: s.cases[0]._id,
  };
};
beforeEach(() => vi.stubEnv("CUE_DEMO_SECRET", secret));
afterEach(() => vi.unstubAllEnvs());

describe("Cue permissions and lifecycle", () => {
  test("customer screenshot projection is scoped to the case owner and excludes storage credentials", async () => {
    const { t } = await setup();
    const owner = "widget:cue_app_test:screenshot-owner";
    const { caseId } = await t.mutation(api.intake.widgetMessage, {
      ...auth,
      owner,
      appId: "cue_app_test",
      customer: "Guest",
      title: "Upload hangs",
      body: "Upload hangs",
      initialBody: "Upload hangs",
      sourceUrl: "https://app.example.com",
    });
    const fileId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["controlled image"], { type: "image/png" })),
    );
    await t.mutation(api.bloom.attachment, {
      ...auth,
      owner,
      caseId,
      fileId,
      name: "Customer screenshot",
    });
    await t.mutation(api.bloom.attachment, {
      ...auth,
      owner: "another-owner",
      caseId,
      fileId,
      name: "Different visitor's screenshot",
    });
    const conversation = await t.query(api.bloom.conversation, {
      ...auth,
      owner,
    });
    expect(conversation!.attachments).toEqual([
      { name: "Customer screenshot", url: expect.any(String) },
    ]);
    expect(
      await t.query(api.bloom.conversation, {
        ...auth,
        owner: "another-owner",
      }),
    ).toBeNull();
    await expect(
      t.query(api.bloom.conversation, { secret: "wrong", owner }),
    ).rejects.toThrow("Unauthorized");
  });
  test.each([
    { deployed: true, verified: true, resolved: true, expectResolution: true },
    {
      deployed: true,
      verified: false,
      resolved: true,
      expectResolution: false,
    },
    {
      deployed: false,
      verified: true,
      resolved: true,
      expectResolution: false,
    },
    {
      deployed: true,
      verified: true,
      resolved: false,
      expectResolution: false,
    },
  ])("new intake uses current verified resolution: %j", async (state) => {
    const { t, issue } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch("issues", issue._id, {
        status: state.resolved ? "resolved" : "open",
      });
      await ctx.db.insert("runs", {
        issueId: issue._id,
        status: "resolved",
        phase: "complete",
        provider: "codex",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        commit: "a".repeat(40),
        deployed: state.deployed,
        verified: state.verified,
      });
    });
    const caseId = await t.mutation(api.cue.createCase, {
      ...auth,
      title: "Photo upload fails",
      body: "My 3 MB journal photo upload fails",
      customer: "Slack UTEST",
      channel: "slack",
    });
    const snapshot = await t.query(api.cue.snapshot, auth);
    const reply = snapshot.messages.find(
      (m) => m.caseId === caseId && m.role === "draft",
    )!;
    expect(reply.body.includes("passed our upload tests")).toBe(
      state.expectResolution,
    );
    expect(snapshot.cases.find((c) => c._id === caseId)?.status).toBe("open");
  });
  test("concurrent first widget messages share one case and retain both reports", async () => {
    const { t } = await setup();
    const message = {
      ...auth,
      owner: "widget:cue_app_test:visitor",
      appId: "cue_app_test",
      customer: "Guest",
      title: "Help",
      body: "First report",
      initialBody: "First report with context",
      sourceUrl: "https://app.example.com/journal",
      ack: "Which screen gets stuck?",
    };
    const [a, b] = await Promise.all([
      t.mutation(api.intake.widgetMessage, message),
      t.mutation(api.intake.widgetMessage, {
        ...message,
        body: "Second report",
        initialBody: "Second report with context",
        ack: "Does the journal show an error?",
      }),
    ]);
    expect(a.caseId).toBe(b.caseId);
    const conversation = await t.query(api.bloom.conversation, {
      ...auth,
      owner: message.owner,
    });
    expect(
      conversation!.messages.filter((m) => m.role === "customer"),
    ).toHaveLength(2);
    expect(
      conversation!.messages.filter((m) => m.role === "cue").map((m) => m.body),
    ).toEqual(
      expect.arrayContaining([message.ack, "Does the journal show an error?"]),
    );
    await expect(
      t.mutation(api.intake.widgetMessage, { ...message, appId: "other_app" }),
    ).rejects.toThrow("Invalid widget");
  });
  test("connected app reports cannot join or deploy Bloom's fixture issue", async () => {
    const { t, issue } = await setup();
    const a = await t.mutation(api.cue.createCase, {
      ...auth,
      appId: "cue_app_other",
      owner: "widget:visitor",
      title: "Photo upload fails",
      body: "My 3 MB photo upload returns 413",
      customer: "Other app guest",
      channel: "chat",
    });
    const b = await t.mutation(api.cue.createCase, {
      ...auth,
      appId: "cue_app_other",
      owner: "widget:second",
      title: "Same photo error",
      body: "My 3 MB photo upload returns 413",
      customer: "Second guest",
      channel: "chat",
    });
    const s = await t.query(api.cue.snapshot, auth),
      one = s.cases.find((c) => c._id === a)!,
      two = s.cases.find((c) => c._id === b)!;
    expect(one.issueId).toBe(two.issueId);
    expect(one.issueId).not.toBe(issue._id);
    await expect(
      t.mutation(api.cue.link, { ...auth, caseId: a, issueId: issue._id }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.cue.triage, {
        ...auth,
        caseId: a,
        issueId: issue._id,
        priority: "P1",
        tags: [],
        reason: "Wrong merge",
        kind: "bug",
      }),
    ).rejects.toThrow("across connected apps");
    await expect(
      t.mutation(api.cue.startRun, { ...auth, issueId: one.issueId! }),
    ).rejects.toThrow("Bloom upload");
    expect(
      await t.query(api.bloom.conversation, {
        ...auth,
        owner: "another-visitor",
      }),
    ).toBeNull();
  });
  test("Slack duplicates and thread retries append each customer message once", async () => {
    const { t } = await setup();
    const event = {
      ...auth,
      channel: "slack" as const,
      sourceKey: "slack:TTEAM:CCHANNEL:123.456",
      eventKey: "slack:TTEAM:CCHANNEL:123.456",
      customer: "Slack UUSER",
      title: "Support request",
      body: "My 3 MB upload fails",
    };
    const [first, duplicate] = await Promise.all([
      t.mutation(api.intake.receive, event),
      t.mutation(api.intake.receive, event),
    ]);
    expect(first.caseId).toBe(duplicate.caseId);
    const reply = {
      ...event,
      eventKey: "slack:TTEAM:CCHANNEL:124.456",
      body: "Here is my browser version",
    };
    await t.mutation(api.intake.receive, reply);
    await t.mutation(api.intake.receive, reply);
    const s = await t.query(api.cue.snapshot, auth),
      messages = s.messages.filter(
        (m) => m.caseId === first.caseId && m.role === "customer",
      );
    expect(messages.map((m) => m.body)).toEqual([event.body, reply.body]);
    expect(s.cases.filter((c) => c.sourceKey === event.sourceKey)).toHaveLength(
      1,
    );
  });
  test("email References retain a thread and isolate different senders", async () => {
    const { t } = await setup();
    const root = {
      ...auth,
      channel: "email" as const,
      sourceKey: "email:receipt-1",
      eventKey: "email:receipt-1",
      messageKey: "rfc822:<first@example.com>",
      customer: "a@example.com",
      title: "Help",
      body: "Original report",
      externalId: "receipt-1",
    };
    const first = await t.mutation(api.intake.receive, root);
    const followup = {
      ...root,
      sourceKey: "email:receipt-2",
      eventKey: "email:receipt-2",
      messageKey: "rfc822:<second@example.com>",
      body: "More evidence",
      references: [root.messageKey],
      externalId: "receipt-2",
    };
    const second = await t.mutation(api.intake.receive, followup);
    expect(second.caseId).toBe(first.caseId);
    expect((await t.mutation(api.intake.receive, followup)).duplicate).toBe(
      true,
    );
    expect(
      (
        await t.mutation(api.intake.receive, {
          ...followup,
          sourceKey: "email:new-receipt",
          eventKey: "email:new-receipt",
        })
      ).duplicate,
    ).toBe(true);
    const other = await t.mutation(api.intake.receive, {
      ...followup,
      customer: "b@example.com",
      sourceKey: "email:receipt-3",
      eventKey: "email:receipt-3",
      messageKey: "rfc822:<third@example.com>",
    });
    expect(other.caseId).not.toBe(first.caseId);
    const s = await t.query(api.cue.snapshot, auth);
    expect(s.cases.find((c) => c._id === first.caseId)?.externalId).toBe(
      "receipt-2",
    );
  });
  test("notification emails deduplicate across digests and operator capture without appending duplicate messages", async () => {
    const { t } = await setup();
    const notification = {
      ...auth,
      channel: "x" as const,
      transport: "notification_email" as const,
      sourceKey: "x:123456",
      sourceUrl: "https://x.com/alice/status/123456",
      eventKey: "email-notification:one:x:123456",
      externalId: "one",
      title: "Alice mentioned you",
      customer: "@alice (unverified)",
      body: "3 MB upload fails",
    };
    const [a, b] = await Promise.all([
      t.mutation(api.intake.receive, notification),
      t.mutation(api.intake.receive, {
        ...notification,
        eventKey: "email-notification:two:x:123456",
        externalId: "two",
      }),
    ]);
    expect(a.caseId).toBe(b.caseId);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    const s = await t.query(api.cue.snapshot, auth);
    expect(s.cases.find((c) => c._id === a.caseId)?.provenance).toContain(
      "author unverified",
    );
    expect(
      s.messages.filter((m) => m.caseId === a.caseId && m.role === "customer"),
    ).toHaveLength(1);
    expect(
      s.messages.filter((m) => m.caseId === a.caseId && m.role === "cue"),
    ).toHaveLength(0);
    expect(
      await t.mutation(api.cue.createCase, {
        ...auth,
        channel: "x",
        sourceKey: notification.sourceKey,
        title: "Captured",
        customer: "Alice",
        body: "Same report",
      }),
    ).toBe(a.caseId);
    const captured = await t.mutation(api.cue.createCase, {
      ...auth,
      channel: "reddit",
      sourceKey: "reddit:comment:def456",
      title: "Captured comment",
      customer: "Alice",
      body: "Same report",
    });
    const repeated = await t.mutation(api.intake.receive, {
      ...notification,
      channel: "reddit",
      sourceKey: "reddit:comment:def456",
      sourceUrl: "https://www.reddit.com/r/bloom/comments/abc123/help/def456/",
      eventKey: "email-notification:three:reddit:comment:def456",
    });
    expect(repeated).toEqual({ caseId: captured, duplicate: true });
  });
  test("notification intake rejects missing authorization and mismatched source identities", async () => {
    const { t } = await setup();
    const input = {
      ...auth,
      channel: "x" as const,
      transport: "notification_email" as const,
      sourceKey: "x:123456",
      sourceUrl: "https://x.com/alice/status/123456",
      eventKey: "notification-test",
      title: "Mention",
      customer: "Unverified",
      body: "Help with upload",
    };
    await expect(
      t.mutation(api.intake.receive, { ...input, secret: "wrong" }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      t.mutation(api.intake.receive, { ...input, sourceKey: "x:different" }),
    ).rejects.toThrow("Invalid notification source");
    await expect(
      t.mutation(api.intake.receive, {
        ...input,
        sourceUrl: "https://evil.example/alice/status/123456",
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.intake.receive, { ...input, transport: undefined }),
    ).rejects.toThrow("Invalid notification source");
  });
  test("rejects missing server authorization for reads and writes", async () => {
    const { t, caseId } = await setup();
    await expect(
      t.query(api.cue.snapshot, { secret: "wrong" }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      t.mutation(api.cue.tags, { secret: "wrong", caseId, tags: [] }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      t.query(api.bloom.memories, { secret: "wrong", owner: "test" }),
    ).rejects.toThrow("Unauthorized");
  });

  test("concurrent reports of the same X post create one case", async () => {
    const { t } = await setup();
    const report = {
      ...auth,
      customer: "Test reporter",
      channel: "x",
      title: "3 MB photo fails",
      body: "3 MB photo upload fails",
      sourceKey: "x:isolated-fixture",
    };
    const [a, b] = await Promise.all([
      t.mutation(api.cue.createCase, report),
      t.mutation(api.cue.createCase, report),
    ]);
    expect(a).toBe(b);
  });

  test("one issue admits one active investigation", async () => {
    const { t, issue } = await setup();
    const runId = await t.mutation(api.cue.startRun, {
      ...auth,
      issueId: issue._id,
    });
    await expect(
      t.mutation(api.cue.startRun, { ...auth, issueId: issue._id }),
    ).rejects.toThrow("already exists");
    expect(
      (await t.query(api.jobs.status, auth)).filter((j) => j.runId === runId),
    ).toHaveLength(1);
  });

  test("wrong commit approval cannot change a pending run", async () => {
    const { t, issue } = await setup();
    const runId = await t.mutation(api.cue.startRun, {
      ...auth,
      issueId: issue._id,
    });
    await t.mutation(api.cue.updateRun, {
      ...auth,
      runId,
      fields: { status: "awaiting_approval", commit: "approved-commit" },
    });
    await expect(
      t.mutation(api.jobs.decide, {
        ...auth,
        runId,
        commit: "other-commit",
        actor: "Test",
        approve: true,
      }),
    ).rejects.toThrow("pending commit");
    expect((await t.query(api.cue.snapshot, auth)).runs[0].status).toBe(
      "awaiting_approval",
    );
  });

  test("rejection records a reason, reopens the issue and cannot be replayed", async () => {
    const { t, issue } = await setup();
    const runId = await t.mutation(api.cue.startRun, {
      ...auth,
      issueId: issue._id,
    });
    await t.mutation(api.cue.updateRun, {
      ...auth,
      runId,
      fields: { status: "awaiting_approval", commit: "test-commit" },
    });
    const decision = {
      ...auth,
      runId,
      commit: "test-commit",
      actor: "Test",
      approve: false,
      reason: "Needs additional verification",
    };
    await t.mutation(api.jobs.decide, decision);
    const s = await t.query(api.cue.snapshot, auth);
    expect(s.runs[0]).toMatchObject({
      status: "rejected",
      error: decision.reason,
    });
    expect(s.issues.find((i) => i._id === issue._id)?.status).toBe("open");
    await expect(t.mutation(api.jobs.decide, decision)).rejects.toThrow(
      "pending commit",
    );
  });

  test("cancellation stops queued work and reopens the issue", async () => {
    const { t, issue } = await setup();
    const runId = await t.mutation(api.cue.startRun, {
      ...auth,
      issueId: issue._id,
    });
    await t.mutation(api.jobs.cancel, { ...auth, runId });
    expect(
      await t.mutation(api.jobs.claim, { ...auth, worker: "test" }),
    ).toBeNull();
    const s = await t.query(api.cue.snapshot, auth);
    expect(s.runs[0].status).toBe("canceled");
    expect(s.issues.find((i) => i._id === issue._id)?.status).toBe("open");
  });

  test("only the leased worker keeps a job alive; expired work fails without replay", async () => {
    const { t, issue } = await setup();
    await t.mutation(api.cue.startRun, { ...auth, issueId: issue._id });
    const j = (await t.mutation(api.jobs.claim, { ...auth, worker: "owner" }))!;
    expect(j.status).toBe("running");
    expect(
      await t.mutation(api.jobs.heartbeat, {
        ...auth,
        jobId: j._id,
        worker: "other",
      }),
    ).toEqual({ cancel: true });
    expect(
      await t.mutation(api.jobs.heartbeat, {
        ...auth,
        jobId: j._id,
        worker: "owner",
      }),
    ).toEqual({ cancel: false });
    await t.run(async (ctx) => {
      await ctx.db.patch("jobs", j._id, { leaseUntil: Date.now() - 1 });
    });
    expect(
      await t.mutation(api.jobs.claim, { ...auth, worker: "replacement" }),
    ).toBeNull();
    const s = await t.query(api.cue.snapshot, auth);
    expect(s.runs[0]).toMatchObject({
      status: "failed",
      phase: "worker_interrupted",
    });
    expect(s.issues.find((i) => i._id === issue._id)?.status).toBe("open");
  });

  test("resolution requires deployment evidence and terminal runs stay immutable", async () => {
    const { t, issue } = await setup();
    const externalCases = await Promise.all(
      ["slack", "reddit", "email", "x"].map((channel) =>
        t.mutation(api.cue.createCase, {
          ...auth,
          channel,
          title: "Photo upload fails",
          body: "My 3 MB photo upload fails",
          customer: `${channel} customer`,
        }),
      ),
    );
    const runId = await t.mutation(api.cue.startRun, {
      ...auth,
      issueId: issue._id,
    });
    await expect(
      t.mutation(api.cue.updateRun, {
        ...auth,
        runId,
        fields: { status: "resolved", verified: true },
      }),
    ).rejects.toThrow("verification required");
    await t.mutation(api.cue.updateRun, {
      ...auth,
      runId,
      fields: { status: "resolved", verified: true, deployed: true },
    });
    const s = await t.query(api.cue.snapshot, auth);
    expect(
      s.cases
        .filter((c) => c.issueId === issue._id && c.channel === "chat")
        .every((c) => c.status === "resolved"),
    ).toBe(true);
    for (const caseId of externalCases) {
      expect(s.cases.find((c) => c._id === caseId)?.status).toBe("open");
      expect(
        s.messages.find(
          (m) =>
            m.caseId === caseId && m.body.includes("passed our upload tests"),
        )?.role,
      ).toBe("draft");
    }
    expect(
      s.messages.some(
        (m) => m.role === "draft" && m.body.includes("passed our upload tests"),
      ),
    ).toBe(true);
    await expect(
      t.mutation(api.cue.updateRun, {
        ...auth,
        runId,
        fields: { status: "running" },
      }),
    ).rejects.toThrow("terminal");
  });

  test("feature specifications require real criteria and persist approval", async () => {
    const { t, feature } = await setup();
    await expect(
      t.mutation(api.cue.spec, {
        ...auth,
        issueId: feature._id,
        spec: '{"need":"PDF","specification":"Export","acceptanceCriteria":[]}',
      }),
    ).rejects.toThrow("acceptance criteria");
    const spec = JSON.stringify({
      need: "Keep offline copies",
      specification: "Export journal with photos and dates",
      acceptanceCriteria: [
        "Contains every visible memory",
        "Preserves each date",
      ],
    });
    await t.mutation(api.cue.spec, {
      ...auth,
      issueId: feature._id,
      spec,
      approved: true,
      actor: "Feature reviewer",
    });
    expect(
      (await t.query(api.cue.snapshot, auth)).issues.find(
        (i) => i._id === feature._id,
      ),
    ).toMatchObject({
      spec,
      status: "approved",
      specApprovedBy: "Feature reviewer",
      specApprovedAt: expect.any(Number),
    });
    await t.mutation(api.cue.spec, { ...auth, issueId: feature._id, spec });
    const edited = (await t.query(api.cue.snapshot, auth)).issues.find(
      (i) => i._id === feature._id,
    );
    expect(edited?.status).toBe("spec_ready");
    expect(edited?.specApprovedAt).toBeUndefined();
    expect(edited?.specApprovedBy).toBeUndefined();
  });

  test("tag editing normalizes duplicates and validates limits", async () => {
    const { t, caseId } = await setup();
    await t.mutation(api.cue.tags, {
      ...auth,
      caseId,
      tags: [" Uploads ", "uploads", "Android"],
    });
    expect(
      (await t.query(api.cue.snapshot, auth)).cases.find(
        (c) => c._id === caseId,
      )?.tags,
    ).toEqual(["uploads", "Android"]);
    await expect(
      t.mutation(api.cue.tags, { ...auth, caseId, tags: [" "] }),
    ).rejects.toThrow("tags");
  });

  test("latest replies remain visible after the conversation window fills", async () => {
    const { t } = await setup();
    const caseId = await t.mutation(api.cue.createCase, {
      ...auth,
      customer: "Test",
      channel: "chat",
      owner: "isolated-owner",
      title: "Conversation",
      body: "Help",
    });
    await t.run(async (ctx) => {
      for (let n = 0; n < 305; n++)
        await ctx.db.insert("messages", {
          caseId,
          author: "Test",
          role: "customer",
          body: `message-${n}`,
          createdAt: n,
        });
    });
    await t.mutation(api.cue.message, {
      ...auth,
      caseId,
      body: "latest-resolution",
      author: "Cue",
      role: "cue",
    });
    const conversation = await t.query(api.bloom.conversation, {
      ...auth,
      owner: "isolated-owner",
    });
    expect(conversation!.messages).toHaveLength(100);
    expect(conversation!.messages.at(-1)?.body).toBe("latest-resolution");
    expect((await t.query(api.cue.snapshot, auth)).messages.at(-1)?.body).toBe(
      "latest-resolution",
    );
  });

  test("delivery reservations prevent duplicate sends even when receipt is unknown", async () => {
    const { t } = await setup();
    const send = {
      ...auth,
      key: "test-mail",
      channel: "email",
      destination: "test@example.invalid",
      body: "Test",
      actor: "Test",
    };
    const id = await t.mutation(api.deliveries.reserve, send);
    await t.mutation(api.deliveries.finish, {
      ...auth,
      id,
      status: "unknown",
      receipt: "Network ended before receipt",
    });
    await expect(t.mutation(api.deliveries.reserve, send)).rejects.toThrow(
      "already unknown",
    );
  });
});

describe("Bloom journal boundaries", () => {
  test("rejects nonexistent calendar dates and cross-owner edits", async () => {
    const { t } = await setup();
    const id = await t.run(async (ctx) =>
      ctx.db.insert("memories", {
        owner: "a",
        title: "Private",
        caption: "",
        date: "2026-10-10",
        w: 10,
        h: 10,
        deleted: false,
        createdAt: Date.now(),
      }),
    );
    const memory = {
      ...auth,
      id,
      owner: "a",
      title: "Private",
      caption: "",
      date: "2026-02-30",
      w: 10,
      h: 10,
    };
    await expect(t.mutation(api.bloom.save, memory)).rejects.toThrow(
      "Invalid memory",
    );
    await expect(
      t.mutation(api.bloom.save, { ...memory, date: "2026-10-10", owner: "b" }),
    ).rejects.toThrow("Memory not found");
    await expect(
      t.mutation(api.bloom.remove, { ...auth, id, owner: "b" }),
    ).rejects.toThrow("Memory not found");
    expect(await t.query(api.bloom.memories, { ...auth, owner: "b" })).toEqual(
      [],
    );
  });
});
