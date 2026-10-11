import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Codex } from "@openai/codex-sdk";
import { api, db, secret } from "./server-store";
import type { Id } from "../convex/_generated/dataModel";
import { photo } from "../demo/bloom/fixture.mjs";
import { sendSlackRunUpdate } from "./delivery";
import { observed, recordWorkflowFailure } from "./observability";
import { runCodexSession } from "./codex-session";
const exec = promisify(execFile),
  root = () => path.join(process.cwd(), ".cue"),
  live = () => path.join(root(), "bloom-live");
let bloom: ChildProcess | undefined;
async function commandImpl(
  file: string,
  args: string[],
  cwd: string,
  timeout = 30000,
) {
  try {
    const r = await exec(file, args, {
      cwd,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, output: r.stdout + r.stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: (err.stdout || "") + (err.stderr || "") + (err.message || ""),
    };
  }
}
const command = observed("Repository command", commandImpl, {
  kind: "TOOL",
  input: (file, args) => ({ file, args }),
});
async function checked(
  file: string,
  args: string[],
  cwd: string,
  timeout = 30000,
) {
  const r = await command(file, args, cwd, timeout);
  if (!r.ok) throw new Error(r.output);
  return r.output.trim();
}
async function startBloom(build: string) {
  bloom = spawn(process.execPath, [path.join(live(), "server.mjs")], {
    cwd: live(),
    env: {
      NODE_ENV: "development",
      PATH: process.env.PATH,
      PORT: "4318",
      BLOOM_BUILD: build,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await fs.writeFile(
    path.join(root(), "bloom-runtime.json"),
    JSON.stringify({ pid: bloom!.pid, build }),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Bloom startup timeout")),
      10000,
    );
    bloom!.stdout?.on("data", (d) => {
      if (String(d).includes("BLOOM_URL=")) {
        clearTimeout(timer);
        resolve();
      }
    });
    bloom!.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    bloom!.once("exit", (code) => {
      if (code) {
        clearTimeout(timer);
        reject(new Error("Bloom exited " + code));
      }
    });
  });
}
async function stopBloom() {
  if (!bloom || bloom.exitCode !== null) return;
  const child = bloom;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
export async function ensureBloom() {
  await fs.mkdir(root(), { recursive: true });
  let build = "original";
  try {
    const saved = JSON.parse(
      await fs.readFile(path.join(root(), "bloom-runtime.json"), "utf8"),
    );
    build = saved.build || build;
    try {
      const h = await (
        await fetch("http://127.0.0.1:4318/health", {
          signal: AbortSignal.timeout(1000),
        })
      ).json();
      if (h.app === "Bloom" && h.build === build && saved.pid) {
        const cmd = await checked(
          "ps",
          ["-p", String(saved.pid), "-o", "command="],
          process.cwd(),
        );
        if (cmd.endsWith(path.join(live(), "server.mjs"))) {
          process.kill(saved.pid, "SIGTERM");
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    } catch {}
  } catch {}
  try {
    await fs.access(path.join(live(), "server.mjs"));
  } catch {
    await fs.cp(path.join(process.cwd(), "demo/bloom"), live(), {
      recursive: true,
    });
  }
  await startBloom(build);
}
export async function resetBloom() {
  await stopBloom();
  await fs.rm(live(), { recursive: true, force: true });
  await fs.cp(path.join(process.cwd(), "demo/bloom"), live(), {
    recursive: true,
  });
  await startBloom("original");
}
export async function shutdownBloom() {
  await stopBloom();
}
async function investigateImpl(
  runId: Id<"runs">,
  issueId: Id<"issues">,
  signal: AbortSignal,
) {
  const store = db(),
    auth = secret(),
    repo = path.join(root(), "runs", runId);
  const log = async (title: string, detail: string, kind = "agent") => {
    await store.mutation(api.cue.event, {
      secret: auth,
      runId,
      issueId,
      title,
      detail: detail.slice(-12000),
      kind,
    });
  };
  const update = async (
    fields: Parameters<
      typeof store.mutation<typeof api.cue.updateRun>
    >[1]["fields"],
  ) => {
    await store.mutation(api.cue.updateRun, { secret: auth, runId, fields });
    if (
      ["implementing", "awaiting_approval", "failed"].includes(
        fields.phase || "",
      )
    )
      await sendSlackRunUpdate(runId).catch(() => {});
  };
  try {
    await fs.mkdir(path.dirname(repo), { recursive: true });
    const remote = process.env.CUE_GITHUB_REPO;
    if (remote) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(remote))
        throw new Error("Invalid repository configuration");
      await checked(
        "gh",
        [
          "repo",
          "clone",
          remote,
          repo,
          "--",
          "--branch",
          "main",
          "--single-branch",
        ],
        process.cwd(),
        60000,
      );
    } else {
      await fs.mkdir(repo, { recursive: true });
      await fs.cp(path.join(process.cwd(), "demo/bloom"), repo, {
        recursive: true,
      });
      await checked("git", ["init", "-b", "main"], repo);
    }
    await checked("git", ["config", "user.name", "Cue Demo"], repo);
    await checked("git", ["config", "user.email", "cue-demo@localhost"], repo);
    if (!remote) {
      await checked("git", ["add", "."], repo);
      await checked(
        "git",
        ["commit", "-m", "Seed Bloom upload regression"],
        repo,
      );
    }
    await checked("git", ["checkout", "-b", `cue/fix-upload-${runId}`], repo);
    await update({ repoPath: repo });
    await log(
      "Test environment prepared",
      "Isolated Git checkout; only limits.mjs is allowed to change.",
      "system",
    );
    const before = await command(process.execPath, ["test.mjs"], repo);
    if (
      before.ok ||
      !before.output.includes("3 MB photo: HTTP 413 (expected 201)")
    )
      throw new Error(
        "Expected customer regression not reproduced. " + before.output,
      );
    await update({
      before: before.output,
      rootCause: "MAX_UPLOAD_BYTES is 2 MB while the interface promises 5 MB.",
      phase: "implementing",
    });
    await log("Bug reproduced", before.output, "reproduction");
    await log(
      "Root cause identified",
      "The same server rejects 3 MB and 5 MB photos; the 5 MB contract belongs to Bloom.",
      "system",
    );
    const tracked = (await checked("git", ["ls-files"], repo)).split("\n"),
      hashes = new Map<string, string>();
    for (const file of tracked)
      if (file !== "limits.mjs")
        hashes.set(
          file,
          createHash("sha256")
            .update(await fs.readFile(path.join(repo, file)))
            .digest("hex"),
        );
    const agentEnv: Record<string, string> = {};
    for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "CODEX_HOME"])
      if (process.env[key]) agentEnv[key] = process.env[key]!;
    const codex = new Codex({
      env: agentEnv,
      ...(process.env.CUE_CODEX_PATH
        ? { codexPathOverride: process.env.CUE_CODEX_PATH }
        : {}),
    });
    const thread = codex.startThread({
      workingDirectory: repo,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    });
    await log(
      "Codex implementing fix",
      "Using the operator’s existing Codex login. Independent tests and deployment remain outside the agent.",
    );
    let summary = "";
    await runCodexSession(
      thread,
      "Fix Bloom: UI promises up to 5 MB photos but 3 MB returns 413. Inspect the repository and run node test.mjs. Change ONLY limits.mjs. Preserve every other file including test.mjs and fixture.mjs. Preserve rejection above 5 MB. Do not read outside this directory, access credentials, publish, modify Git history, or leave servers running. Give a brief cause and test summary.",
      signal,
      async (e) => {
        if (e.type === "item.completed" && e.item.type === "command_execution")
          await log(
            "Codex repository check",
            e.item.command + "\n" + e.item.aggregated_output.slice(-4500),
          );
        if (e.type === "item.completed" && e.item.type === "file_change")
          await log(
            "Codex proposed a patch",
            e.item.changes
              .map((c) => `${c.kind}: ${path.basename(c.path)}`)
              .join("\n"),
          );
        if (e.type === "item.completed" && e.item.type === "agent_message")
          summary = e.item.text;
        if (e.type === "turn.failed") throw new Error(e.error.message);
        if (e.type === "error") throw new Error(e.message);
      },
    );
    if (signal.aborted) throw new Error("Run canceled");
    const changed = await checked("git", ["diff", "HEAD", "--name-only"], repo);
    const untracked = await checked(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      repo,
    );
    if (changed !== "limits.mjs" || untracked)
      throw new Error("Patch scope violated: " + changed + " " + untracked);
    for (const [file, hash] of hashes)
      if (
        createHash("sha256")
          .update(await fs.readFile(path.join(repo, file)))
          .digest("hex") !== hash
      )
        throw new Error("Protected file changed: " + file);
    const after = await checked(process.execPath, ["test.mjs"], repo);
    const diff = await checked(
      "git",
      ["diff", "HEAD", "--", "limits.mjs"],
      repo,
    );
    await log("Independent tests passed", after, "success");
    await checked("git", ["add", "limits.mjs"], repo);
    await checked(
      "git",
      ["commit", "-m", "Fix Bloom uploads within the advertised 5 MB limit"],
      repo,
    );
    const commit = await checked("git", ["rev-parse", "HEAD"], repo);
    let prUrl: string | undefined;
    if (remote) {
      await checked(
        "git",
        ["push", "origin", `cue/fix-upload-${runId}`],
        repo,
        60000,
      );
      const bodyFile = path.join(root(), `pr-${runId}.txt`);
      await fs.writeFile(
        bodyFile,
        "Bloom rejected valid 3 MB photos although the interface advertised 5 MB. This change aligns the server limit with that promise.\n\nValidation: 8 independent HTTP checks cover 1, 2, 3 and 5 MB accepted photos, both boundary transitions, a 6 MB rejection and invalid-image rejection.\n\nCue requires approval of the exact commit before deploying to the local demo.",
      );
      prUrl = await checked(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          remote,
          "--base",
          "main",
          "--head",
          `cue/fix-upload-${runId}`,
          "--draft",
          "--title",
          "Fix Bloom photo upload limit",
          "--body-file",
          bodyFile,
        ],
        repo,
        60000,
      );
      await log("Draft pull request opened", prUrl, "system");
    }
    await update({
      status: "awaiting_approval",
      phase: "awaiting_approval",
      diff,
      after,
      commit,
      summary,
      prUrl,
    });
    await log(
      "Change awaiting approval",
      `Exact commit ${commit}. ${prUrl || "Local change; GitHub not configured."}`,
      "approval",
    );
  } catch (e) {
    recordWorkflowFailure(e);
    const message = e instanceof Error ? e.message : String(e);
    try {
      await update({
        status: signal.aborted ? "canceled" : "failed",
        phase: "failed",
        error: message,
      });
    } catch {}
    await log(
      signal.aborted ? "Run canceled" : "Investigation failed",
      message,
      "failure",
    );
  }
}
async function approveAndDeployImpl(runId: Id<"runs">) {
  const store = db(),
    auth = secret(),
    state = await store.query(api.cue.snapshot, { secret: auth }),
    run = state.runs.find((r) => r._id === runId);
  if (
    !run ||
    run.phase !== "deploying" ||
    !run.approval ||
    !run.repoPath ||
    !run.commit
  )
    throw new Error("Deployment needs an approved exact commit");
  const repo = path.join(root(), "runs", runId),
    backup = path.join(root(), "bloom-backup");
  let previous = "original";
  if (run.repoPath !== repo) throw new Error("Unexpected run checkout");
  const commit = await checked("git", ["rev-parse", "HEAD"], repo);
  if (
    commit !== run.commit ||
    (await checked("git", ["status", "--porcelain"], repo))
  )
    throw new Error("Approved checkout changed");
  try {
    previous = (await (await fetch("http://127.0.0.1:4318/health")).json())
      .build;
    await fs.rm(backup, { recursive: true, force: true });
    await fs.cp(live(), backup, { recursive: true });
    const exported = path.join(root(), "releases", commit);
    await fs.mkdir(exported, { recursive: true });
    for (const file of (await checked("git", ["ls-files"], repo)).split("\n")) {
      await fs.mkdir(path.dirname(path.join(exported, file)), {
        recursive: true,
      });
      await fs.copyFile(path.join(repo, file), path.join(exported, file));
    }
    await stopBloom();
    await fs.rm(live(), { recursive: true, force: true });
    await fs.cp(exported, live(), { recursive: true });
    await startBloom(commit);
    await store.mutation(api.cue.event, {
      secret: auth,
      runId,
      issueId: run.issueId,
      title: "Demo deployment updated",
      detail: `Bloom release ${commit} is listening on the customer upload endpoint.`,
      kind: "deployment",
    });
    await store.mutation(api.cue.updateRun, {
      secret: auth,
      runId,
      fields: { deployed: true, phase: "verifying" },
    });
    const health = await (await fetch("http://127.0.0.1:4318/health")).json();
    if (health.build !== commit) throw new Error("Unexpected deployed release");
    const statuses = [];
    for (const [size, expected] of [
      [3 * 1024 * 1024, 201],
      [6 * 1024 * 1024, 413],
    ]) {
      const r = await fetch("http://127.0.0.1:4318/upload", {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: photo(size),
      });
      statuses.push(r.status);
      if (r.status !== expected)
        throw new Error(
          `Deployed photo returned ${r.status}; expected ${expected}`,
        );
    }
    await store.mutation(api.cue.event, {
      secret: auth,
      runId,
      issueId: run.issueId,
      title: "Deployed scenario verified",
      detail: `Valid 3 MB PNG: HTTP ${statuses[0]}; valid 6 MB control: HTTP ${statuses[1]}. Build ${commit}.`,
      kind: "success",
    });
    await store.mutation(api.cue.updateRun, {
      secret: auth,
      runId,
      fields: {
        status: "resolved",
        phase: "resolved",
        deployed: true,
        verified: true,
      },
    });
    await store.mutation(api.cue.event, {
      secret: auth,
      runId,
      issueId: run.issueId,
      title: "Customer updates recorded",
      detail:
        "Live in-app conversations updated. X and email replies saved as drafts for the operator; no external sends claimed.",
      kind: "success",
    });
  } catch (e) {
    recordWorkflowFailure(e);
    await stopBloom();
    try {
      await fs.rm(live(), { recursive: true, force: true });
      await fs.cp(backup, live(), { recursive: true });
      await startBloom(previous);
    } catch {}
    await store.mutation(api.cue.updateRun, {
      secret: auth,
      runId,
      fields: {
        status: "failed",
        phase: "rolled_back",
        deployed: false,
        verified: false,
        error: e instanceof Error ? e.message : String(e),
      },
    });
  }
}

export const investigate = observed("Cue bug investigation", investigateImpl, {
  input: (runId, issueId) => ({ runId, issueId }),
});
export const approveAndDeploy = observed(
  "Cue approved deployment",
  approveAndDeployImpl,
);
