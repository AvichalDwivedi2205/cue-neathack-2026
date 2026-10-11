import { z } from "zod";
import type { XConfig } from "./integration-config";

const id = z.string().regex(/^\d{1,30}$/);
const username = z.string().regex(/^[A-Za-z0-9_]{1,15}$/);
const mentions = z.array(z.object({ id: id.optional(), username }));
const pageSchema = z
  .object({
    data: z
      .array(
        z.object({
          id,
          text: z.string().min(1).max(12000),
          author_id: id,
          created_at: z.iso.datetime(),
          entities: z.object({ mentions: mentions.optional() }).optional(),
          referenced_tweets: z
            .array(z.object({ type: z.string(), id }))
            .optional(),
        }),
      )
      .max(5)
      .optional(),
    includes: z
      .object({ users: z.array(z.object({ id, username })).max(10).optional() })
      .optional(),
    meta: z
      .object({
        next_token: z.string().max(1000).optional(),
        result_count: z.number().int().nonnegative().optional(),
      })
      .optional(),
    errors: z.array(z.unknown()).optional(),
  })
  .refine((value) => !!value.data || value.meta?.result_count === 0);
const creditsSchema = z.object({
  data: z.object({
    free_balance: z.number().finite(),
    total_balance: z.number().finite(),
    prepaid_balance: z.number().finite(),
    free_grants: z.array(
      z.object({ amount: z.number().finite(), expires_at: z.iso.datetime() }),
    ),
  }),
});
export type XPage = z.infer<typeof pageSchema>;
export type XReport = {
  channel: "x";
  transport: "x_api";
  eventKey: string;
  sourceKey: string;
  externalId: string;
  customer: string;
  title: string;
  body: string;
  sourceUrl: string;
};
export class XApiError extends Error {
  constructor(readonly reason: "credits" | "auth" | "rate" | "provider") {
    super(
      {
        credits:
          "X intake paused: free credits unavailable or below the $1 reserve.",
        auth: "X API access denied. Check the app token and developer account.",
        rate: "X rate limit reached. Intake retries after cooldown.",
        provider:
          "X API unavailable or returned an incomplete response. Intake will retry.",
      }[reason],
    );
  }
}
// Keep requests on the official origin. Redirects must never receive credentials.
export function createXApi(config: XConfig, request: typeof fetch = fetch) {
  async function get(path: string) {
    let response: Response;
    try {
      response = await request("https://api.x.com/2/" + path, {
        headers: { authorization: "Bearer " + config.bearerToken },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new XApiError("provider");
    }
    if (!response.ok)
      throw new XApiError(
        response.status === 402
          ? "credits"
          : [401, 403].includes(response.status)
            ? "auth"
            : response.status === 429
              ? "rate"
              : "provider",
      );
    try {
      return await response.json();
    } catch {
      throw new XApiError("provider");
    }
  }
  return {
    async credits(now = Date.now()) {
      const result = creditsSchema.safeParse(await get("usage/credits"));
      if (!result.success) throw new XApiError("provider");
      const value = result.data.data;
      // Free-credit-only intake, with a conservative reserve and expiry margin.
      // Cue cannot buy credits or enable provider auto-recharge.
      if (
        value.free_balance < 1 ||
        value.total_balance < 1 ||
        value.free_grants
          .filter((g) => g.amount > 0 && Date.parse(g.expires_at) > now + 60000)
          .reduce((sum, g) => sum + g.amount, 0) < 1
      )
        throw new XApiError("credits");
      return { freeBalance: value.free_balance };
    },
    async verifyBrand() {
      const result = z
        .object({ data: z.object({ id, username }) })
        .safeParse(await get("users/" + config.userId));
      if (
        !result.success ||
        result.data.data.id !== config.userId ||
        result.data.data.username.toLowerCase() !==
          config.username.toLowerCase()
      )
        throw new XApiError("auth");
    },
    async mentions(cursor: { sinceId?: string; nextToken?: string }) {
      const query = new URLSearchParams({
        max_results: "5",
        expansions: "author_id",
        "tweet.fields": "author_id,created_at,entities,referenced_tweets",
        "user.fields": "username",
        ...(cursor.sinceId
          ? { since_id: cursor.sinceId }
          : { start_time: new Date(config.startedAt).toISOString() }),
        ...(cursor.nextToken ? { pagination_token: cursor.nextToken } : {}),
      });
      const result = pageSchema.safeParse(
        await get(`users/${config.userId}/mentions?${query}`),
      );
      if (!result.success || result.data.errors?.length)
        throw new XApiError("provider");
      return result.data;
    },
  };
}
export function xReports(page: XPage, config: XConfig): XReport[] {
  const authors = new Map(
    page.includes?.users?.map((u) => [u.id, u.username]) || [],
  );
  const reports: XReport[] = [];
  for (const post of page.data || []) {
    const author = authors.get(post.author_id);
    if (!author) throw new XApiError("provider");
    if (
      Date.parse(post.created_at) < config.startedAt ||
      post.author_id === config.userId ||
      post.referenced_tweets?.some((r) => r.type === "retweeted") ||
      !post.entities?.mentions?.some((m) =>
        m.id
          ? m.id === config.userId
          : m.username.toLowerCase() === config.username.toLowerCase(),
      )
    )
      continue;
    const sourceKey = "x:" + post.id;
    reports.push({
      channel: "x",
      transport: "x_api",
      eventKey: "x-api:" + sourceKey,
      externalId: "x-api:" + sourceKey,
      sourceKey,
      customer: "@" + author,
      title: post.text.slice(0, 160),
      body: post.text,
      sourceUrl: `https://x.com/${author}/status/${post.id}`,
    });
  }
  return reports;
}
