import { z } from "zod";
import type { XConfig } from "./integration-config";
import { XApiError } from "./x-api";
const id = z.string().regex(/^\d{1,30}$/);
const post = z.object({
  id,
  text: z.string().max(12000),
  author_id: id,
  created_at: z.iso.datetime(),
  entities: z
    .object({
      urls: z
        .array(z.object({ url: z.url(), expanded_url: z.url() }))
        .optional(),
      mentions: z
        .array(
          z.object({
            start: z.number().int().min(0),
            end: z.number().int().min(1),
            username: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
          }),
        )
        .max(50)
        .optional(),
    })
    .optional(),
  referenced_tweets: z.array(z.object({ type: z.string(), id })).optional(),
});
const page = z.object({
  data: z.array(post).max(10).optional(),
  includes: z
    .object({
      users: z
        .array(
          z.object({ id, username: z.string().regex(/^[A-Za-z0-9_]{1,15}$/) }),
        )
        .max(10),
    })
    .optional(),
  meta: z.object({
    result_count: z.number().int(),
    next_token: z.string().max(1000).optional(),
    newest_id: id.optional(),
  }),
  errors: z.array(z.unknown()).optional(),
});
export function growthX(config: XConfig, request: typeof fetch = fetch) {
  async function get(path: string) {
    let r: Response;
    try {
      r = await request("https://api.x.com/2/" + path, {
        headers: { authorization: "Bearer " + config.bearerToken },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new XApiError("provider");
    }
    if (!r.ok)
      throw new XApiError(
        r.status === 402
          ? "credits"
          : [401, 403].includes(r.status)
            ? "auth"
            : r.status === 429
              ? "rate"
              : "provider",
      );
    return r.json();
  }
  return {
    async source(url: string) {
      const m = url.match(
        /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)$/,
      );
      if (!m) throw new Error("Invalid X source URL");
      const result = z
        .object({
          data: post,
          includes: z.object({
            users: z.array(z.object({ id, username: z.string() })).max(5),
          }),
          errors: z.array(z.unknown()).optional(),
        })
        .safeParse(
          await get(
            `tweets/${m[2]}?expansions=author_id&tweet.fields=author_id,created_at,entities,referenced_tweets&user.fields=username`,
          ),
        );
      if (!result.success || result.data.errors?.length)
        throw new XApiError("provider");
      const author = result.data.includes.users.find(
        (u) => u.id === result.data.data.author_id,
      );
      if (
        !author ||
        author.username.toLowerCase() !== m[1].toLowerCase() ||
        result.data.data.author_id === config.userId
      )
        throw new Error("Source author rejected");
      return {
        text: result.data.data.text,
        author: "@" + author.username,
        sourceAt: Date.parse(result.data.data.created_at),
        sourceKey: "x:" + result.data.data.id,
        sourceUrl: `https://x.com/${author.username}/status/${result.data.data.id}`,
      };
    },
    async search(
      query: string,
      cursor: { sinceId?: string; nextToken?: string },
    ) {
      const p = new URLSearchParams({
        query,
        max_results: "10",
        expansions: "author_id",
        "tweet.fields": "author_id,created_at,entities,referenced_tweets",
        "user.fields": "username",
        ...(cursor.sinceId ? { since_id: cursor.sinceId } : {}),
        ...(cursor.nextToken ? { next_token: cursor.nextToken } : {}),
      });
      const parsed = page.safeParse(await get("tweets/search/recent?" + p));
      if (
        !parsed.success ||
        parsed.data.errors?.length ||
        (!parsed.data.data && parsed.data.meta.result_count !== 0)
      )
        throw new XApiError("provider");
      const authors = new Map(
        parsed.data.includes?.users.map((u) => [u.id, u.username]),
      );
      return {
        nextToken: parsed.data.meta.next_token,
        newestId: parsed.data.meta.newest_id,
        posts: (parsed.data.data || [])
          .filter(
            (p) =>
              p.author_id !== config.userId &&
              !p.referenced_tweets?.some((r) => r.type === "retweeted"),
          )
          .map((p) => {
            const author = authors.get(p.author_id);
            if (!author) throw new XApiError("provider");
            return {
              id: p.id,
              text: p.text,
              author,
              sourceAt: Date.parse(p.created_at),
              sourceUrl: `https://x.com/${author}/status/${p.id}`,
            };
          }),
      };
    },
    async verify(
      url: string,
      sourceId: string,
      text: string,
      link: string,
      sourceAuthor?: string,
    ) {
      const m = url.match(
        /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)$/,
      );
      if (!m || m[1].toLowerCase() !== config.username.toLowerCase())
        throw new Error("Publication author or URL rejected");
      const result = z
        .object({ data: post, errors: z.array(z.unknown()).optional() })
        .safeParse(
          await get(
            `tweets/${m[2]}?tweet.fields=author_id,created_at,entities,referenced_tweets`,
          ),
        );
      if (!result.success || result.data.errors?.length)
        throw new XApiError("provider");
      const p = result.data.data;
      const expanded = p.entities?.urls || [];
      const expandedText = expanded.reduce(
        (s, u) => s.split(u.url).join(u.expanded_url),
        p.text,
      );
      // Native X replies add the recipient to API text but hide it in the
      // displayed body. Remove only the provider-described leading mention of
      // this saved source author; every character of the reviewed body remains
      // subject to the existing exact comparison.
      const recipient = p.entities?.mentions?.find((m) => m.start === 0);
      const prefix = recipient && "@" + recipient.username;
      const replyBody =
        expandedText.trim() !== text.trim() &&
        prefix &&
        sourceAuthor?.toLowerCase() === prefix.toLowerCase() &&
        recipient?.end === prefix.length &&
        expandedText.slice(0, prefix.length).toLowerCase() ===
          prefix.toLowerCase() &&
        /\s/.test(expandedText[prefix.length] || "")
          ? expandedText.slice(prefix.length).trim()
          : expandedText.trim();
      if (
        p.author_id !== config.userId ||
        !p.referenced_tweets?.some(
          (r) => r.type === "replied_to" && r.id === sourceId,
        ) ||
        replyBody !== text.trim() ||
        !expanded.some((u) => u.expanded_url === link)
      )
        throw new Error(
          "Publication author, thread, exact content or campaign destination mismatch",
        );
      return "Official X read: brand author, original reply thread, complete approved body and expanded campaign destination matched; native recipient mention checked separately";
    },
  };
}
