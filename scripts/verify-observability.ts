import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
nextEnv.loadEnvConfig(process.cwd());
const {
  observed,
  currentTraceId,
  recordWorkflowFailure,
  flushObservability,
  shutdownObservability,
} = await import("../lib/observability");
const { draft, classifyReport, generateSpec } = await import("../lib/gemini");
const { qualifyGrowth, draftGrowth } = await import("../lib/growth-model");
const exec = promisify(execFile);
const results: Array<{ workflow: string; traceId?: string; result: unknown }> =
  [];
const check = async (workflow: string, action: () => Promise<unknown>) => {
  await observed(workflow, async () => {
    const result = await action();
    results.push({
      workflow,
      traceId: currentTraceId(),
      result,
    });
    return result;
  })();
};
try {
  // Actual fixture regression, in a temporary copy. Never modify the live app,
  // protected tests, saved customer data, or a production release.
  const fixture = await fs.mkdtemp(
    path.join(os.tmpdir(), "cue-trace-regression-"),
  );
  await fs.cp("demo/bloom", fixture, { recursive: true });
  const tests = observed(
    "Independent upload acceptance",
    async () => {
      try {
        const { stdout, stderr } = await exec(process.execPath, ["test.mjs"], {
          cwd: fixture,
          timeout: 30_000,
        });
        return { ok: true, output: stdout + stderr };
      } catch (error) {
        recordWorkflowFailure(error);
        const result = error as { stdout?: string; stderr?: string };
        return {
          ok: false,
          output: (result.stdout || "") + (result.stderr || ""),
        };
      }
    },
    { kind: "TOOL" },
  );
  await check("Cue regression before fix", async () => {
    const result = await tests();
    assert.equal(result.ok, false);
    return result;
  });
  const limits = await fs.readFile(path.join(fixture, "limits.mjs"), "utf8");
  assert(limits.includes("2 * 1024 * 1024"));
  await fs.writeFile(
    path.join(fixture, "limits.mjs"),
    limits.replace("2 * 1024 * 1024", "5 * 1024 * 1024"),
  );
  await check("Cue regression after fix", async () => {
    const result = await tests();
    assert.equal(result.ok, true);
    return result;
  });
  await fs.rm(fixture, { recursive: true, force: true });
  await check("Cue support verification", async () => {
    const context = {
      channel: "chat",
      appName: "Bloom",
      case: {
        title: "3 MB photo rejected",
        body: "My 3 MB PNG fails with 413, but Bloom says up to 5 MB.",
      },
      issue: { kind: "bug", status: "open" },
    };
    const reply = await draft(context);
    assert(reply.length > 0);
    assert(!/we (fixed|shipped)|fix is live/i.test(reply));
    return {
      reply,
      limitation: "Unsent controlled example; no delivery implied",
    };
  });
  await check("Cue triage verification", async () => {
    const result = await classifyReport({
      report: {
        body: "My valid 3 MB PNG photo gets 413 although the limit is 5 MB.",
      },
      candidates: [
        {
          id: "upload",
          kind: "bug",
          fingerprint: "bloom:upload:413",
          title: "Photos above 2 MB rejected",
          description:
            "Valid photos over 2 MB and up to 5 MB rejected with 413",
        },
      ],
    });
    assert.equal(result.kind, "bug");
    assert.equal(result.matchedIssueId, "upload");
    return result;
  });
  await check("Cue specification verification", async () => {
    const result = await generateSpec({
      title: "Caption search",
      body: "Find my own memories by all words in their captions. Keep journals private.",
    });
    assert(result.acceptanceCriteria.length >= 2);
    assert(
      /all (?:the )?(?:entered |search |query )?(?:words|keywords|terms)/i.test(
        JSON.stringify(result),
      ),
    );
    assert(
      !/any (?:of the )?(?:entered )?(?:words|keywords|terms)/i.test(
        JSON.stringify(result),
      ),
    );
    return result;
  });
  await check("Cue growth verification", async () => {
    const source =
      "Can anyone recommend a photo journal where I can find memories using the words in my captions?";
    const capability = {
      name: "Caption search",
      claims: ["Find your own memories by all words in their captions"],
      unsupported: ["PDF export", "sync", "collaboration"],
    };
    const qualification = await qualifyGrowth(source, capability);
    assert(qualification.eligible);
    const reply = await draftGrowth(
      source,
      capability.claims,
      "https://bloom-with-cue.vercel.app",
      "Bloom",
    );
    return {
      qualification,
      reply,
      limitation: "Controlled unsent draft; no organic acquisition implied",
    };
  });
  assert(await flushObservability());
  await fs.mkdir("artifacts/hackathon", { recursive: true });
  await fs.writeFile(
    "artifacts/hackathon/trace-verification.json",
    JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2),
  );
  console.log(
    JSON.stringify(
      results.map(({ workflow, traceId }) => ({ workflow, traceId })),
      null,
      2,
    ),
  );
} finally {
  await shutdownObservability();
}
