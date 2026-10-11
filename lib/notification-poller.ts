import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { normalizeEmail, type ReceivedEmail } from "./email-intake";
import type { EmailConfig } from "./integration-config";
import { receivingMode } from "./email-routing";

type MailMetadata = Pick<ReceivedEmail, "id" | "from" | "subject"> & {
  created_at: string;
  to: string[];
  received_for?: string[];
};
export type NotificationProvider = {
  list(after?: string): Promise<{ data: MailMetadata[]; has_more: boolean }>;
  get(id: string): Promise<ReceivedEmail & MailMetadata>;
};
type Report = ReturnType<typeof normalizeEmail>["reports"][number];
const checkpointSchema = z.object({
  fingerprint: z.string(),
  startedAt: z.number().finite(),
  after: z.string().max(200).optional(),
  processed: z.array(z.string().max(200)).max(5000),
  imported: z.number().int().nonnegative(),
  needsReview: z.number().int().nonnegative(),
});
type Checkpoint = z.infer<typeof checkpointSchema>;
export type NotificationStatus = {
  connected: boolean;
  detail: string;
  lastPollAt: number | null;
  imported: number;
  needsReview: number;
  backlog: boolean;
};

// One worker owns this checkpoint. Database receipts remain authoritative if
// the process dies between committing a report and writing the checkpoint.
export function createNotificationPoller(deps: {
  config(): Promise<EmailConfig | undefined>;
  provider(config: EmailConfig): NotificationProvider;
  receive(report: Report): Promise<{ duplicate: boolean }>;
  checkpointFile: string;
}) {
  let running: Promise<void> | undefined;
  let state: NotificationStatus = {
    connected: false,
    detail: "Notification inbox not configured",
    lastPollAt: null,
    imported: 0,
    needsReview: 0,
    backlog: false,
  };
  async function save(checkpoint: Checkpoint) {
    await fs.mkdir(path.dirname(deps.checkpointFile), { recursive: true });
    const temp = deps.checkpointFile + "." + randomUUID();
    await fs.writeFile(temp, JSON.stringify(checkpoint), { mode: 0o600 });
    await fs.rename(temp, deps.checkpointFile);
  }
  async function run() {
    try {
      const config = await deps.config();
      if (
        !config?.pollReceiving ||
        !(
          config.supportReceivingAddress ||
          (config.notificationImport && config.receivingAddress)
        )
      ) {
        state = {
          connected: false,
          detail: "Enable local inbox polling in Email setup",
          lastPollAt: null,
          imported: 0,
          needsReview: 0,
          backlog: false,
        };
        return;
      }
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            config.apiKey,
            config.receivingAddress?.toLowerCase() ?? null,
            config.notificationImport ?? false,
            config.supportReceivingAddress?.toLowerCase() ?? null,
            config.supportPollStartedAt ?? null,
            config.pollStartedAt ?? null,
          ]),
        )
        .digest("hex");
      let checkpoint: Checkpoint = {
        fingerprint,
        startedAt: config.pollStartedAt ?? Date.now(),
        processed: [],
        imported: 0,
        needsReview: 0,
      };
      try {
        const saved = checkpointSchema.parse(
          JSON.parse(await fs.readFile(deps.checkpointFile, "utf8")),
        );
        if (saved.fingerprint === fingerprint) checkpoint = saved;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      // Persist activation time even if the first provider request fails.
      await save(checkpoint);
      state.imported = checkpoint.imported;
      state.needsReview = checkpoint.needsReview;
      const provider = deps.provider(config);
      const processed = new Set(checkpoint.processed);
      const mode = (mail: MailMetadata) =>
        receivingMode(mail, config, checkpoint.startedAt);
      for (let page = 0; page < 5; page++) {
        const batch = await provider.list(checkpoint.after);
        for (const metadata of batch.data) {
          const intakeMode = mode(metadata);
          if (processed.has(metadata.id) || !intakeMode) continue;
          const mail = await provider.get(metadata.id);
          if (mail.id !== metadata.id || mode(mail) !== intakeMode)
            throw new Error("Received email metadata changed");
          const result = normalizeEmail(mail, intakeMode === "notification");
          for (const report of result.reports) {
            if (intakeMode === "notification" && report.channel === "email")
              throw new Error("Unexpected email channel");
            if (!(await deps.receive(report)).duplicate) {
              checkpoint.imported++;
              await save(checkpoint);
            }
          }
          if (!result.reports.length) checkpoint.needsReview++;
          processed.add(metadata.id);
          checkpoint.processed = [...processed].slice(-5000);
          await save(checkpoint);
        }
        const next = batch.has_more ? batch.data.at(-1)?.id : undefined;
        if (batch.has_more && (!next || next === checkpoint.after))
          throw new Error("Receiving pagination did not advance");
        checkpoint.after = next;
        await save(checkpoint);
        if (!next) break;
      }
      state = {
        connected: true,
        detail: checkpoint.after
          ? "Inbox connected; continuing backlog next poll"
          : "Inbox polling active; waiting for support or platform notifications",
        lastPollAt: Date.now(),
        imported: checkpoint.imported,
        needsReview: checkpoint.needsReview,
        backlog: !!checkpoint.after,
      };
    } catch {
      // Never expose provider errors, keys, or message content through health.
      state.connected = false;
      state.detail =
        "Notification polling failed; check receiving access and worker storage. Pending reports retry next poll.";
    }
  }
  return {
    poll() {
      if (!running)
        running = run().finally(() => {
          running = undefined;
        });
      return running;
    },
    status: () => ({ ...state }),
    async settle() {
      await running;
    },
  };
}
