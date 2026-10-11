/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
const modules = import.meta.glob(["./**/*.{ts,js}", "!./**/*.test.ts"]);
const scope = { secret: "secret", workspaceId: "workspace-a", appId: "app-a" };
const body = {
  ...scope,
  title: "Upload policy",
  kind: "text" as const,
  visibility: "customer" as const,
  text: "Maximum photo size is 5 MB",
  hash: "hash",
  passages: [{ text: "Maximum photo size is 5 MB", heading: "Limits" }],
  actor: "owner",
};
beforeEach(() => vi.stubEnv("CUE_DEMO_SECRET", "secret"));
afterEach(() => vi.unstubAllEnvs());
test("spoken answers reject withdrawn context atomically and retain visitor ownership", async () => {
  const { t, sourceId, publish } = await setup();
  const chunkId = await publish(),
    owner = "widget:app-a:voice-verification",
    key = "a0000000-0000-4000-8000-000000000011";
  const sessionId = await t.mutation(api.voice.start, {
    secret: "secret",
    owner,
    appId: "app-a",
    customer: "Verification",
  });
  await t.mutation(api.voice.claim, {
    secret: "secret",
    owner,
    sessionId,
    key,
  });
  await t.mutation(api.knowledge.withdraw, { ...scope, sourceId });
  await t.mutation(api.voice.finish, {
    secret: "secret",
    owner,
    sessionId,
    key,
    transcript: "What is the upload limit?",
    reply: "Photos up to 5 MB",
    knowledge: {
      workspaceId: scope.workspaceId,
      usedChunkIds: [chunkId],
      citedChunkIds: [chunkId],
      status: "answered",
      provider: "approved-faq",
      model: "none",
      inputTokens: 0,
      outputTokens: 0,
    },
  });
  const saved = await t.query(api.voice.turn, {
    secret: "secret",
    owner,
    sessionId,
    key,
  });
  expect(saved?.reply).toContain("information changed");
  expect(saved?.reply).not.toContain("5 MB");
  await expect(
    t.query(api.voice.turn, {
      secret: "secret",
      owner: "someone-else",
      sessionId,
      key,
    }),
  ).rejects.toThrow("not found");
});
async function setup() {
  const t = convexTest(schema, modules),
    sourceId = await t.mutation(api.knowledge.save, body);
  const d = await t.query(api.knowledge.detail, { ...scope, sourceId });
  const versionId = d.version!._id;
  const publish = async () => {
    await t.run((ctx) =>
      ctx.db.patch("knowledgeSources", sourceId, {
        pendingVersionId: versionId,
      }),
    );
    const job = await t.mutation(api.knowledge.beginIndex, {
      secret: "secret",
      sourceId,
      versionId,
    });
    await t.mutation(api.knowledge.vectors, {
      secret: "secret",
      sourceId,
      versionId,
      vectors: job!.chunks.map((c) => ({
        id: c._id,
        embedding: Array(768).fill(0.1),
      })),
    });
    await t.mutation(api.knowledge.commit, {
      secret: "secret",
      sourceId,
      versionId,
    });
    return job!.chunks[0]._id;
  };
  return { t, sourceId, versionId, publish };
}
test("drafts and internal sources never enter customer retrieval; app and workspace checks precede hydration", async () => {
  const { t, sourceId, publish } = await setup();
  expect(
    await t.query(api.knowledge.keyword, {
      ...scope,
      text: "photo",
      audience: "customer",
    }),
  ).toEqual([]);
  const id = await publish();
  expect(
    await t.query(api.knowledge.hydrate, {
      ...scope,
      ids: [id],
      audience: "customer",
    }),
  ).toHaveLength(1);
  expect(
    await t.query(api.knowledge.hydrate, {
      ...scope,
      workspaceId: "workspace-b",
      ids: [id],
      audience: "staff",
    }),
  ).toEqual([]);
  expect(
    await t.query(api.knowledge.hydrate, {
      ...scope,
      appId: "app-b",
      ids: [id],
      audience: "customer",
    }),
  ).toEqual([]);
  await t.run((ctx) =>
    ctx.db.patch("knowledgeSources", sourceId, { visibility: "internal" }),
  );
  expect(
    await t.query(api.knowledge.hydrate, {
      ...scope,
      ids: [id],
      audience: "customer",
    }),
  ).toEqual([]);
  expect(
    await t.query(api.knowledge.hydrate, {
      ...scope,
      ids: [id],
      audience: "staff",
    }),
  ).toHaveLength(1);
  await expect(
    t.query(api.knowledge.detail, {
      ...scope,
      workspaceId: "workspace-b",
      sourceId,
    }),
  ).rejects.toThrow("not found");
  await expect(
    t.query(api.knowledge.snapshot, { ...scope, secret: "wrong" }),
  ).rejects.toThrow("Unauthorized");
});
test("new drafts preserve published answers; stale edits and withdrawn pending work cannot become live", async () => {
  const { t, sourceId, versionId, publish } = await setup(),
    id = await publish();
  await t.mutation(api.knowledge.save, {
    ...body,
    sourceId,
    expectedRevision: 1,
    text: "New draft",
    hash: "new",
    passages: [{ text: "New draft", heading: "Draft" }],
  });
  expect(
    await t.query(api.knowledge.hydrate, {
      ...scope,
      ids: [id],
      audience: "customer",
    }),
  ).toHaveLength(1);
  await expect(
    t.mutation(api.knowledge.save, { ...body, sourceId, expectedRevision: 1 }),
  ).rejects.toThrow("reload");
  await expect(
    t.mutation(api.knowledge.publish, {
      ...scope,
      sourceId,
      expectedRevision: 1,
    }),
  ).rejects.toThrow("reload before publishing");
  await t.mutation(api.knowledge.withdraw, { ...scope, sourceId });
  expect(
    await t.query(api.knowledge.hydrate, {
      ...scope,
      ids: [id],
      audience: "customer",
    }),
  ).toEqual([]);
  expect(
    await t.mutation(api.knowledge.commit, {
      secret: "secret",
      sourceId,
      versionId,
    }),
  ).toBe(false);
});
test("publication refuses incomplete embeddings and malformed vector writes", async () => {
  const { t, sourceId, versionId } = await setup();
  await t.run((ctx) =>
    ctx.db.patch("knowledgeSources", sourceId, { pendingVersionId: versionId }),
  );
  await expect(
    t.mutation(api.knowledge.commit, { secret: "secret", sourceId, versionId }),
  ).rejects.toThrow("incomplete");
  const d = await t.mutation(api.knowledge.beginIndex, {
    secret: "secret",
    sourceId,
    versionId,
  });
  await expect(
    t.mutation(api.knowledge.vectors, {
      secret: "secret",
      sourceId,
      versionId,
      vectors: [{ id: d!.chunks[0]._id, embedding: [1] }],
    }),
  ).rejects.toThrow("Invalid embedding");
});
test("withdrawal between generation and delivery blocks the stale answer atomically", async () => {
  const { t, sourceId, publish } = await setup(),
    id = await publish();
  await t.mutation(api.knowledge.withdraw, { ...scope, sourceId });
  const result = await t.mutation(api.intake.widgetMessage, {
    secret: "secret",
    appId: "app-a",
    owner: "widget:app-a:visitor",
    customer: "Visitor",
    title: "Question",
    body: "What is the photo limit?",
    initialBody: "What is the photo limit?",
    sourceUrl: "https://app.example/help",
    ack: "Secret obsolete policy",
    knowledge: {
      workspaceId: scope.workspaceId,
      usedChunkIds: [id],
      citedChunkIds: [id],
      status: "answered",
      provider: "test",
      model: "test",
      inputTokens: 0,
      outputTokens: 0,
    },
  });
  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_caseId_and_createdAt", (q) =>
        q.eq("caseId", result.caseId),
      )
      .take(10),
  );
  expect(messages.some((m) => m.body.includes("Secret obsolete"))).toBe(false);
  expect(messages.some((m) => m.body.includes("information changed"))).toBe(
    true,
  );
});
