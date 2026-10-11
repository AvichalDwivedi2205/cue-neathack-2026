import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  get: vi.fn(),
  send: vi.fn(),
}));
vi.mock("../lib/integration-config", () => ({
  emailConfig: mocks.config,
  slackConfig: vi.fn(),
}));
vi.mock("../lib/server-store", () => ({
  api: {
    cue: { snapshot: "snapshot", message: "message", event: "event" },
    deliveries: { reserve: "reserve", finish: "finish" },
  },
  db: () => ({ query: mocks.query, mutation: mocks.mutation }),
  secret: () => "test-secret",
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { receiving: { get: mocks.get }, send: mocks.send };
  },
}));
import { sendEmail } from "../lib/delivery";
import type { Id } from "../convex/_generated/dataModel";
const caseId = "test-case" as Id<"cases">;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CUE_OPERATOR_EMAIL", "owner@example.com");
  mocks.config.mockResolvedValue({
    apiKey: "test-key",
    from: "onboarding@resend.dev",
    replyTo: "support@example.com",
  });
  mocks.query.mockResolvedValue({
    cases: [
      {
        _id: caseId,
        channel: "email",
        sourceKey: "email:receipt",
        externalId: "receipt",
        customer: "owner@example.com",
        title: "Photo upload",
      },
    ],
  });
  mocks.get.mockResolvedValue({
    data: { message_id: "<original@example.com>" },
  });
  mocks.send.mockResolvedValue({ data: { id: "provider-receipt" } });
  mocks.mutation.mockResolvedValue("delivery-id");
});
test("test sender blocks other recipients before reading or sending mail", async () => {
  mocks.query.mockResolvedValue({
    cases: [
      {
        _id: caseId,
        channel: "email",
        sourceKey: "email:receipt",
        customer: "other@example.com",
      },
    ],
  });
  await expect(sendEmail(caseId, "Reply", "Operator")).rejects.toThrow(
    "configured operator email",
  );
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.mutation).not.toHaveBeenCalled();
});
test("mail reply preserves original RFC thread and reply address", async () => {
  await sendEmail(caseId, "Verified fix. Please retry.", "Operator");
  expect(mocks.send).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "owner@example.com",
      replyTo: "support@example.com",
      headers: {
        "In-Reply-To": "<original@example.com>",
        References: "<original@example.com>",
      },
    }),
    expect.objectContaining({ idempotencyKey: expect.any(String) }),
  );
  expect(mocks.mutation).toHaveBeenCalledWith(
    "finish",
    expect.objectContaining({ status: "sent", receipt: "provider-receipt" }),
  );
  expect(mocks.mutation).toHaveBeenCalledWith(
    "message",
    expect.objectContaining({ role: "staff" }),
  );
});
test("provider failure is uncertain delivery and never a sent conversation reply", async () => {
  mocks.send.mockResolvedValue({ error: { message: "Provider refused" } });
  await expect(sendEmail(caseId, "Reply", "Operator")).rejects.toThrow(
    "Provider refused",
  );
  expect(mocks.mutation).toHaveBeenCalledWith(
    "finish",
    expect.objectContaining({ status: "unknown" }),
  );
  expect(
    mocks.mutation.mock.calls.some(([method]) => method === "message"),
  ).toBe(false);
});
