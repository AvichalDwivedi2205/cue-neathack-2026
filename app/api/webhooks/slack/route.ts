import { validSlack } from "@/lib/slack";
import { slackConfig } from "@/lib/integration-config";
import { receiveSlack, decideSlack } from "@/lib/slack-events";
import { sendSlackDecision } from "@/lib/delivery";
import { sendSlackDecisionFeedback } from "@/lib/slack-feedback";
import { triage } from "@/lib/triage";
import { recordSlackWebhook } from "@/lib/slack-webhook-health";
import { decideGrowthSlack } from "@/lib/growth-slack";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const raw = await request.text();
  const config = await slackConfig();
  if (
    !validSlack(
      raw,
      request.headers.get("x-slack-request-timestamp"),
      request.headers.get("x-slack-signature"),
      config?.signingSecret,
    )
  )
    return Response.json({ error: "Invalid Slack signature" }, { status: 401 });
  try {
    if (
      request.headers
        .get("content-type")
        ?.includes("application/x-www-form-urlencoded")
    ) {
      const p = JSON.parse(new URLSearchParams(raw).get("payload") || "{}");
      if (
        p.actions?.some((a: { action_id: string }) =>
          a.action_id.startsWith("cue_growth_"),
        )
      ) {
        try {
          await decideGrowthSlack(p);
          return Response.json({
            text: "Exact Growth decision recorded. Publication remains manual.",
          });
        } catch (error) {
          after(async () => {
            await sendSlackDecisionFeedback(p, config!, error).catch(() => {});
          });
          return Response.json({ ok: true });
        }
      }
      if (!config) throw new Error("Slack not configured");
      if (
        p.actions?.every((a: { action_id: string }) =>
          ["cue_open_cue", "cue_open_pr"].includes(a.action_id),
        )
      )
        return Response.json({ ok: true });
      let decision;
      try {
        decision = await decideSlack(p, config);
      } catch (error) {
        after(async () => {
          await sendSlackDecisionFeedback(p, config, error).catch(() => {});
        });
        return Response.json({ ok: true });
      }
      if (decision)
        after(async () => {
          await sendSlackDecision(decision, p.message?.ts).catch(() => {});
        });
      return Response.json({
        text: "Decision recorded for this exact version.",
      });
    }
    const body = JSON.parse(raw);
    if (body.type === "url_verification")
      return Response.json({ challenge: body.challenge });
    if (!config) throw new Error("Slack not configured");
    const result = await receiveSlack(body, config, false);
    if (result)
      after(async () => {
        await recordSlackWebhook(config).catch(() => {});
        if (!result.duplicate) await triage(result.caseId).catch(() => {});
      });
    return Response.json({ ok: true });
  } catch {
    return Response.json(
      { error: "Slack event could not be recorded" },
      { status: 400 },
    );
  }
}
import { after } from "next/server";
