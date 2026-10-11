import { expect, test, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn() }));
vi.mock("../lib/server-store", async () => ({
  api: (await import("../convex/_generated/api")).api,
  db: () => mocks,
  secret: () => "never-expose-this",
}));
vi.mock("../lib/integration-config", () => ({
  readIntegrations: async () => ({
    apps: [
      {
        id: "registered",
        name: "Bloom",
        origins: ["https://bloom-with-cue.vercel.app"],
      },
    ],
  }),
}));
vi.mock("../lib/access", () => ({
  operator: async () => ({
    id: "workos-id",
    email: "owner@example.test",
    name: "Owner",
    role: "owner",
    organizationId: "org-extra",
  }),
  sameOrigin: () => {},
}));
import { POST } from "../app/api/agents/route";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ issues: [] });
});
const request = () =>
  new Request("https://cue.example.test/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: "engineering",
      appId: "registered",
      text: "Show work",
      key: "native-command-1",
    }),
  });
test("operator identity maps to strict saved actor contract shared with Slack", async () => {
  mocks.mutation.mockResolvedValue({
    response: "No work",
    taskId: null,
    duplicate: false,
  });
  expect((await POST(request())).status).toBe(200);
  expect(mocks.mutation.mock.calls[0][1].actor).toEqual({
    id: "owner@example.test",
    name: "Owner",
    role: "owner",
  });
});
test("validation failures never echo trusted secret or request arguments", async () => {
  mocks.mutation.mockRejectedValue(
    new Error('ArgumentValidationError: secret: "never-expose-this"'),
  );
  const response = await POST(request());
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain("never-expose-this");
});
