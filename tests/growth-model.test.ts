import { beforeEach, expect, test, vi } from "vitest";
const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("../lib/gemini", () => ({
  client: () => ({ models: { generateContent: generate } }),
}));
import { draftGrowth, qualifyGrowth } from "../lib/growth-model";
const link = "https://cue.test/g/opaque";
const claims = ["Find saved memories using all words in a caption query"];
beforeEach(() => generate.mockReset());
test("unsupported qualification retains the actual request when the model copies a capability need", async () => {
  const source =
    "Anyone recommend a photo journal app that exports memories with photos and captions into a PDF?";
  generate.mockResolvedValue({
    text: JSON.stringify({
      need: "Find older memories by caption",
      matched: true,
      eligible: true,
      fit: "High",
      reasons: ["Caption capability matches"],
    }),
  });
  expect(await qualifyGrowth(source, { claims })).toMatchObject({
    need: source,
    matched: false,
    eligible: false,
    reasons: [
      "Unsupported need: no verified export, sync or collaboration capability",
    ],
  });
});
test.each([
  "Cue finds saved caption words: ",
  "Bloom finds captions using any query word: ",
  "Bloom supports collaborative albums: ",
  "Bloom syncs captions across phones: ",
])("rejects unverified model wording: %s", async (wording) => {
  generate.mockResolvedValue({ text: wording + link });
  await expect(
    draftGrowth("Find saved captions", claims, link, "Bloom"),
  ).rejects.toThrow("supported-claim policy");
});
test.each([`${link} ${link}`, `${link} https://unrelated.test`])(
  "rejects duplicate or additional destinations",
  async (urls) => {
    generate.mockResolvedValue({ text: "Find saved captions: " + urls });
    await expect(
      draftGrowth("Find saved captions", claims, link, "Bloom"),
    ).rejects.toThrow("supported-claim policy");
  },
);
test("passes the actual product name and preserves all-word search", async () => {
  const text = "Bloom finds saved captions using all query words: " + link;
  generate.mockResolvedValue({ text });
  expect(await draftGrowth("Find saved captions", claims, link, "Bloom")).toBe(
    text,
  );
  expect(JSON.parse(generate.mock.calls[0][0].contents).productName).toBe(
    "Bloom",
  );
});
