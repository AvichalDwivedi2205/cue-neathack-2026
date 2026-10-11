import { randomUUID } from "node:crypto";
import { z } from "zod";
import { api, db, secret } from "./server-store";
import { readIntegrations } from "./integration-config";
import { createXPoller } from "./x-poller";

const xStatus = z.object({
  connected: z.boolean(),
  detail: z.string(),
  imported: z.number().int().nonnegative(),
  lastPollAt: z.number().nullable(),
  retryAt: z.number().nullable(),
  backlog: z.boolean(),
});
const configuration = z.object({ enabled: z.boolean(), x: xStatus.optional() });
export async function readHostedBackground() {
  const row = await db().query(api.serverState.read, {
    secret: secret(),
    key: "background",
  });
  return {
    row,
    value: row
      ? configuration.parse(JSON.parse(row.value))
      : { enabled: false },
  };
}

export async function pollHostedX() {
  const background = await readHostedBackground();
  if (!background.value.enabled) return null;
  if (background.value.x?.retryAt && background.value.x.retryAt > Date.now())
    return null;
  const store = db(),
    auth = secret(),
    token = randomUUID();
  if (!(await store.mutation(api.background.acquire, { secret: auth, token })))
    return null;
  try {
    let checkpointVersion = 0;
    const poller = createXPoller({
      config: async () => (await readIntegrations()).x,
      checkpointStorage: {
        async load() {
          const row = await store.query(api.serverState.read, {
            secret: auth,
            key: "x-checkpoint",
          });
          checkpointVersion = row?.version || 0;
          return row ? JSON.parse(row.value) : null;
        },
        async save(value) {
          if (
            !(await store.mutation(api.serverState.write, {
              secret: auth,
              key: "x-checkpoint",
              expectedVersion: checkpointVersion,
              value: JSON.stringify(value),
            }))
          )
            throw new Error("X checkpoint changed during collection");
          checkpointVersion++;
        },
      },
      receive: (report) =>
        store.mutation(api.intake.receive, { secret: auth, ...report }),
    });
    await poller.poll();
    const status = poller.status();
    if (
      !(await store.mutation(api.serverState.write, {
        secret: auth,
        key: "background",
        expectedVersion: background.row?.version || 0,
        value: JSON.stringify({
          ...background.value,
          x: {
            ...status,
            detail: status.connected
              ? "Hosted " +
                status.detail[0].toLowerCase() +
                status.detail.slice(1)
              : status.detail,
          },
        }),
      }))
    )
      throw new Error("Background configuration changed during collection");
    return status;
  } finally {
    await store.mutation(api.background.release, { secret: auth, token });
  }
}
