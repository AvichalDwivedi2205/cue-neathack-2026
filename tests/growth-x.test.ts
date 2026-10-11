import { expect, test, vi, afterEach } from "vitest";
import { growthX } from "../lib/growth-x";
import {
  issueGrowthToken,
  validGrowthToken,
  validEventSignature,
} from "../lib/growth-links";
import { createHmac } from "node:crypto";
import { growthPolicy } from "../lib/growth-model";
const config = {
  bearerToken: "test-token",
  userId: "1",
  username: "bloomwithcue",
  enabled: true,
  startedAt: Date.now(),
};
afterEach(() => vi.unstubAllEnvs());
test("search uses separate ten-post validator, official origin and isolated cursor; incomplete sources fail closed", async () => {
  let url = "";
  const fetcher = vi.fn(async (input: unknown) => {
    url = String(input);
    return Response.json({
      data: [
        {
          id: "22",
          author_id: "2",
          text: "Anyone recommend caption search?",
          created_at: new Date().toISOString(),
        },
      ],
      includes: { users: [{ id: "2", username: "tester" }] },
      meta: { result_count: 1, next_token: "next" },
    });
  });
  const result = await growthX(config, fetcher).search("caption journal", {
    sinceId: "10",
    nextToken: "cursor",
  });
  expect(new URL(url).origin).toBe("https://api.x.com");
  expect(new URL(url).searchParams.get("max_results")).toBe("10");
  expect(new URL(url).searchParams.get("next_token")).toBe("cursor");
  expect(result.posts[0].sourceUrl).toBe("https://x.com/tester/status/22");
  await expect(
    growthX(config, async () =>
      Response.json({
        data: [
          {
            id: "22",
            author_id: "2",
            text: "x",
            created_at: new Date().toISOString(),
          },
        ],
        meta: { result_count: 1 },
      }),
    ).search("query", {}),
  ).rejects.toThrow("incomplete");
});
test("independent publication read rejects wrong author, original thread, text and expanded campaign URL", async () => {
  const link = "https://cue.test/g/opaque",
    text = "Try caption search: " + link;
  const base = {
    id: "9",
    text: "Try caption search: https://t.co/test",
    author_id: "1",
    created_at: new Date().toISOString(),
    referenced_tweets: [{ type: "replied_to", id: "22" }],
    entities: { urls: [{ url: "https://t.co/test", expanded_url: link }] },
  };
  const verify = async (data: unknown) =>
    growthX(config, async () => Response.json({ data })).verify(
      "https://x.com/bloomwithcue/status/9",
      "22",
      text,
      link,
    );
  expect(await verify(base)).toContain("matched");
  for (const changed of [
    { ...base, author_id: "2" },
    { ...base, referenced_tweets: [{ type: "replied_to", id: "23" }] },
    { ...base, text: "Changed reply" },
    {
      ...base,
      entities: {
        urls: [{ url: "https://t.co/test", expanded_url: "https://evil.test" }],
      },
    },
  ])
    await expect(verify(changed)).rejects.toThrow("mismatch");
});
test("native reply recipient metadata does not change the exact approved body", async () => {
  const link = "https://cue.test/g/opaque";
  const text = "Try caption search: " + link;
  const base = {
    id: "9",
    text: "@tester Try caption search: https://t.co/test",
    author_id: "1",
    created_at: new Date().toISOString(),
    referenced_tweets: [{ type: "replied_to", id: "22" }],
    entities: {
      mentions: [{ start: 0, end: 7, username: "tester" }],
      urls: [{ url: "https://t.co/test", expanded_url: link }],
    },
  };
  const verify = (data: unknown, sourceAuthor = "@tester") =>
    growthX(config, async () => Response.json({ data })).verify(
      "https://x.com/bloomwithcue/status/9",
      "22",
      text,
      link,
      sourceAuthor,
    );
  expect(await verify(base)).toContain("recipient mention checked separately");
  await expect(verify(base, "@other")).rejects.toThrow("mismatch");
  for (const changed of [
    { ...base, entities: { urls: base.entities.urls } },
    {
      ...base,
      entities: {
        ...base.entities,
        mentions: [{ start: 1, end: 7, username: "tester" }],
      },
    },
    {
      ...base,
      entities: {
        ...base.entities,
        mentions: [{ start: 0, end: 8, username: "tester" }],
      },
    },
    { ...base, text: "@tester @other Try caption search: https://t.co/test" },
    { ...base, text: "@tester Changed reply: https://t.co/test" },
    { ...base, author_id: "2" },
    { ...base, referenced_tweets: [{ type: "replied_to", id: "23" }] },
  ])
    await expect(verify(changed)).rejects.toThrow("mismatch");
});
test("opaque link and event signing bind full payload, app and five-minute timestamp", () => {
  vi.stubEnv("CUE_DEMO_SECRET", "secret-signing-key");
  const token = issueGrowthToken();
  expect(validGrowthToken(token)).toBe(true);
  expect(
    validGrowthToken(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a")),
  ).toBe(false);
  vi.stubEnv(
    "CUE_GROWTH_EVENT_SECRETS",
    JSON.stringify({ app: "e".repeat(64) }),
  );
  const body = '{"action":"event","appId":"app"}',
    stamp = String(Date.now()),
    sig = createHmac("sha256", "e".repeat(64))
      .update(stamp + "." + body)
      .digest("hex");
  expect(validEventSignature("app", body, stamp, sig)).toBe(true);
  expect(validEventSignature("app", body + " ", stamp, sig)).toBe(false);
  expect(
    validEventSignature("app", body, String(Date.now() - 600000), sig),
  ).toBe(false);
  expect(() => validEventSignature("other", body, stamp, sig)).toThrow(
    "not configured",
  );
});
test("server policy separates explicit recommendation need from complaints, unrelated posts and unsupported features", () => {
  const proposed = {
    need: "search",
    matched: true,
    eligible: true,
    fit: "High" as const,
    reasons: ["Model suggestion"],
  };
  expect(
    growthPolicy(
      "Anyone recommend a photo journal app with caption search?",
      proposed,
    ).eligible,
  ).toBe(true);
  for (const text of [
    "Bloom caption search is broken",
    "I wrote a journal about search engines",
    "Anyone recommend photo journal PDF export?",
    "Anyone need collaborative shared albums with caption search?",
  ])
    expect(growthPolicy(text, proposed).eligible).toBe(false);
});

test("caption editing and promotional copy cannot grant recommendation eligibility", () => {
  const yes = {
    need: "caption search",
    eligible: true,
    matched: true,
    fit: "High" as const,
    reasons: [],
  };
  expect(
    growthPolicy(
      "Please recommend a photo editor to add text captions to an image",
      yes,
    ).eligible,
  ).toBe(false);
  expect(
    growthPolicy(
      "Try our journal! Looking for memory caption search? Subscribe now",
      yes,
    ).eligible,
  ).toBe(false);
  expect(
    growthPolicy(
      "Is there a photo diary app to search captions of saved memories?",
      yes,
    ).eligible,
  ).toBe(true);
});
