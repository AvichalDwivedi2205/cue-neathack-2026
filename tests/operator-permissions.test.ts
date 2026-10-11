import { beforeEach, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({
  operator: vi.fn(),
  mutation: vi.fn(),
  query: vi.fn(),
  delivery: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../lib/access", () => ({
  operator: mocks.operator,
  sameOrigin: () => {},
  workosReady: () => true,
}));
vi.mock("../lib/server-store", async () => ({
  api: (await import("../convex/_generated/api")).api,
  db: () => ({ mutation: mocks.mutation, query: mocks.query }),
  secret: () => "test-secret",
}));
vi.mock("../lib/delivery", () => ({
  sendApproval: mocks.delivery,
  sendSpecApproval: mocks.delivery,
  sendEmail: mocks.delivery,
  sendSlackReply: mocks.delivery,
}));
vi.mock("../lib/attachment", () => ({ saveAttachment: mocks.save }));
vi.mock("../lib/gemini", () => ({
  geminiReady: () => true,
  draft: vi.fn(),
  generateSpec: vi.fn(),
}));
vi.mock("../lib/triage", () => ({ triage: vi.fn() }));
vi.mock("../lib/integration-config", () => ({
  slackConfig: vi.fn(),
  emailConfig: vi.fn(),
}));
vi.mock("../lib/integration-checks", () => ({
  slackRuntimeStatus: () => ({ connected: false }),
  notificationRuntimeStatus: () => null,
}));
import { POST } from "../app/api/demo/route";
import { api } from "../convex/_generated/api";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.operator.mockResolvedValue({
    id: "operator",
    name: "Holly",
    email: "product@example.com",
    role: "product",
  });
});
const request = (action: string, data: object = {}) =>
  new NextRequest("http://localhost:3000/api/demo", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    body: JSON.stringify({ action, ...data }),
  });
test.each(["approve", "reset", "slackSend", "investigate"])(
  "Product cannot invoke %s even with forged body role",
  async (action) => {
    const r = await POST(request(action, { role: "owner" }));
    expect(r.ok).toBe(false);
    expect((await r.json()).error).toContain("Product role cannot");
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.delivery).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  },
);
test("Support cannot call specification decisions", async () => {
  mocks.operator.mockResolvedValue({ name: "Aria", role: "support" });
  const r = await POST(request("spec", { approved: true }));
  expect(r.ok).toBe(false);
  expect(mocks.mutation).not.toHaveBeenCalled();
});
test("dashboard specification approval uses the stored version guard", async () => {
  const spec =
    '{"need":"Search","specification":"Find captions","acceptanceCriteria":["Match","Empty"]}';
  const r = await POST(
    request("spec", { issueId: "feature", spec, approved: true }),
  );
  expect(r.ok).toBe(true);
  expect(mocks.mutation).toHaveBeenCalledWith(api.cue.decideSpec, {
    secret: "test-secret",
    issueId: "feature",
    expectedSpec: spec,
    approve: true,
    actor: "Holly",
  });
});
