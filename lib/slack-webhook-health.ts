import { createHash } from "node:crypto";
import { updateIntegrations, type SlackConfig } from "./integration-config";

export function slackWebhookIdentity(config: SlackConfig) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.teamId,
        config.supportChannel,
        config.engineeringChannel,
        config.signingSecret || "",
      ]),
    )
    .digest("hex");
}

export function slackWebhookStatus(config: SlackConfig, now = Date.now()) {
  const verified =
    !!config.signingSecret &&
    config.webhookIdentity === slackWebhookIdentity(config) &&
    typeof config.webhookLastEventAt === "number" &&
    config.webhookLastEventAt <= now;
  const recent = verified && now - config.webhookLastEventAt! < 86400000;
  return {
    connected: recent,
    detail: !verified
      ? "HTTPS configured · awaiting a verified Slack event"
      : recent
        ? "HTTPS verified · Slack event received within the last 24 hours"
        : "HTTPS configured · no Slack event in the last 24 hours",
    updatedAt: verified ? config.webhookLastEventAt! : null,
  };
}

// Only call after a signed event has passed workspace/channel validation and
// been persisted. A changed credential cannot inherit another connection's proof.
export async function recordSlackWebhook(config: SlackConfig) {
  const identity = slackWebhookIdentity(config);
  await updateIntegrations((current) => {
    if (
      current.slack?.deliveryMode !== "webhook" ||
      slackWebhookIdentity(current.slack) !== identity
    )
      return current;
    return {
      ...current,
      slack: {
        ...current.slack,
        webhookIdentity: identity,
        webhookLastEventAt: Date.now(),
      },
    };
  });
}
