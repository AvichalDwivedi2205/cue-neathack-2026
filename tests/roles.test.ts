import { expect, test } from "vitest";
import {
  can,
  actionPermission,
  membersInput,
  memberForEmail,
  reviewers,
  slackMember,
  type Role,
} from "../lib/roles";
const members = membersInput.parse([
  {
    email: "owner@example.com",
    name: "Avichal",
    role: "owner",
    slackId: "UOWNER",
  },
  {
    email: "engineering@example.com",
    name: "Ganesh",
    role: "engineering",
    slackId: "UENGINEER",
  },
  {
    email: "product@example.com",
    name: "Holly",
    role: "product",
    slackId: "UPRODUCT",
  },
  {
    email: "support@example.com",
    name: "Aria",
    role: "support",
    slackId: "USUPPORT",
  },
]);
test.each([
  ["owner", true, true, true, true],
  ["engineering", true, false, false, false],
  ["product", false, true, false, false],
  ["support", false, false, true, false],
] as [Role, boolean, boolean, boolean, boolean][])(
  "%s receives only its assigned permissions",
  (role, deploy, spec, support, manage) => {
    expect([
      can(role, "deploy"),
      can(role, "spec"),
      can(role, "support"),
      can(role, "manage"),
    ]).toEqual([deploy, spec, support, manage]);
  },
);
test("account access requires a verified exact email; display names confer no access", () => {
  expect(
    memberForEmail("PRODUCT@example.com", true, "owner@example.com", members)
      .role,
  ).toBe("product");
  expect(() =>
    memberForEmail("product@example.com", false, "owner@example.com", members),
  ).toThrow("Verify");
  expect(() =>
    memberForEmail("stranger@example.com", true, "owner@example.com", members),
  ).toThrow("access");
  expect(
    memberForEmail("owner@example.com", true, "owner@example.com", members)
      .role,
  ).toBe("owner");
});
test("explicit membership revokes legacy Slack access and routes to the intended reviewer", () => {
  const config = { members, operatorIds: ["ULEGACY"] };
  expect(slackMember(config, "ULEGACY")).toBeUndefined();
  expect(slackMember(config, "USUPPORT")?.role).toBe("support");
  expect(reviewers(config, "deploy")).toEqual(["UENGINEER"]);
  expect(reviewers(config, "spec")).toEqual(["UPRODUCT"]);
  expect(
    slackMember(
      { ...config, members: members.filter((m) => m.role !== "support") },
      "USUPPORT",
    ),
  ).toBeUndefined();
});
test("pending invitees cannot approve Slack; duplicate emails and IDs fail closed", () => {
  const pending = members.map((m) =>
    m.role === "product" ? { ...m, slackId: undefined } : m,
  );
  expect(reviewers({ members: pending, operatorIds: [] }, "spec")).toEqual([
    "UOWNER",
  ]);
  expect(
    slackMember({ members: pending, operatorIds: [] }, "UPRODUCT"),
  ).toBeUndefined();
  expect(membersInput.safeParse([...members, members[1]]).success).toBe(false);
  expect(
    membersInput.safeParse([
      ...members,
      { ...members[1], email: "another@example.com" },
    ]).success,
  ).toBe(false);
});
test("all mutations declare permissions and unknown actions fail closed", () => {
  expect(actionPermission("approve")).toBe("deploy");
  expect(actionPermission("specApproval")).toBe("spec");
  expect(actionPermission("slackSend")).toBe("support");
  expect(actionPermission("reset")).toBe("manage");
  expect(() => actionPermission("unknown")).toThrow("Unknown");
});
