import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  operator: vi.fn(),
  sameOrigin: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  answer: vi.fn(),
}));
vi.mock("../lib/access", () => ({
  operator: mocks.operator,
  sameOrigin: mocks.sameOrigin,
}));
vi.mock("../lib/integration-config", () => ({
  readIntegrations: async () => ({ apps: [{ id: "app-a", name: "App A" }] }),
}));
vi.mock("../lib/server-store", async () => ({
  api: (await import("../convex/_generated/api")).api,
  db: () => mocks,
  secret: () => "trusted-server-secret",
}));
vi.mock("../lib/knowledge-answer", () => ({
  SUPPORT_MODELS: [
    "gemini-2.5-flash",
    "nova-lite",
    "claude-haiku",
    "claude-sonnet-4.6",
  ],
  answerKnowledge: mocks.answer,
}));
import { GET, POST } from "../app/api/knowledge/route";
const request = (body: unknown) =>
  new Request("https://cue.test/api/knowledge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const draft = {
  action: "save",
  appId: "app-a",
  kind: "faq",
  title: "Help",
  visibility: "customer",
  question: "How?",
  answer: "This is the approved answer.",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.operator.mockResolvedValue({
    email: "owner@example.com",
    role: "owner",
  });
  mocks.query.mockResolvedValue([]);
  mocks.mutation.mockResolvedValue("source-id");
});
test("server derives workspace and actor; client-supplied identities and unregistered apps are rejected", async () => {
  expect((await POST(request(draft))).status).toBe(200);
  expect(mocks.mutation.mock.calls[0][1]).toMatchObject({
    workspaceId: "cue-configured-workspace",
    actor: "owner@example.com",
    appId: "app-a",
  });
  expect(
    (await POST(request({ ...draft, workspaceId: "other-company" }))).status,
  ).toBe(400);
  expect((await POST(request({ ...draft, actor: "other-owner" }))).status).toBe(
    400,
  );
  expect((await POST(request({ ...draft, appId: "app-b" }))).status).toBe(400);
  expect(mocks.mutation).toHaveBeenCalledTimes(1);
});
test("Support can draft but cannot publish; engineering cannot alter company policy", async () => {
  mocks.operator.mockResolvedValue({
    email: "support@example.com",
    role: "support",
  });
  expect((await POST(request(draft))).status).toBe(200);
  expect(
    (
      await POST(
        request({ action: "publish", appId: "app-a", sourceId: "source-id" }),
      )
    ).status,
  ).toBe(403);
  mocks.operator.mockResolvedValue({
    email: "engineer@example.com",
    role: "engineering",
  });
  expect((await POST(request(draft))).status).toBe(403);
});
test("authentication and request origin are checked before reads, writes or model spending", async () => {
  mocks.operator.mockRejectedValue(new Error("No session"));
  expect(
    (await GET(new Request("https://cue.test/api/knowledge"))).status,
  ).toBe(401);
  expect((await POST(request(draft))).status).toBe(400);
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.mutation).not.toHaveBeenCalled();
});
