import { expect, test, vi } from "vitest";
import type { SlackConfig } from "../lib/integration-config";
vi.mock("../lib/integration-config", () => ({ updateIntegrations: vi.fn() }));
import {
  slackWebhookIdentity,
  slackWebhookStatus,
} from "../lib/slack-webhook-health";

const config: SlackConfig = {
  botToken: "xoxb-test",
  signingSecret: "a".repeat(32),
  teamId: "TTEST",
  supportChannel: "CSUPPORT",
  engineeringChannel: "CENGINEERING",
  operatorIds: ["UOWNER"],
  deliveryMode: "webhook",
};
test("configured credentials alone do not establish successful HTTPS delivery", () => {
  expect(slackWebhookStatus(config).connected).toBe(false);
});
test("recent recorded Slack delivery is distinguished from stale or future evidence", () => {
  const received = {
    ...config,
    webhookLastEventAt: 1000,
    webhookIdentity: slackWebhookIdentity(config),
  };
  expect(slackWebhookStatus(received, 2000).connected).toBe(true);
  expect(slackWebhookStatus(received, 999).connected).toBe(false);
  expect(slackWebhookStatus(received, 86402000).connected).toBe(false);
});
test.each([
  { teamId: "TOTHER" },
  { supportChannel: "COTHER" },
  { signingSecret: "b".repeat(32) },
  { signingSecret: undefined },
])("changed connection cannot inherit old verification: %s", (change) => {
  expect(
    slackWebhookStatus(
      {
        ...config,
        ...change,
        webhookLastEventAt: 1000,
        webhookIdentity: slackWebhookIdentity(config),
      },
      2000,
    ).connected,
  ).toBe(false);
});
