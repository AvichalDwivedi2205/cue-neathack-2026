import { describe, expect, test } from "vitest";
import { filterMemoriesByCaption } from "../lib/memory-search";

const memories = [
  {
    id: "market",
    title: "Sunday market",
    date: "2026-09-14",
    caption: "Figs and bread still warm through the paper bag.",
  },
  {
    id: "coast",
    title: "Warm evening",
    date: "2026-09-02",
    caption: "Wind so strong we had to shout by the sea.",
  },
  { id: "untitled-caption", title: "Bread", date: "2026-08-24", caption: "" },
];

describe("filterMemoriesByCaption", () => {
  test("matches caption words case-insensitively, including separate keywords", () => {
    expect(filterMemoriesByCaption(memories, "WARM bag").map((m) => m.id)).toEqual([
      "market",
    ]);
  });

  test("does not match a title or date without a caption match", () => {
    expect(filterMemoriesByCaption(memories, "warm evening").map((m) => m.id)).toEqual(
      [],
    );
    expect(filterMemoriesByCaption(memories, "2026-09-14")).toEqual([]);
  });

  test("blank and cleared queries restore every memory in order", () => {
    expect(filterMemoriesByCaption(memories, "   ")).toEqual(memories);
    expect(filterMemoriesByCaption(memories, "warm")).toHaveLength(1);
    expect(filterMemoriesByCaption(memories, "")).toEqual(memories);
  });

  test("returns no memories when any keyword is missing from the caption", () => {
    expect(filterMemoriesByCaption(memories, "warm garden")).toEqual([]);
  });
});
