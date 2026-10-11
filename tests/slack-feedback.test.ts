import { afterEach, expect, test, vi } from "vitest";
import { sendSlackDecisionFeedback } from "../lib/slack-feedback";
import type { SlackConfig } from "../lib/integration-config";
const config: SlackConfig = {
  botToken: "bot-test",
  teamId: "TTEAM",
  supportChannel: "CSUPPORT",
  engineeringChannel: "CENGINEERING",
  operatorIds: [],
  members: [
    {
      name: "Aria",
      email: "aria@example.com",
      role: "support",
      slackId: "UARIA",
    },
  ],
};
const payload = {
  team: { id: config.teamId },
  channel: { id: config.engineeringChannel },
  user: { id: "UARIA" },
  actions: [{ action_id: "cue_spec_approve" }],
  response_url: "https://untrusted.invalid/do-not-follow",
};
afterEach(() => vi.unstubAllGlobals());
test("denial reaches only the clicked user with a clear role explanation", async () => {
  const provider = vi
    .fn()
    .mockResolvedValue(Response.json({ ok: true, message_ts: "1.2" }));
  vi.stubGlobal("fetch", provider);
  await sendSlackDecisionFeedback(
    payload,
    config,
    new Error("Operator not authorized"),
  );
  const [url, options] = provider.mock.calls[0];
  expect(url).toBe("https://slack.com/api/chat.postEphemeral");
  const sent = JSON.parse(options.body);
  expect(sent).toMatchObject({ channel: "CENGINEERING", user: "UARIA" });
  expect(sent.text).toContain("Support role cannot");
  expect(sent.text).toContain("Product or the Owner");
  expect(sent.text).not.toContain("bot-test");
  expect(JSON.stringify(sent)).not.toContain("untrusted.invalid");
  expect(sent.blocks[1].text.type).toBe("plain_text");
});
test.each([
  { ...payload, team: { id: "TOTHER" } },
  { ...payload, channel: { id: "COTHER" } },
  { ...payload, user: { id: "<!channel>" } },
  { ...payload, actions: [{ action_id: "unexpected" }] },
])(
  "untrusted routing or unsupported actions cannot publish feedback",
  async (input) => {
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);
    await sendSlackDecisionFeedback(
      input,
      config,
      new Error("Operator not authorized"),
    );
    expect(provider).not.toHaveBeenCalled();
  },
);
test.each([
  [
    "Specification changed; refresh the approval request",
    "changed or has already",
  ],
  ["No pending specification", "changed or has already"],
  ["internal-token-do-not-leak <!channel>", "could not record"],
])(
  "stale or failed decisions explain recovery without disclosing exceptions",
  async (error, phrase) => {
    const provider = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", provider);
    await sendSlackDecisionFeedback(payload, config, new Error(error));
    const sent = JSON.parse(provider.mock.calls[0][1].body);
    expect(sent.text).toContain(phrase);
    expect(JSON.stringify(sent)).not.toContain("internal-token-do-not-leak");
    expect(JSON.stringify(sent)).not.toContain("<!channel>");
  },
);
