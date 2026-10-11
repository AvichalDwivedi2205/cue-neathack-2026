import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  action: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  operator: vi.fn(),
  sameOrigin: vi.fn(),
}));
vi.mock("../lib/server-store", async () => ({
  api: (await import("../convex/_generated/api")).api,
  db: () => mocks,
  secret: () => "server-only-secret",
}));
vi.mock("../lib/access", () => ({
  operator: mocks.operator,
  sameOrigin: mocks.sameOrigin,
}));
import { GET, POST } from "../app/api/prospects/route";
const body = {
  action: "search",
  key: "unique-request-1",
  query: "Small consumer app companies",
  limit: 5,
};
const request = (b: unknown = body) =>
  new Request("https://cue.test/api/prospects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.operator.mockResolvedValue({
    email: "owner@cue.test",
    name: "Owner",
    role: "owner",
  });
  mocks.action.mockResolvedValue("run-id");
});
test("browser requests use the authenticated server identity and cannot supply an actor or key", async () => {
  expect((await POST(request())).status).toBe(200);
  expect(mocks.action.mock.calls[0][1].actor).toEqual({
    id: "owner@cue.test",
    name: "Owner",
    role: "owner",
  });
  expect(
    (await POST(request({ ...body, actor: { role: "owner" } }))).status,
  ).toBe(400);
  expect(mocks.action).toHaveBeenCalledTimes(1);
});
test("read auth, CSRF and saved role block calls before spending", async () => {
  mocks.operator.mockRejectedValueOnce(new Error("No session"));
  expect(
    (await GET(new Request("https://cue.test/api/prospects"))).status,
  ).toBe(401);
  mocks.sameOrigin.mockImplementationOnce(() => {
    throw new Error("Origin");
  });
  expect((await POST(request())).status).toBe(400);
  mocks.operator.mockResolvedValue({
    email: "support@cue.test",
    name: "Support",
    role: "support",
  });
  expect((await POST(request())).status).toBe(403);
  expect(mocks.action).not.toHaveBeenCalled();
});
test("provider and Convex errors never echo secrets into browser responses", async () => {
  mocks.action.mockRejectedValue(
    new Error("server-only-secret and API credential"),
  );
  const r = await POST(request());
  expect(r.status).toBe(400);
  expect(await r.text()).not.toContain("server-only-secret");
});
