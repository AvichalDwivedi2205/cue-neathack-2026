import nextEnv from "@next/env";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
nextEnv.loadEnvConfig(process.cwd());
const { initializeObservability, shutdownObservability } = await import(
  "../lib/observability"
);
await initializeObservability();
const { api, db, secret } = await import("../lib/server-store");
const {
  ensureBloom,
  resetBloom,
  shutdownBloom,
  investigate,
  approveAndDeploy,
} = await import("../lib/runner");
const store = db(),
  auth = secret(),
  worker = randomUUID();
let stopping = false,
  busy = false;
let currentAbort: AbortController | undefined;
await ensureBloom();
const { startSlackListener } = await import("../lib/slack-socket");
const slack = await startSlackListener();
const { startNotificationListener } = await import(
  "../lib/notification-listener"
);
const notifications = startNotificationListener();
const { startXListener } = await import("../lib/x-listener");
const x = startXListener();
const { sendSlackRunUpdate } = await import("../lib/delivery");
const { implementFeature } = await import("../lib/feature-runner");
const control = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${auth}`) {
    res.writeHead(403);
    return res.end();
  }
  if (req.url === "/status" && req.method === "GET") {
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({
        ok: true,
        busy,
        slack: slack.status(),
        notifications: notifications.status(),
        x: x.status(),
      }),
    );
  }
  if (req.url === "/reset" && req.method === "POST" && !busy) {
    try {
      await resetBloom();
      return res.end("ok");
    } catch {
      res.writeHead(500);
      return res.end("reset failed");
    }
  }
  res.writeHead(409);
  res.end("worker busy");
});
control.listen(4319, "127.0.0.1");
console.log("Cue worker ready · persistent Convex jobs · Bloom :4318");
const { checkCodex } = await import("../lib/integration-checks");
const workerIdentity = await checkCodex(true);
let publishing = false;
async function publishStatus() {
  if (process.env.CUE_SHARED_CONFIG !== "true" || publishing) return;
  publishing = true;
  try {
    const row = await store.query(api.serverState.read, {
      secret: auth,
      key: "worker",
    });
    await store.mutation(api.serverState.write, {
      secret: auth,
      key: "worker",
      expectedVersion: row?.version ?? 0,
      value: JSON.stringify({
        busy,
        slack: slack.status(),
        notifications: notifications.status(),
        x: x.status(),
        codex: {
          loggedIn: workerIdentity.loggedIn,
          github: workerIdentity.github,
          workerOnline: !stopping,
        },
      }),
    });
  } catch {
    console.error("Worker status could not be published");
  } finally {
    publishing = false;
  }
}
await publishStatus();
const statusTimer = setInterval(() => void publishStatus(), 8000);
const stop = async () => {
  stopping = true;
  clearInterval(statusTimer);
  currentAbort?.abort();
  control.close();
  await slack.stop();
  await notifications.stop();
  await x.stop();
  await publishStatus();
  await shutdownBloom();
  await shutdownObservability();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
while (!stopping) {
  try {
    const job = await store.mutation(api.jobs.claim, { secret: auth, worker });
    if (!job) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    busy = true;
    const state = await store.query(api.cue.snapshot, { secret: auth }),
      run = state.runs.find((r) => r._id === job.runId);
    if (!run) throw new Error("Missing run");
    const abort = new AbortController(),
      deadline = setTimeout(
        () => abort.abort(),
        job.kind === "feature" ? 900000 : 300000,
      );
    currentAbort = abort;
    const heartbeat = setInterval(
      () =>
        store
          .mutation(api.jobs.heartbeat, {
            secret: auth,
            jobId: job._id,
            worker,
          })
          .then((s) => {
            if (s.cancel) abort.abort();
          })
          .catch(() => abort.abort()),
      8000,
    );
    try {
      await sendSlackRunUpdate(run._id).catch(() => {});
      if (job.kind === "investigate")
        await investigate(run._id, run.issueId, abort.signal);
      else if (job.kind === "feature")
        await implementFeature(run._id, abort.signal);
      else if (job.kind === "deploy") await approveAndDeploy(run._id);
      else throw new Error("Unsupported worker job kind");
    } catch (e) {
      await store
        .mutation(api.cue.updateRun, {
          secret: auth,
          runId: run._id,
          fields: {
            status: "failed",
            phase: "worker_error",
            error: e instanceof Error ? e.message : String(e),
          },
        })
        .catch(() => {});
    } finally {
      await sendSlackRunUpdate(run._id).catch(() => {});
      currentAbort = undefined;
      clearInterval(heartbeat);
      clearTimeout(deadline);
      await store.mutation(api.jobs.finish, {
        secret: auth,
        jobId: job._id,
        worker,
      });
      busy = false;
    }
  } catch (e) {
    busy = false;
    console.error("Worker error:", e instanceof Error ? e.message : e);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
