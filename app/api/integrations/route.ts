import { z } from "zod";
import { randomBytes } from "node:crypto";
import { Resend } from "resend";
import { operator, sameOrigin } from "@/lib/access";
import { membersInput, requirePermission } from "@/lib/roles";
import {
  appInput,
  slackInput,
  emailInput,
  readIntegrations,
  updateIntegrations,
  slackConfig,
  emailConfig,
  emailConfigForSave,
  codingInput,
  xInput,
  xConfigForSave,
} from "@/lib/integration-config";
import {
  checkSlack,
  checkEmail,
  checkCodex,
  slackRuntimeStatus,
  notificationRuntimeStatus,
  xRuntimeStatus,
} from "@/lib/integration-checks";
import { createXApi } from "@/lib/x-api";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await operator(request);
    requirePermission(actor, "manage");
    const config = await readIntegrations(),
      slack = await slackConfig(),
      email = await emailConfig();
    return Response.json(
      {
        apps: config.apps,
        coding: config.coding || [],
        x: {
          configured: !!config.x,
          enabled: !!config.x?.enabled,
          username: config.x?.username,
          userId: config.x?.userId,
          ...(await xRuntimeStatus()),
        },
        ownerEmail: process.env.CUE_OPERATOR_EMAIL,
        slack: slack
          ? {
              configured: true,
              teamId: slack.teamId,
              supportChannel: slack.supportChannel,
              engineeringChannel: slack.engineeringChannel,
              operatorIds: slack.operatorIds,
              members: slack.members || [],
              workspace: slack.workspace,
              deliveryMode: slack.deliveryMode || "socket",
              socket: !!slack.appToken,
              signedWebhook: !!slack.signingSecret,
              ...(await slackRuntimeStatus()),
            }
          : { configured: false, connected: false },
        email: email
          ? {
              configured: true,
              from: email.from,
              replyTo: email.replyTo,
              inbound: !!email.webhookSecret,
              notificationImport: !!email.notificationImport,
              pollReceiving: !!email.pollReceiving,
              receivingAddress: email.receivingAddress,
              supportReceivingAddress: email.supportReceivingAddress,
              notifications: await notificationRuntimeStatus(),
            }
          : { configured: false },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Operator access required" },
      { status: 401 },
    );
  }
}
export async function POST(request: Request) {
  let actor;
  try {
    sameOrigin(request);
    actor = await operator(request);
    requirePermission(actor, "manage");
  } catch {
    return Response.json(
      { error: "Operator access required" },
      { status: 401 },
    );
  }
  try {
    const b = await request.json();
    if (b.action === "x") {
      const old = (await readIntegrations()).x;
      const input = xInput.parse({
        ...b,
        bearerToken: b.bearerToken || old?.bearerToken,
      });
      const config = xConfigForSave(input, old);
      if (config.enabled) {
        const provider = createXApi(config);
        await provider.credits();
        await provider.verifyBrand();
      }
      await updateIntegrations((c) => ({ ...c, x: config }));
      return Response.json({
        ok: true,
        message: config.enabled
          ? "X credentials verified. Cue’s connected collector imports new mentions. Public replies remain drafts."
          : "X API credentials saved; collection paused.",
      });
    }
    if (b.action === "coding") {
      const target = codingInput.parse(b);
      const current = await readIntegrations();
      if (
        target.appId !== "bloom" &&
        !current.apps.some((a) => a.id === target.appId)
      )
        throw new Error("Register this app before connecting its repository");
      await updateIntegrations((c) => ({
        ...c,
        coding: [
          ...(c.coding || []).filter((t) => t.appId !== target.appId),
          target,
        ],
      }));
      return Response.json({
        ok: true,
        message:
          "Repository policy saved. Approved specifications can be implemented in isolated checkouts. Changes require Engineering review; deployment uses your repository's release process.",
      });
    }
    if (b.action === "team") {
      const members = membersInput.parse(b.members);
      if (
        !members.some(
          (m) =>
            m.email === process.env.CUE_OPERATOR_EMAIL?.toLowerCase() &&
            m.role === "owner" &&
            m.slackId,
        )
      )
        throw new Error(
          "Keep the configured owner and Slack member ID in the team",
        );
      if (
        members.some(
          (m) =>
            m.role === "owner" &&
            m.email !== process.env.CUE_OPERATOR_EMAIL?.toLowerCase(),
        )
      )
        throw new Error("Only the configured account can hold the owner role");
      await updateIntegrations((c) => {
        if (!c.slack)
          throw new Error("Connect Slack before assigning team roles");
        return { ...c, slack: { ...c.slack, members } };
      });
      return Response.json({
        ok: true,
        message:
          "Team roles saved. Members without Slack IDs cannot approve in Slack.",
      });
    }
    if (b.action === "app") {
      const input = appInput.parse(b),
        app = {
          ...input,
          origins: [...new Set(input.origins)],
          id: "cue_app_" + randomBytes(12).toString("hex"),
          createdAt: Date.now(),
        };
      await updateIntegrations((c) => {
        if (c.apps.length >= 20) throw new Error("Connected app limit reached");
        return { ...c, apps: [...c.apps, app] };
      });
      return Response.json({ app });
    }
    if (b.action === "slack") {
      const old = await slackConfig();
      const config = slackInput.parse({
        ...b,
        botToken: b.botToken || old?.botToken,
        appToken: b.appToken || old?.appToken,
        signingSecret: b.signingSecret || old?.signingSecret,
        members: old?.members,
        deliveryMode: b.deliveryMode || old?.deliveryMode,
      });
      const result = await checkSlack(config);
      await updateIntegrations((c) => ({
        ...c,
        slack: {
          ...config,
          workspace: result.workspace,
          webhookLastEventAt: old?.webhookLastEventAt,
          webhookIdentity: old?.webhookIdentity,
        },
      }));
      return Response.json(result);
    }
    if (b.action === "email") {
      const old = await emailConfig();
      const config = emailInput.parse({
        ...b,
        apiKey: b.apiKey || old?.apiKey,
        webhookSecret: b.webhookSecret || old?.webhookSecret,
        replyTo: b.replyTo || undefined,
        receivingAddress: b.receivingAddress || undefined,
        supportReceivingAddress: b.supportReceivingAddress || undefined,
      });
      const result = await checkEmail(config);
      await updateIntegrations((c) => ({
        ...c,
        email: emailConfigForSave(config, old),
      }));
      return Response.json(result);
    }
    if (b.action === "check" && b.target === "codex")
      return Response.json(await checkCodex());
    if (b.action === "check" && b.target === "slack") {
      const config = await slackConfig();
      if (!config) throw new Error("Connect Slack first");
      return Response.json({
        ...(await checkSlack(config)),
        ...(await slackRuntimeStatus()),
      });
    }
    if (b.action === "check" && b.target === "email") {
      const config = await emailConfig();
      if (!config) throw new Error("Connect email first");
      return Response.json(await checkEmail(config));
    }
    if (b.action === "email-test") {
      const config = await emailConfig();
      if (!config) throw new Error("Connect email first");
      if (!(await checkEmail(config)).ok)
        throw new Error("Verify sender domain first");
      const result = await new Resend(config.apiKey).emails.send({
        from: config.from,
        to: z.email().parse(actor.email),
        subject: "Cue email connection test",
        text: "Cue's email sender is connected. This test confirms Resend accepted the message. Reply handling needs the receiving webhook configured separately.",
        replyTo: config.replyTo,
      });
      if (result.error || !result.data)
        throw new Error(result.error?.message || "Test email was not accepted");
      return Response.json({
        ok: true,
        receipt: result.data.id,
        recipient: actor.email,
        message:
          "Provider accepted test. Check your inbox to confirm delivery.",
      });
    }
    throw new Error("Unknown setup action");
  } catch (e) {
    return Response.json(
      {
        error:
          e instanceof z.ZodError
            ? e.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; ")
            : e instanceof Error
              ? e.message
              : "Setup failed",
      },
      { status: 400 },
    );
  }
}
