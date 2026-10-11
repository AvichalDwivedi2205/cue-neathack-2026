import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { socialSource } from "./social-source";

export type ReceivedEmail = {
  id: string;
  from: string;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  message_id?: string | null;
  headers?: Record<string, string> | null;
};
type Report = {
  channel: "email" | "x" | "reddit";
  sourceKey: string;
  eventKey: string;
  externalId: string;
  customer: string;
  title: string;
  body: string;
  sourceUrl?: string;
  messageKey?: string;
  references?: string[];
  transport?: "notification_email";
};
type Node = DefaultTreeAdapterMap["node"];
const blocks = new Set(["p", "div", "li", "tr", "td", "article", "br"]);

function hidden(node: Node) {
  return (
    "tagName" in node &&
    (["script", "style", "head", "template"].includes(node.tagName) ||
      node.attrs.some(
        (a) =>
          a.name === "hidden" ||
          (a.name === "aria-hidden" && a.value === "true") ||
          (a.name === "style" && /display\s*:\s*none/i.test(a.value)),
      ))
  );
}
function textOf(root: Node) {
  const stack = [root],
    chunks: string[] = [];
  while (stack.length) {
    const node = stack.pop()!;
    if (hidden(node)) continue;
    if ("value" in node) chunks.push(node.value);
    if ("tagName" in node && blocks.has(node.tagName)) chunks.push("\n");
    if ("childNodes" in node) stack.push(...[...node.childNodes].reverse());
  }
  return chunks
    .join(" ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}
function htmlContent(html: string) {
  const root = parseFragment(html.slice(0, 200000));
  const stack: Node[] = [root],
    links: { url: string; excerpt: string }[] = [];
  while (stack.length) {
    const node = stack.pop()!;
    if (hidden(node)) continue;
    if ("tagName" in node && node.tagName === "a") {
      const href = node.attrs.find((a) => a.name === "href")?.value;
      if (href) {
        let context: Node = node;
        for (
          let parent = node.parentNode;
          parent;
          parent = "parentNode" in parent ? parent.parentNode : null
        ) {
          if (
            "tagName" in parent &&
            ["li", "article", "td"].includes(parent.tagName)
          ) {
            context = parent;
            break;
          }
          if (context === node && "tagName" in parent && parent.tagName === "p")
            context = parent;
        }
        links.push({ url: href, excerpt: textOf(context) });
      }
    }
    if ("childNodes" in node) stack.push(...[...node.childNodes].reverse());
  }
  return { text: textOf(root), links };
}
function platform(sender: string): "x" | "reddit" | undefined {
  const [local, domain] = sender.split("@");
  if (!/^(notify|notification|notifications|noreply|no-reply)$/.test(local))
    return;
  if (["x.com", "twitter.com"].includes(domain)) return "x";
  if (["redditmail.com", "reddit.com"].includes(domain)) return "reddit";
}

// Metadata-only gate: the poller never retrieves bodies of other mail.
export function isSocialNotification(
  mail: Pick<ReceivedEmail, "from" | "subject">,
) {
  const sender = mail.from.match(/<?([^<>\s]+@[^<>\s]+)>?/)?.[1]?.toLowerCase();
  return (
    !!sender &&
    !!platform(sender) &&
    /\b(mentions?|mentioned|repl(?:y|ies|ied)|new notifications|new activity)\b/i.test(
      mail.subject || "",
    )
  );
}

function notificationPermalink(channel: "x" | "reddit", value: string) {
  const wrapper = new URL(value);
  if (channel !== "reddit" || wrapper.hostname !== "click.redditmail.com")
    return value;
  if (
    wrapper.protocol !== "https:" ||
    wrapper.username ||
    wrapper.password ||
    wrapper.port ||
    wrapper.search ||
    wrapper.hash
  )
    throw new Error("Unsupported notification wrapper");
  // Observed Reddit mention email format. Decode its explicit destination once;
  // never follow the tracking URL or resolve an opaque/recursive redirect.
  const match = wrapper.pathname.match(
    /^\/CL0\/(https:%2f%2f[^/]+)\/[12]\/[^/]+\/[^/]+$/i,
  );
  if (!match) throw new Error("Unsupported notification wrapper");
  return decodeURIComponent(match[1]);
}

// The provider authenticates email delivery, not the platform sender or author.
// Only permalinks embedded in the received message are used. No remote URLs fetched.
export function normalizeEmail(
  mail: ReceivedEmail,
  importNotifications = false,
): {
  reports: Report[];
  ignored?: string;
} {
  const sender = mail.from.match(/<?([^<>\s]+@[^<>\s]+)>?/)?.[1]?.toLowerCase();
  if (!sender || sender.length > 100 || !mail.id)
    throw new Error("Email identity unavailable");
  const html = htmlContent(mail.html || "");
  const text = (mail.text || html.text).slice(0, 200000);
  const subject = mail.subject || "Email support request";
  const channel = importNotifications ? platform(sender) : undefined;
  if (!channel) {
    const references = Object.entries(mail.headers || {})
      .filter(([k]) => /^(references|in-reply-to)$/i.test(k))
      .flatMap(([, value]) => value.match(/<[^<>\r\n]{1,500}>/g) || [])
      .slice(-20)
      .map((id) => "rfc822:" + id);
    return {
      reports: [
        {
          channel: "email",
          customer: sender,
          title: subject.slice(0, 200),
          body: (
            text ||
            "This email contains no readable text. Review the original email."
          ).slice(0, 12000),
          sourceKey: "email:" + mail.id,
          eventKey: "email:" + mail.id,
          externalId: mail.id,
          ...(mail.message_id
            ? { messageKey: "rfc822:" + mail.message_id }
            : {}),
          references,
        },
      ],
    };
  }
  if (!isSocialNotification(mail))
    return {
      reports: [],
      ignored: "Platform email is not a mention or reply notification",
    };

  const candidates = [...html.links];
  for (const match of text.matchAll(/https:\/\/[^\s<>"'\[\]]+/g)) {
    const url = match[0].replace(/[).,;!?]+$/, "");
    const at = match.index!;
    const start = text.lastIndexOf("\n\n", at);
    const end = text.indexOf("\n\n", at + match[0].length);
    candidates.push({
      url,
      excerpt: text.slice(
        start < 0 ? Math.max(0, at - 600) : start + 2,
        end < 0 ? Math.min(text.length, at + match[0].length + 300) : end,
      ),
    });
  }
  const sources = new Map<
    string,
    { key: string; url: string; excerpt: string }
  >();
  for (const candidate of candidates) {
    try {
      const source = socialSource(
        channel,
        notificationPermalink(channel, candidate.url),
      );
      if (!sources.has(source.key))
        sources.set(source.key, { ...source, excerpt: candidate.excerpt });
    } catch {
      /* Non-post links and unsupported tracking redirects are not followed. */
    }
  }
  if (!sources.size)
    return {
      reports: [],
      ignored:
        "Notification has no supported direct post permalink; capture it manually",
    };
  if (sources.size > 20)
    return {
      reports: [],
      ignored: "Digest exceeds 20 posts; review the original email",
    };
  const name = channel === "x" ? "X" : "Reddit";
  return {
    reports: [...sources.values()].map((source) => ({
      channel,
      transport: "notification_email",
      sourceKey: source.key,
      eventKey: `email-notification:${mail.id}:${source.key}`,
      externalId: mail.id,
      sourceUrl: source.url,
      customer:
        channel === "x"
          ? `@${new URL(source.url).pathname.split("/")[1]} (unverified)`
          : "Reddit author unverified",
      title: `${name}: ${subject}`.slice(0, 200),
      body: `Imported ${name} notification email. Content and author are unverified; full post was not fetched.\n\n${subject}\n\nNotification excerpt:\n${source.excerpt || "Open the source link to review the report."}\n\nSource: ${source.url}`.slice(
        0,
        12000,
      ),
    })),
  };
}
