import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  poll: vi.fn(),
  classify: vi.fn(),
}));
vi.mock("../lib/server-store", () => ({
  api: { triageQueue: { receipt: "receipt", supersede: "supersede" } },
  db: () => ({ query: mocks.query, mutation: mocks.mutation }),
  secret: () => "hosted-test-secret",
}));
vi.mock("../lib/hosted-background", () => ({ pollHostedX: mocks.poll }));
vi.mock("../lib/triage", () => ({ classifySavedReport: mocks.classify }));
import { POST } from "../app/api/background/route";
const request = (body: unknown, token = "hosted-test-secret") =>
  new Request("https://cue.example.test/api/background", {
    method: "POST",
    headers: { authorization: "Bearer " + token },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockResolvedValue({
    status: "queued",
    latest: true,
    caseId: "case-1",
  });
});
test("public callers cannot invoke collection or access queued case data", async () => {
  expect((await POST(request({ action: "poll-x" }, "wrong"))).status).toBe(401);
  expect(mocks.poll).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
});
test("unknown actions and oversized inputs do not execute", async () => {
  expect((await POST(request({ action: "send-public-reply" }))).status).toBe(
    400,
  );
  expect(
    (await POST(request({ action: "triage", receiptId: "x".repeat(600) })))
      .status,
  ).toBe(400);
  expect(mocks.classify).not.toHaveBeenCalled();
});
test("hosted classification uses its saved case and receipt", async () => {
  expect(
    (await POST(request({ action: "triage", receiptId: "receipt-1" }))).status,
  ).toBe(200);
  expect(mocks.classify).toHaveBeenCalledWith("case-1", "receipt-1");
});
test("completed work is acknowledged without another Gemini call", async () => {
  mocks.query.mockResolvedValue({
    status: "completed",
    latest: true,
    caseId: "case-1",
  });
  expect(
    (await POST(request({ action: "triage", receiptId: "receipt-1" }))).status,
  ).toBe(200);
  expect(mocks.classify).not.toHaveBeenCalled();
});
test("superseded work does not classify the previous customer input", async () => {
  mocks.query.mockResolvedValue({
    status: "queued",
    latest: false,
    caseId: "case-1",
  });
  expect(
    (await POST(request({ action: "triage", receiptId: "receipt-1" }))).status,
  ).toBe(200);
  expect(mocks.classify).not.toHaveBeenCalled();
  expect(mocks.mutation).toHaveBeenCalledWith(
    "supersede",
    expect.objectContaining({ receiptId: "receipt-1" }),
  );
});
test("provider failure remains retryable and private details are not returned", async () => {
  mocks.classify.mockRejectedValue(new Error("Private provider credentials"));
  const response = await POST(
    request({ action: "triage", receiptId: "receipt-1" }),
  );
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("Private");
});
