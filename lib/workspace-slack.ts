import { z } from "zod";
import { api, db, secret } from "./server-store";
import { slackMember } from "./roles";
import { postWorkspace, workspaceApp } from "./workspace";
import { slackPost } from "./slack";
import type { SlackConfig } from "./integration-config";
import { growthOutcomeSummary } from "./growth-outcomes";
const payload = z.object({
  team_id: z.string(),
  event: z.object({
    type: z.string(),
    channel: z.string().optional(),
    user: z.string().optional(),
    text: z.string().optional(),
    ts: z.string().optional(),
    thread_ts: z.string().optional(),
    bot_id: z.string().optional(),
    subtype: z.string().optional(),
  }),
});
export async function receiveWorkspaceSlack(
  input: unknown,
  config: SlackConfig,
) {
  const p = payload.parse(input),
    e = p.event;
  if (
    p.team_id !== config.teamId ||
    ![config.supportChannel, config.engineeringChannel].includes(
      e.channel || "",
    ) ||
    !["message", "app_mention"].includes(e.type) ||
    e.bot_id ||
    e.subtype ||
    !e.user ||
    !e.ts ||
    !e.text
  )
    return false;
  const text = e.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  const addressed = text.match(/^(x|reddit|growth|engineering)\s+(.+)$/is);
  const threadKey = `${p.team_id}:${e.channel}:${e.thread_ts || e.ts}`;
  const mapping = e.thread_ts
    ? await db().query(api.workspace.thread, {
        secret: secret(),
        key: threadKey,
      })
    : null;
  if ((!addressed || e.type !== "app_mention") && !mapping) return false;
  // An agent address selects a role, never grants sender authority.
  const member = slackMember(config, e.user);
  if (!member) return true;
  const app = mapping
    ? (await workspaceApp(mapping.appId)).app
    : (await workspaceApp()).app;
  const agent = (addressed?.[1].toLowerCase() || mapping!.agent) as
    | "x"
    | "reddit"
    | "growth"
    | "engineering";
  const result = await postWorkspace(
    {
      agent,
      appId: app.id,
      text: addressed?.[2] || text,
      key: `slack-agent:${p.team_id}:${e.channel}:${e.ts}`,
      ...(mapping?.taskId && mapping.agent === agent
        ? { taskId: mapping.taskId }
        : {}),
    },
    {
      id: "email" in member ? member.email : `slack:${e.user}`,
      name: member.name,
      role: member.role,
    },
    `Slack · ${e.channel}`,
    threadKey,
  );
  if (result.duplicate) return true;
  let outcomes = "";
  if (agent === "growth" && result.taskId) {
    try {
      const workspace = await db().query(api.workspace.snapshot, {
        secret: secret(),
        appId: app.id,
        participant: "email" in member ? member.email : `slack:${e.user}`,
      });
      const task = workspace.tasks.find((t) => t._id === result.taskId);
      if (task?.opportunityId) {
        const growth = await db().query(api.growth.snapshot, {
          secret: secret(),
          appId: app.id,
        });
        outcomes =
          "\n" +
          growthOutcomeSummary(
            growth.touches.filter(
              (t) => t.opportunityId === task.opportunityId,
            ),
            growth.browsers,
          );
      }
    } catch {
      outcomes = "\nProduct outcomes unavailable; open saved Growth context.";
    }
  }
  const body = `${agent[0].toUpperCase() + agent.slice(1)} · ${result.response.replaceAll("#/", (process.env.CUE_PUBLIC_URL || "https://cue.latchgrid.in") + "/cue#/")}${outcomes}`;
  const id = await db().mutation(api.deliveries.reserve, {
    secret: secret(),
    key: `agent-reply:${p.team_id}:${e.channel}:${e.ts}`,
    channel: "slack",
    destination: e.channel!,
    body,
    actor: "Cue coordinator",
  });
  try {
    const receipt = await slackPost(
      config.botToken,
      e.channel!,
      body,
      undefined,
      e.thread_ts || e.ts,
    );
    await db().mutation(api.deliveries.finish, {
      secret: secret(),
      id,
      status: "sent",
      receipt: `${receipt.channel}:${receipt.ts}`,
    });
  } catch {
    await db().mutation(api.deliveries.finish, {
      secret: secret(),
      id,
      status: "unknown",
      receipt: "Provider outcome uncertain. Reconcile before retrying.",
    });
  }
  return true;
}
