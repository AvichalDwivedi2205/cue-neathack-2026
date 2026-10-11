import { Resend } from "resend";
import path from "node:path";
import { emailConfig } from "./integration-config";
import {
  createNotificationPoller,
  type NotificationProvider,
} from "./notification-poller";
import { api, db, secret } from "./server-store";
import { triage } from "./triage";

export function startNotificationListener() {
  let stopped = false;
  const abort = new AbortController();
  const poller = createNotificationPoller({
    config: emailConfig,
    checkpointFile: path.join(process.cwd(), ".cue", "notification-poll.json"),
    provider(config): NotificationProvider {
      const receiving = new Resend(config.apiKey).emails.receiving;
      let lastRequestAt = 0;
      const options = async () => {
        const delay = Math.max(0, 600 - (Date.now() - lastRequestAt));
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        lastRequestAt = Date.now();
        return {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
        };
      };
      return {
        async list(after) {
          const result = await receiving.list(
            { limit: 100, ...(after ? { after } : {}) },
            await options(),
          );
          if (result.error || !result.data)
            throw new Error("Receiving list unavailable");
          return result.data;
        },
        async get(id) {
          const result = await receiving.get(id, {}, await options());
          if (result.error || !result.data)
            throw new Error("Receiving body unavailable");
          return result.data;
        },
      };
    },
    async receive(report) {
      const result = await db().mutation(api.intake.receive, {
        secret: secret(),
        ...report,
      });
      if (!result.duplicate) void triage(result.caseId).catch(() => {});
      return result;
    },
  });
  let timer: ReturnType<typeof setTimeout>;
  async function refresh() {
    await poller.poll();
    if (!stopped) timer = setTimeout(() => void refresh(), 30000);
  }
  void refresh();
  return {
    status: poller.status,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      abort.abort();
      await poller.settle();
    },
  };
}
