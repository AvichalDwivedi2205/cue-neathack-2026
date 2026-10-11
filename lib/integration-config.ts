import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import { api, db, secret } from "./server-store";
import { membersInput } from "./roles";

const originSchema = z
  .string()
  .url()
  .transform((value, ctx) => {
    const url = new URL(value);
    if (
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Use an HTTPS origin, or HTTP localhost, without a path",
      });
      return z.NEVER;
    }
    return url.origin;
  });
export const appInput = z.object({
  name: z.string().trim().min(1).max(60),
  origins: z.array(originSchema).min(1).max(20),
});
export const codingInput = z.object({
  appId: z.string().min(1).max(100),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  baseBranch: z
    .string()
    .regex(/^[\w./-]+$/)
    .refine((v) => !v.includes("..") && !v.startsWith("-")),
  allowedPaths: z
    .array(
      z
        .string()
        .min(1)
        .max(200)
        .refine(
          (p) =>
            !p.startsWith("/") &&
            !p.includes("..") &&
            !p.includes("\\") &&
            !p.startsWith(".") &&
            !p.includes("node_modules"),
        ),
    )
    .min(1)
    .max(30),
  testCommands: z
    .array(
      z.object({
        program: z.enum(["node", "npm"]),
        args: z.array(z.string().min(1).max(200)).min(1).max(10),
      }),
    )
    .min(1)
    .max(6),
});
export type CodingConfig = z.infer<typeof codingInput>;
export const slackInput = z.object({
  deliveryMode: z.enum(["socket", "webhook"]).optional(),
  botToken: z.string().regex(/^xoxb-[A-Za-z0-9-]+$/),
  appToken: z
    .string()
    .regex(/^xapp-[A-Za-z0-9-]+$/)
    .optional(),
  signingSecret: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  teamId: z.string().regex(/^T[A-Z0-9]+$/),
  supportChannel: z.string().regex(/^[CG][A-Z0-9]+$/),
  engineeringChannel: z.string().regex(/^[CG][A-Z0-9]+$/),
  operatorIds: z
    .array(z.string().regex(/^[UW][A-Z0-9]+$/))
    .min(1)
    .max(20),
  workspace: z.string().max(100).optional(),
  members: membersInput.optional(),
});
export const emailInput = z
  .object({
    apiKey: z.string().regex(/^re_[A-Za-z0-9_]+$/),
    from: z.email().max(200),
    webhookSecret: z
      .string()
      .regex(/^whsec_[A-Za-z0-9+/=_-]+$/)
      .optional(),
    replyTo: z.email().max(200).optional(),
    notificationImport: z.boolean().optional(),
    pollReceiving: z.boolean().optional(),
    receivingAddress: z.email().max(200).optional(),
    supportReceivingAddress: z.email().max(200).optional(),
  })
  .superRefine((config, ctx) => {
    if (
      config.pollReceiving &&
      !(
        config.supportReceivingAddress ||
        (config.receivingAddress && config.notificationImport)
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["pollReceiving"],
        message:
          "Set a support address or enable notification import with a dedicated address before polling",
      });
    if (
      config.supportReceivingAddress &&
      config.supportReceivingAddress.toLowerCase() ===
        config.receivingAddress?.toLowerCase()
    )
      ctx.addIssue({
        code: "custom",
        path: ["supportReceivingAddress"],
        message: "Support and notification addresses must be different",
      });
  });
export type WidgetApp = z.infer<typeof appInput> & {
  id: string;
  createdAt: number;
};
export type SlackConfig = z.infer<typeof slackInput> & {
  webhookLastEventAt?: number;
  webhookIdentity?: string;
};
export type EmailConfig = z.infer<typeof emailInput> & {
  pollStartedAt?: number;
  supportPollStartedAt?: number;
};
export const xInput = z.object({
  bearerToken: z
    .string()
    .min(20)
    .max(3000)
    .regex(/^[A-Za-z0-9%._~+\/-]+$/),
  userId: z.string().regex(/^\d{1,30}$/),
  username: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  enabled: z.boolean(),
});
export type XConfig = z.infer<typeof xInput> & { startedAt: number };
export function xConfigForSave(
  input: z.infer<typeof xInput>,
  old?: XConfig,
  now = Date.now(),
): XConfig {
  const sameBrand =
    old?.userId === input.userId &&
    old.username.toLowerCase() === input.username.toLowerCase();
  return {
    ...input,
    startedAt:
      sameBrand && old.startedAt > 0 ? old.startedAt : input.enabled ? now : 0,
  };
}
export function emailConfigForSave(
  input: z.infer<typeof emailInput>,
  old?: EmailConfig,
  now = Date.now(),
): EmailConfig {
  return {
    ...input,
    ...(input.pollReceiving
      ? {
          pollStartedAt:
            old?.pollReceiving &&
            old.apiKey === input.apiKey &&
            old.receivingAddress?.toLowerCase() ===
              input.receivingAddress?.toLowerCase()
              ? (old.pollStartedAt ?? now)
              : now,
          ...(input.supportReceivingAddress
            ? {
                supportPollStartedAt:
                  old?.pollReceiving &&
                  old.apiKey === input.apiKey &&
                  old.supportReceivingAddress?.toLowerCase() ===
                    input.supportReceivingAddress.toLowerCase()
                    ? (old.supportPollStartedAt ?? now)
                    : now,
              }
            : {}),
        }
      : {}),
  };
}
export type IntegrationConfig = {
  apps: WidgetApp[];
  slack?: SlackConfig;
  email?: EmailConfig;
  coding?: CodingConfig[];
  x?: XConfig;
};
const file = () => path.join(process.cwd(), ".cue", "integrations.enc");
const key = () =>
  createHash("sha256")
    .update("cue-integrations:" + secret())
    .digest();
let writes = Promise.resolve();

function decrypt(content: string): IntegrationConfig {
  const [iv, tag, data] = content.split(".");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(data, "base64")),
      decipher.final(),
    ]).toString(),
  );
}
function encrypt(config: IntegrationConfig) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(config)),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((b) => b.toString("base64"))
    .join(".");
}

export async function readIntegrations(): Promise<IntegrationConfig> {
  if (process.env.CUE_SHARED_CONFIG === "true") {
    const state = await db().query(api.serverState.read, {
      secret: secret(),
      key: "integrations",
    });
    return state ? decrypt(state.value) : { apps: [] };
  }
  let content: string;
  try {
    content = await fs.readFile(file(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { apps: [] };
    throw e;
  }
  return decrypt(content);
}
export async function updateIntegrations(
  update: (current: IntegrationConfig) => IntegrationConfig,
) {
  const operation = writes.then(async () => {
    if (process.env.CUE_SHARED_CONFIG === "true") {
      const store = db(),
        auth = secret();
      for (let attempt = 0; attempt < 8; attempt++) {
        const old = await store.query(api.serverState.read, {
          secret: auth,
          key: "integrations",
        });
        const config = update(old ? decrypt(old.value) : { apps: [] });
        if (
          await store.mutation(api.serverState.write, {
            secret: auth,
            key: "integrations",
            value: encrypt(config),
            expectedVersion: old?.version ?? 0,
          })
        )
          return config;
      }
      throw new Error("Configuration changed concurrently. Try again.");
    }
    const config = update(await readIntegrations());
    const content = encrypt(config);
    await fs.mkdir(path.dirname(file()), { recursive: true });
    const temp = file() + "." + randomBytes(6).toString("hex");
    await fs.writeFile(temp, content, { mode: 0o600 });
    await fs.rename(temp, file());
    return config;
  });
  writes = operation.then(
    () => {},
    () => {},
  );
  return operation;
}
export async function slackConfig(): Promise<SlackConfig | undefined> {
  const saved = (await readIntegrations()).slack;
  if (saved) return saved;
  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_TEAM_ID)
    return undefined;
  return {
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    teamId: process.env.SLACK_TEAM_ID,
    supportChannel: process.env.SLACK_SUPPORT_CHANNEL_ID || "",
    engineeringChannel: process.env.SLACK_TEAM_CHANNEL_ID || "",
    operatorIds: (process.env.SLACK_OPERATOR_IDS || "")
      .split(",")
      .filter(Boolean),
  };
}
export async function emailConfig(): Promise<EmailConfig | undefined> {
  return (
    (await readIntegrations()).email ||
    (process.env.RESEND_API_KEY && process.env.CUE_EMAIL_FROM
      ? {
          apiKey: process.env.RESEND_API_KEY,
          from: process.env.CUE_EMAIL_FROM,
          webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
          replyTo: process.env.CUE_EMAIL_REPLY_TO,
          notificationImport: process.env.CUE_EMAIL_NOTIFICATIONS === "true",
          pollReceiving: process.env.CUE_EMAIL_POLL === "true",
          receivingAddress: process.env.CUE_EMAIL_POLL_RECIPIENT,
          supportReceivingAddress: process.env.CUE_EMAIL_SUPPORT_RECIPIENT,
        }
      : undefined)
  );
}
