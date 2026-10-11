import { isSocialNotification, type ReceivedEmail } from "./email-intake";
import type { EmailConfig } from "./integration-config";

export type ReceivingMetadata = Pick<ReceivedEmail, "from" | "subject"> & {
  to: string[];
  received_for?: string[];
  created_at: string;
};

// Polling and signed webhooks share the same inbox and activation boundaries.
// Delivery authentication alone does not authorize importing other inboxes.
export function receivingMode(
  mail: ReceivingMetadata,
  config: EmailConfig,
  notificationStartedAt = config.pollStartedAt ?? 0,
): "support" | "notification" | null {
  const recipients = mail.received_for?.length ? mail.received_for : mail.to;
  if (!Array.isArray(recipients)) return null;
  const to = recipients.map((address) => address.trim().toLowerCase());
  const support =
    !!config.supportReceivingAddress &&
    to.includes(config.supportReceivingAddress.toLowerCase());
  const notification =
    !!config.receivingAddress &&
    to.includes(config.receivingAddress.toLowerCase());
  if (support && notification) return null;
  const receivedAt = Date.parse(mail.created_at);
  if (!Number.isFinite(receivedAt)) return null;
  if (
    support &&
    receivedAt >= (config.supportPollStartedAt ?? notificationStartedAt)
  )
    return "support";
  if (
    notification &&
    config.notificationImport &&
    receivedAt >= notificationStartedAt &&
    isSocialNotification(mail)
  )
    return "notification";
  return null;
}
