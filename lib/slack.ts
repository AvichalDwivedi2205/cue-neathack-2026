import { createHmac, timingSafeEqual } from "node:crypto";
export function validSlack(
  body: string,
  timestamp: string | null,
  signature: string | null,
  signingSecret = process.env.SLACK_SIGNING_SECRET,
) {
  if (
    !signingSecret ||
    !timestamp ||
    !signature ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
  )
    return false;
  const expected =
    "v0=" +
    createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex");
  return (
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
}
export async function slackPost(
  token: string,
  channel: string,
  text: string,
  blocks?: unknown[],
  threadTs?: string,
) {
  return post("chat.postMessage", token, {
    channel,
    text,
    blocks,
    thread_ts: threadTs,
    unfurl_links: false,
    unfurl_media: false,
    mrkdwn: false,
  });
}
export async function slackEphemeral(
  token: string,
  channel: string,
  user: string,
  text: string,
  blocks: unknown[],
) {
  return post("chat.postEphemeral", token, { channel, user, text, blocks });
}
export async function slackUpdate(
  token: string,
  channel: string,
  ts: string,
  text: string,
  blocks: unknown[],
) {
  return post("chat.update", token, {
    channel,
    ts,
    text,
    blocks,
    mrkdwn: false,
  });
}
async function post(
  method: "chat.postMessage" | "chat.postEphemeral" | "chat.update",
  token: string,
  body: Record<string, unknown>,
) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const result = await r.json();
  if (!r.ok || !result.ok)
    throw new Error(
      "Slack: " +
        (result.error || "request failed") +
        (result.response_metadata?.messages?.length
          ? " · " + result.response_metadata.messages.join("; ")
          : ""),
    );
  return result;
}
