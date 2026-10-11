import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { XConfig } from "./integration-config";
import { createXApi, xReports, XApiError, type XReport } from "./x-api";

const checkpointSchema = z.object({
  fingerprint: z.string(),
  sinceId: z.string().regex(/^\d+$/).optional(),
  candidateId: z.string().regex(/^\d+$/).optional(),
  nextToken: z.string().max(1000).optional(),
  imported: z.number().int().nonnegative(),
});
export type XCheckpoint = z.infer<typeof checkpointSchema>;
export type XStatus = {
  connected: boolean;
  detail: string;
  imported: number;
  lastPollAt: number | null;
  retryAt: number | null;
  backlog: boolean;
};
export function createXPoller(deps: {
  config(): Promise<XConfig | undefined>;
  provider?: typeof createXApi;
  receive(report: XReport): Promise<{ duplicate: boolean }>;
  checkpointFile?: string;
  checkpointStorage?: {
    load(): Promise<unknown | null>;
    save(value: XCheckpoint): Promise<void>;
  };
}) {
  let running: Promise<void> | undefined;
  let state: XStatus = {
    connected: false,
    detail: "X API not connected",
    imported: 0,
    lastPollAt: null,
    retryAt: null,
    backlog: false,
  };
  let lastFingerprint = "";
  async function run() {
    let config: XConfig | undefined;
    try {
      config = await deps.config();
    } catch {
      state = {
        ...state,
        connected: false,
        detail: "X configuration could not be read. Intake paused.",
      };
      return;
    }
    if (!config?.enabled) {
      state = {
        connected: false,
        detail: "X API intake disabled",
        imported: 0,
        lastPollAt: null,
        retryAt: null,
        backlog: false,
      };
      return;
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          config.bearerToken,
          config.userId,
          config.username.toLowerCase(),
          config.startedAt,
        ]),
      )
      .digest("hex");
    if (
      lastFingerprint === fingerprint &&
      state.retryAt &&
      state.retryAt > Date.now()
    )
      return;
    lastFingerprint = fingerprint;
    let checkpoint: z.infer<typeof checkpointSchema> = {
      fingerprint,
      imported: 0,
    };
    async function save() {
      if (deps.checkpointStorage)
        return deps.checkpointStorage.save(checkpoint);
      if (!deps.checkpointFile)
        throw new Error("Checkpoint storage unavailable");
      await fs.mkdir(path.dirname(deps.checkpointFile), { recursive: true });
      const temp = deps.checkpointFile + "." + randomUUID();
      await fs.writeFile(temp, JSON.stringify(checkpoint), { mode: 0o600 });
      await fs.rename(temp, deps.checkpointFile);
    }
    try {
      try {
        const value = deps.checkpointStorage
          ? await deps.checkpointStorage.load()
          : JSON.parse(await fs.readFile(deps.checkpointFile!, "utf8"));
        if (value !== null) {
          const saved = checkpointSchema.parse(value);
          if (saved.fingerprint === fingerprint) checkpoint = saved;
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const provider = (deps.provider || createXApi)(config);
      // Check available free credits before every bounded page, never paid balance alone.
      await provider.credits();
      const page = await provider.mentions({
        sinceId: checkpoint.sinceId,
        nextToken: checkpoint.nextToken,
      });
      const reports = xReports(page, config); // Validate all authors before committing any report.
      for (const report of reports) {
        if (!(await deps.receive(report)).duplicate) {
          checkpoint.imported++;
          await save();
        }
      }
      for (const post of page.data || []) {
        if (
          !checkpoint.candidateId ||
          BigInt(post.id) > BigInt(checkpoint.candidateId)
        )
          checkpoint.candidateId = post.id;
      }
      const next = page.meta?.next_token;
      if (next && next === checkpoint.nextToken)
        throw new XApiError("provider");
      if (next) checkpoint.nextToken = next;
      else delete checkpoint.nextToken;
      if (!next && checkpoint.candidateId) {
        checkpoint.sinceId = checkpoint.candidateId;
        delete checkpoint.candidateId;
      }
      await save();
      state = {
        connected: true,
        detail: next
          ? "Official X API connected; processing mention backlog"
          : "Official X API polling active · free credits only",
        imported: checkpoint.imported,
        lastPollAt: Date.now(),
        retryAt: null,
        backlog: !!next,
      };
    } catch (e) {
      state = {
        ...state,
        connected: false,
        imported: checkpoint.imported,
        detail:
          e instanceof XApiError
            ? e.message
            : "X intake could not save its checkpoint. Reports will retry.",
        retryAt:
          Date.now() +
          (e instanceof XApiError && e.reason === "rate" ? 15 * 60000 : 60000),
      };
    }
  }
  return {
    poll() {
      return (running ||= run().finally(() => {
        running = undefined;
      }));
    },
    status: () => ({ ...state }),
    async settle() {
      await running;
    },
  };
}
