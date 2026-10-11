import { expect, test } from "vitest";
import { growthOutcomeSummary } from "../lib/growth-outcomes";
const touches = [
  {
    _id: "verified",
    status: "verified",
    publicationUrl: "https://x.com/brand/status/1",
  },
  { _id: "unverified", status: "pending" },
];
const milestone = { confirmedAt: 1, savedAt: 2, activatedAt: 3 };
test("controlled activation is separated from new organic and returning browser evidence", () => {
  const summary = growthOutcomeSummary(touches, [
    { touchId: "verified", internal: true, returning: false, ...milestone },
    { touchId: "verified", internal: false, returning: false, confirmedAt: 4 },
    { touchId: "verified", internal: false, returning: true, ...milestone },
    {
      touchId: "another-task",
      internal: false,
      returning: false,
      ...milestone,
    },
    { touchId: "unverified", internal: false, returning: false, ...milestone },
  ]);
  expect(summary).toContain(
    "Controlled browsers: confirmed 1 · first save 1 · caption match 1",
  );
  expect(summary).toContain(
    "Organic new browsers: confirmed 1 · first save 0 · caption match 0",
  );
  expect(summary).toContain(
    "Returning browsers: confirmed 1 · first save 1 · caption match 1",
  );
  expect(summary).toContain(
    "Verified publication: https://x.com/brand/status/1",
  );
  expect(summary).toContain("Retention not measured");
});
test("unverified publication and redirects cannot establish product activation", () => {
  const summary = growthOutcomeSummary(
    [{ _id: "pending", status: "pending" }],
    [{ touchId: "pending", internal: true, returning: false, ...milestone }],
  );
  expect(summary).toContain("Publication not verified");
  expect(summary).not.toContain("confirmed 1");
});
