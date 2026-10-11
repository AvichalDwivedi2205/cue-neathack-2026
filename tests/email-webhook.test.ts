/// <reference types="vite/client" />
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";
import schema from "../convex/schema";
import { api as convexApi } from "../convex/_generated/api";
const modules = import.meta.glob("../convex/**/*.{ts,js}");
const state = vi.hoisted(() => ({
  receive: vi.fn(),
  mutation: vi.fn(),
  triage: vi.fn(),
}));
const key = "01234567890123456789012345678901";
vi.mock("../lib/integration-config", () => ({
  emailConfig: async () => ({
    apiKey: "re_test",
    from: "support@example.com",
    notificationImport: true,
    receivingAddress: "mentions@example.com",
    supportReceivingAddress: "support@example.com",
    webhookSecret:
      "whsec_" +
      Buffer.from("01234567890123456789012345678901").toString("base64"),
  }),
}));
vi.mock("../lib/server-store", () => ({
  api: { intake: { receive: "intake:receive" } },
  db: () => ({ mutation: state.mutation }),
  secret: () => "test-server-secret",
}));
vi.mock("../lib/triage", () => ({ triage: state.triage }));
vi.mock("next/server", () => ({
  after: (fn: () => Promise<void>) => {
    void fn();
  },
}));
vi.mock("resend", async (original) => {
  const actual = await original<typeof import("resend")>();
  return {
    Resend: class {
      webhooks = new actual.Resend("re_test").webhooks;
      emails = { receiving: { get: state.receive } };
    },
  };
});
import { POST } from "../app/api/webhooks/email/route";
function routing(
  from = "alice@example.com",
  subject = "Support request",
  to?: string[],
) {
  return {
    from,
    subject,
    to: to || [
      /reddit|notify@x/.test(from)
        ? "mentions@example.com"
        : "support@example.com",
    ],
    created_at: new Date().toISOString(),
  };
}
function request(
  tamper = false,
  age = 0,
  emailId = "received-1",
  from = "alice@example.com",
  subject = "Support request",
  to?: string[],
) {
  const payload = JSON.stringify({
    type: "email.received",
    data: { email_id: emailId, ...routing(from, subject, to) },
  });
  const id = "msg_test",
    timestamp = String(Math.floor(Date.now() / 1000) - age);
  const signature = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  return new Request("http://localhost/api/webhooks/email", {
    method: "POST",
    body: tamper ? payload.replace("received-1", "forged-1") : payload,
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": "v1," + signature,
    },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  state.receive.mockResolvedValue({
    data: {
      ...routing(),
      id: "received-1",
      from: "Alice <ALICE@example.com>",
      subject: "Re: Support request",
      text: "More evidence",
      message_id: "<reply@example.com>",
      headers: {
        References: "<root@example.com>",
        "In-Reply-To": "<root@example.com>",
      },
    },
    error: null,
  });
  state.mutation.mockResolvedValue({ caseId: "case-test", duplicate: false });
  state.triage.mockResolvedValue(undefined);
});
describe("Inbound email verification", () => {
  test("signed mail outside the configured recipients is never retrieved", async () => {
    const response = await POST(
      request(false, 0, "received-1", "alice@example.com", "Support request", [
        "other@example.com",
      ]),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).imported).toBe(0);
    expect(state.receive).not.toHaveBeenCalled();
  });
  test("provider body cannot change the receipt identity or routing", async () => {
    state.receive.mockResolvedValue({
      data: { ...routing(), id: "another-receipt", text: "Private body" },
    });
    expect((await POST(request())).status).toBe(400);
    expect(state.mutation).not.toHaveBeenCalled();
  });
  test("tampered payloads cannot retrieve mail or create cases", async () => {
    expect((await POST(request(true))).status).toBe(400);
    expect(state.receive).not.toHaveBeenCalled();
    expect(state.mutation).not.toHaveBeenCalled();
  });
  test("old signed webhook deliveries are rejected", async () => {
    expect((await POST(request(false, 3600))).status).toBe(400);
    expect(state.receive).not.toHaveBeenCalled();
  });
  test("verified receipts preserve email threading and normalize sender identity", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(state.receive).toHaveBeenCalledWith("received-1");
    expect(state.mutation).toHaveBeenCalledWith(
      "intake:receive",
      expect.objectContaining({
        customer: "alice@example.com",
        externalId: "received-1",
        messageKey: "rfc822:<reply@example.com>",
        references: expect.arrayContaining(["rfc822:<root@example.com>"]),
      }),
    );
  });
  test("a signed digest imports both source posts and triages each new case", async () => {
    state.receive.mockResolvedValue({
      data: {
        ...routing("notify@x.com", "New notifications"),
        id: "received-1",
        from: "notify@x.com",
        subject: "New notifications",
        html: '<ul><li>Upload fails <a href="https://x.com/alice/status/123456">View</a></li><li>Dark mode please <a href="https://x.com/bob/status/789012">View</a></li></ul>',
      },
    });
    const response = await POST(
      request(false, 0, "received-1", "notify@x.com", "New notifications"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, imported: 2 });
    expect(state.mutation).toHaveBeenCalledTimes(2);
    expect(state.triage).toHaveBeenCalledTimes(2);
    expect(state.mutation.mock.calls[0][1]).toMatchObject({
      channel: "x",
      sourceKey: "x:123456",
      transport: "notification_email",
    });
  });
  test("duplicate social deliveries do not retrigger triage", async () => {
    state.receive.mockResolvedValue({
      data: {
        ...routing("noreply@redditmail.com", "Alice mentioned you"),
        id: "received-1",
        from: "noreply@redditmail.com",
        subject: "Alice mentioned you",
        text: "Upload fails https://www.reddit.com/r/bloom/comments/abc123/help/def456/",
      },
    });
    state.mutation.mockResolvedValue({ caseId: "case-test", duplicate: true });
    expect(
      await (
        await POST(
          request(
            false,
            0,
            "received-1",
            "noreply@redditmail.com",
            "Alice mentioned you",
          ),
        )
      ).json(),
    ).toEqual({
      ok: true,
      imported: 0,
    });
    expect(state.triage).not.toHaveBeenCalled();
  });
  test("signed platform security emails cannot create customer cases", async () => {
    state.receive.mockResolvedValue({
      data: {
        id: "received-1",
        from: "notify@x.com",
        subject: "Your verification code",
        text: "123456",
      },
    });
    const response = await POST(
      request(false, 0, "received-1", "notify@x.com", "Your verification code"),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).ignored).toContain(
      "Outside configured inbox",
    );
    expect(state.receive).not.toHaveBeenCalled();
    expect(state.mutation).not.toHaveBeenCalled();
  });
  test("signed gateway and actual Convex handlers preserve digest cases through repeated delivery", async () => {
    vi.stubEnv("CUE_DEMO_SECRET", "test-server-secret");
    const t = convexTest(schema, modules);
    state.mutation.mockImplementation(
      (_name: string, args: FunctionArgs<typeof convexApi.intake.receive>) =>
        t.mutation(convexApi.intake.receive, args),
    );
    const digest = {
      ...routing("notify@x.com", "New notifications"),
      from: "notify@x.com",
      subject: "New notifications",
      html: '<ul><li>My 3 MB photo upload returns 413 <a href="https://x.com/alice/status/123456">View</a></li><li>Please add dark mode <a href="https://x.com/bob/status/789012">View</a></li></ul>',
    };
    try {
      state.receive.mockResolvedValue({
        data: { ...digest, id: "received-1" },
      });
      expect(
        await (
          await POST(
            request(
              false,
              0,
              "received-1",
              "notify@x.com",
              "New notifications",
            ),
          )
        ).json(),
      ).toEqual({
        ok: true,
        imported: 2,
      });
      expect(
        await (
          await POST(
            request(
              false,
              0,
              "received-1",
              "notify@x.com",
              "New notifications",
            ),
          )
        ).json(),
      ).toEqual({
        ok: true,
        imported: 0,
      });
      state.receive.mockResolvedValue({
        data: { ...digest, id: "received-2" },
      });
      expect(
        await (
          await POST(
            request(
              false,
              0,
              "received-2",
              "notify@x.com",
              "New notifications",
            ),
          )
        ).json(),
      ).toEqual({ ok: true, imported: 0 });
      state.receive.mockResolvedValue({
        data: {
          ...routing("noreply@redditmail.com", "Alice mentioned you"),
          id: "received-3",
          from: "noreply@redditmail.com",
          subject: "Alice mentioned you",
          text: "3 MB photo upload fails https://www.reddit.com/r/bloom/comments/abc123/help/def456/",
        },
      });
      expect(
        await (
          await POST(
            request(
              false,
              0,
              "received-3",
              "noreply@redditmail.com",
              "Alice mentioned you",
            ),
          )
        ).json(),
      ).toEqual({ ok: true, imported: 1 });
      const s = await t.query(convexApi.cue.snapshot, {
        secret: "test-server-secret",
      });
      expect(s.cases).toHaveLength(3);
      expect(s.cases.map((c) => c.sourceKey).sort()).toEqual([
        "reddit:comment:def456",
        "x:123456",
        "x:789012",
      ]);
      expect(
        s.cases.every((c) => c.provenance.includes("author unverified")),
      ).toBe(true);
      expect(s.messages.filter((m) => m.role === "customer")).toHaveLength(3);
      expect(s.messages.filter((m) => m.role === "cue")).toHaveLength(0);
      expect(s.issues.find((i) => /dark mode/.test(i.description))?.kind).toBe(
        "feature",
      );
      expect(state.triage).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
