import { expect, test } from "vitest";
import { supportProgress } from "../lib/support-progress";

test("receipt does not imply an investigation or verified fix", () => {
  const received = supportProgress({ issue: { kind: "bug", status: "open" } });
  expect(received.label).toBe("Received");
  expect(received.steps[1].state).toBe("pending");
  expect(
    supportProgress({ issue: { kind: "bug", status: "resolved" } }).label,
  ).toBe("Received");
});
test("verified release and subsequent customer failure have different progress", () => {
  const c = {
    issue: { kind: "bug", status: "resolved" },
    run: {
      status: "resolved",
      deployed: true,
      verified: true,
      commit: "a".repeat(40),
      updatedAt: 10,
    },
  };
  expect(supportProgress(c).label).toBe("Fix verified");
  expect(
    supportProgress({
      ...c,
      messages: [{ role: "customer", createdAt: 11, body: "It still fails" }],
    }).label,
  ).toBe("Needs review");
});
test("feature review cannot show a bug fix or shipped capability", () => {
  const c = supportProgress({ issue: { kind: "feature", status: "approved" } });
  expect(c.label).toBe("Specification approved");
  expect(c.steps.at(-1)).toEqual({ title: "Live", state: "pending" });
});
