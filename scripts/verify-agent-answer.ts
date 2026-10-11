import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
nextEnv.loadEnvConfig(process.cwd());
const { api, db, secret } = await import("../lib/server-store");
const origin = process.env.CUE_VERIFY_ORIGIN,
  release = process.env.CUE_VERIFY_RELEASE,
  appId = process.env.CUE_GROWTH_APP,
  participant = process.env.CUE_OPERATOR_EMAIL,
  taskId = process.env.CUE_VERIFY_TASK;
assert(
  origin?.startsWith("https:") && release && appId && participant && taskId,
);
const health = await (await fetch(origin + "/api/bloom")).json();
assert.equal(health.health.release, release);
const auth = { secret: secret() };
const before = await db().query(api.workspace.snapshot, {
  ...auth,
  appId,
  participant,
});
const task = before.tasks.find((t) => t._id === taskId);
assert(task, "Select a real app-bound task");
const beforeJobs = await db().query(api.jobs.status, auth);
const beforeRuns = (await db().query(api.cue.snapshot, auth)).runs;
const input = {
  ...auth,
  appId,
  agent: task.agent,
  taskId: task._id,
  actor: { id: participant, name: "Owner", role: "owner" as const },
  key: `deployed-agent-acceptance:${release}:${task._id}`,
  text: "Explain this task's present blocker and the saved evidence supporting its state. Distinguish Product review, provider delivery, publication and activation.",
  via: "Trusted acceptance CLI",
  queueAnswer: true,
};
const first = await db().mutation(api.workspace.post, input);
assert.equal(first.taskId, task._id);
const replay = await db().mutation(api.workspace.post, input);
assert.equal(replay.duplicate, true);
assert.equal(replay.taskId, first.taskId);
for (let i = 0; i < 20; i++) {
  const state = await db().query(api.workspace.snapshot, {
    ...auth,
    appId,
    participant,
  });
  const conversation = state.conversations.find((c) => c.agent === task.agent);
  const message = conversation?.messages.findLast(
    (m) => m.role === "assistant",
  );
  if (message?.answerStatus === "completed") {
    assert(
      message.text.includes(task._id),
      "Persisted explanation must retain the selected task's factual context",
    );
    const afterJobs = await db().query(api.jobs.status, auth);
    const afterRuns = (await db().query(api.cue.snapshot, auth)).runs;
    assert.deepEqual(
      afterJobs.map((j) => j._id).sort(),
      beforeJobs.map((j) => j._id).sort(),
    );
    assert.deepEqual(
      afterRuns.map((r) => r._id).sort(),
      beforeRuns.map((r) => r._id).sort(),
    );
    const evidence = {
      checkedAt: new Date().toISOString(),
      origin,
      release,
      appId,
      taskId,
      reply: message.text,
      checks: [
        "Exact deployed release observed",
        "Real hosted workpool/provider answer persisted in Agent component",
        "Exact question replay deduplicated",
        "No implementation job or run created",
      ],
      limitation:
        "Trusted CLI submits the question to production Convex; the actual deployed Cloud Run worker generates its saved explanation. Native Q/Slack interaction is verified separately.",
    };
    await fs.writeFile(
      process.env.CUE_VERIFY_OUTPUT || ".cue/agent-answer-verification.json",
      JSON.stringify(evidence, null, 2),
      { mode: 0o600 },
    );
    console.log(message.text);
    console.log(
      "PASS · Deployed contextual answer persisted without implementation work",
    );
    process.exit(0);
  }
  if (message?.answerStatus === "failed")
    throw new Error("Actual hosted answer failed");
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
throw new Error(
  "Actual hosted answer did not complete within the bounded window",
);
