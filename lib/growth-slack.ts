import { z } from "zod";
import { api, db, secret } from "./server-store";
import { slackConfig } from "./integration-config";
import { slackMember, reviewers } from "./roles";
import { slackPost, slackUpdate } from "./slack";
import { observedRelease } from "./growth";
import type { Id } from "../convex/_generated/dataModel";
export async function sendGrowthReview(
  appId: string,
  draftId: Id<"growthDrafts">,
) {
  const config = await slackConfig();
  if (!config)
    throw new Error(
      "Slack review connection unavailable; review remains pending in Cue",
    );
  const saved = await db().query(api.growth.snapshot, {
    secret: secret(),
    appId,
  });
  const d = saved.drafts.find((d) => d._id === draftId),
    o = d && saved.opportunities.find((o) => o._id === d.opportunityId),
    cap = d && saved.capabilities.find((c) => c._id === d.capabilityId);
  if (!d || !o || !cap) throw new Error("Exact review context missing");
  const url =
    (process.env.CUE_PUBLIC_URL || "https://cue.latchgrid.in") +
    "/cue#/growth/" +
    o._id;
  const text = `Growth review · ${reviewers(config, "spec")
    .map((id) => "<@" + id + ">")
    .join(
      " ",
    )}\nInquiry: ${o.text}\nFit: ${o.fit} · ${o.reasons.join("; ")}\nSupported: ${cap.claims.join("; ")}\nRelease: ${cap.release}\nExact draft v${d.version}: ${d.text}\nHash: ${d.hash}\nApproval saves review only. Owner publishes manually.\n${url}`;
  const value = JSON.stringify({ appId, draftId, hash: d.hash });
  const ledger = await db().mutation(api.deliveries.reserve, {
    secret: secret(),
    key: "growth-review:" + draftId,
    channel: "slack",
    destination: config.engineeringChannel,
    body: text,
    actor: "Growth",
  });
  try {
    const result = await slackPost(
      config.botToken,
      config.engineeringChannel,
      text,
      [
        {
          type: "section",
          text: { type: "plain_text", text: text.slice(0, 2900) },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Approve exact draft" },
              action_id: "cue_growth_approve",
              value,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Request changes" },
              action_id: "cue_growth_reject",
              value,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Open in Cue" },
              url,
              action_id: "cue_open_cue",
            },
          ],
        },
      ],
    );
    await db().mutation(api.deliveries.finish, {
      secret: secret(),
      id: ledger,
      status: "sent",
      receipt: result.channel + ":" + result.ts,
    });
    return { state: "sent", receipt: result.channel + ":" + result.ts };
  } catch {
    await db().mutation(api.deliveries.finish, {
      secret: secret(),
      id: ledger,
      status: "unknown",
      receipt: "Provider outcome uncertain; reconcile before resending",
    });
    throw new Error(
      "Slack delivery outcome uncertain; review remains pending in Cue",
    );
  }
}
export async function decideGrowthSlack(input: unknown) {
  const p = z
    .object({
      team: z.object({ id: z.string() }),
      channel: z.object({ id: z.string() }),
      user: z.object({ id: z.string() }),
      message: z.object({ ts: z.string() }).optional(),
      actions: z
        .array(
          z.object({
            action_id: z.enum(["cue_growth_approve", "cue_growth_reject"]),
            value: z.string(),
          }),
        )
        .length(1),
    })
    .parse(input);
  const config = await slackConfig();
  const member = config && slackMember(config, p.user.id);
  if (
    !config ||
    p.team.id !== config.teamId ||
    p.channel.id !== config.engineeringChannel ||
    !member ||
    !["owner", "product"].includes(member.role) ||
    !("email" in member)
  )
    throw new Error("Saved Product membership required");
  const value = z
    .object({
      appId: z.string(),
      draftId: z.string(),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(JSON.parse(p.actions[0].value));
  const { release } = await observedRelease(value.appId);
  await db().mutation(api.growth.decide, {
    secret: secret(),
    actor: { id: member.email, name: member.name, role: member.role },
    ...value,
    draftId: value.draftId as Id<"growthDrafts">,
    release,
    approve: p.actions[0].action_id === "cue_growth_approve",
  });
  if (p.message?.ts)
    await slackUpdate(
      config.botToken,
      p.channel.id,
      p.message.ts,
      `Growth exact draft ${value.hash} ${p.actions[0].action_id === "cue_growth_approve" ? "approved" : "changes requested"} by ${member.name}. Publication still requires Owner action.`,
      [],
    ).catch(() => {});
}
