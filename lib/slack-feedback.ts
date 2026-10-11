import { z } from "zod";
import type { SlackConfig } from "./integration-config";
import { slackEphemeral } from "./slack";
import { cueLink } from "./slack-messages";
import { roleLabels, slackMember } from "./roles";

const target = z.object({
  team: z.object({ id: z.string() }),
  channel: z.object({ id: z.string() }),
  user: z.object({ id: z.string().regex(/^[UW][A-Z0-9]+$/) }),
  actions: z
    .array(
      z.object({
        action_id: z.enum([
          "cue_approve",
          "cue_reject",
          "cue_spec_approve",
          "cue_spec_reject",
        ]),
      }),
    )
    .length(1),
});

// Called only after a signed Slack interaction is acknowledged and denied.
// Never forward raw exception text or the interaction's response URL.
export async function sendSlackDecisionFeedback(
  input: unknown,
  config: SlackConfig,
  error: unknown,
) {
  const parsed = target.safeParse(input);
  if (!parsed.success) return;
  const p = parsed.data;
  if (p.team.id !== config.teamId || p.channel.id !== config.engineeringChannel)
    return;
  const message = error instanceof Error ? error.message : "";
  const spec = p.actions[0].action_id.startsWith("cue_spec_");
  const member = slackMember(config, p.user.id);
  const action = spec ? "specification" : "deployment";
  const reason =
    message === "Operator not authorized"
      ? `${member ? roleLabels[member.role] + " role" : "Your account"} cannot make this ${action} decision. Ask ${spec ? "Product" : "Engineering"} or the Owner to review it.`
      : /changed|pending specification|already decided|awaiting approval/i.test(
            message,
          )
        ? "This request changed or has already been decided. Open Cue to review the current status."
        : "Cue could not record this decision. Open Cue to check its current status before trying again.";
  const text = `Decision not recorded. ${reason}`;
  const plain = (text: string) => ({ type: "plain_text", text, emoji: false });
  const blocks: unknown[] = [
    { type: "header", text: plain("Decision not recorded") },
    { type: "section", text: plain(reason) },
    {
      type: "context",
      elements: [plain("Only visible to you · Cue approvals")],
    },
  ];
  const url = cueLink(spec ? "features" : "agents");
  if (url)
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: plain("Open Cue"),
          url,
          action_id: "cue_open_cue",
        },
      ],
    });
  return slackEphemeral(config.botToken, p.channel.id, p.user.id, text, blocks);
}
