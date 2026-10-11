import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  classify: vi.fn(),
}));
vi.mock("../lib/server-store", () => ({
  api: { cue: { snapshot: "snapshot", triage: "triage" } },
  db: () => ({ query: mocks.query, mutation: mocks.mutation }),
  secret: () => "test-only",
}));
vi.mock("../lib/gemini", () => ({
  geminiReady: () => true,
  classifyReport: mocks.classify,
}));
import { classifySavedReport } from "../lib/triage";
import type { Id } from "../convex/_generated/dataModel";

beforeEach(() => vi.clearAllMocks());
function setup(appId?: string, confidence = 0.99) {
  const prefix = appId ? appId + ":" : "";
  const current = {
    _id: "new-issue",
    appId,
    fingerprint: prefix + "report:123",
    kind: "feature",
  };
  const matched = {
    _id: "same-need",
    appId,
    fingerprint: prefix + "report:456",
    kind: "feature",
  };
  const foreign = {
    _id: "foreign",
    appId: "other-app",
    fingerprint: "other-app:report:789",
    kind: "feature",
  };
  mocks.query.mockResolvedValue({
    cases: [
      {
        _id: "case-1",
        appId,
        issueId: current._id,
        title: "Larger journal text",
        body: "Please add text size settings",
      },
    ],
    issues: [current, matched, foreign],
    messages: [],
  });
  mocks.classify.mockResolvedValue({
    matchedIssueId: matched._id,
    kind: "feature",
    priority: "P3",
    tags: ["readability"],
    reason: "Same text-size need",
    confidence,
  });
}
test.each([undefined, "connected-app"])(
  "equivalent requests can merge inside app %s without including themselves",
  async (appId) => {
    setup(appId);
    await classifySavedReport("case-1" as Id<"cases">);
    const context = mocks.classify.mock.calls[0][0];
    expect(context.candidates.map((c: { id: string }) => c.id)).toEqual([
      "same-need",
    ]);
    expect(mocks.mutation.mock.calls[0][1].issueId).toBe("same-need");
  },
);
test("uncertain equivalence remains unmerged", async () => {
  setup("connected-app", 0.9);
  await classifySavedReport("case-1" as Id<"cases">);
  expect(mocks.mutation.mock.calls[0][1].issueId).toBeUndefined();
});
test("a model-supplied foreign ID never routes the report across apps", async () => {
  setup("connected-app");
  mocks.classify.mockResolvedValue({
    matchedIssueId: "foreign",
    kind: "feature",
    priority: "P3",
    tags: [],
    reason: "Untrusted match",
    confidence: 1,
  });
  await classifySavedReport("case-1" as Id<"cases">);
  expect(mocks.mutation.mock.calls[0][1].issueId).toBeUndefined();
});
