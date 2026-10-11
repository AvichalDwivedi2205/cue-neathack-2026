import path from "node:path";
import { readIntegrations } from "./integration-config";
import { createXPoller } from "./x-poller";
import { api, db, secret } from "./server-store";
import { triage } from "./triage";
import { readHostedBackground } from "./hosted-background";

export function startXListener() {
  let stopped = false;
  const poller = createXPoller({
    config: async () => {
      const config = (await readIntegrations()).x;
      if (
        process.env.CUE_SHARED_CONFIG === "true" &&
        (await readHostedBackground()).value.enabled
      )
        return config ? { ...config, enabled: false } : undefined;
      return config;
    },
    checkpointFile: path.join(process.cwd(), ".cue", "x-poll.json"),
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
    await poller.poll().catch(() => {});
    if (!stopped) timer = setTimeout(() => void refresh(), 60000);
  }
  void refresh();
  return {
    status: poller.status,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await poller.settle();
    },
  };
}
