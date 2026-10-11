import { expect, test } from "vitest";
import {
  contextualAnswer,
  supportedAnswerLinks,
} from "../lib/workspace-answer";
const pr = "https://github.com/owner/repo/pull/12";
const local = "http://127.0.0.1:3000/bloom#/journal";
const context = JSON.stringify({
  tasks: [
    {
      evidence: [
        { url: pr },
        {
          text:
            "Verified local release at " +
            local +
            ".\nPublic release unverified.",
        },
      ],
    },
  ],
  recordedAnswer: "Saved facts",
});
test("copied historical footer cannot replace or duplicate current saved facts", () => {
  const answer = contextualAnswer(
    "One controlled browser activated.\n\nRecorded state:\nOld pending review.\nRepeated old footer.",
    "Publication verified; organic activation zero.",
  );
  expect(answer).toBe(
    "One controlled browser activated.\n\nRecorded state:\nPublication verified; organic activation zero.",
  );
  expect(answer).not.toContain("Old pending");
});
test.each([
  `PR: \`${pr}\`.`,
  `**${pr}**`,
  `[Review PR](${pr}). Local evidence: \`${local}\`.`,
  "Saved facts with no invented destination.",
])(
  "accepts exact stored references inside ordinary formatting: %s",
  (answer) => {
    expect(supportedAnswerLinks(answer, context)).toBe(true);
  },
);
test.each([
  "https://github.com/owner/repo/pull/1",
  pr + "0",
  pr + "/changed",
  pr + "?token=made-up",
  "https://unknown.test/",
  `https://github.com@evil.test/owner/repo/pull/12`,
])("rejects fabricated and prefix-matched references: %s", (answer) => {
  expect(supportedAnswerLinks(answer, context)).toBe(false);
});
