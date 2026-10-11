import nextEnv from "@next/env";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
nextEnv.loadEnvConfig(process.cwd());
const { slackConfig, emailConfig, readIntegrations } = await import(
  "../lib/integration-config"
);
const { slackRuntimeStatus, notificationRuntimeStatus, xRuntimeStatus } =
  await import("../lib/integration-checks");
const exec = promisify(execFile);
const rows: Array<{ service: string; status: string }> = [];
for (const [service, url] of [
  ["Web", "http://127.0.0.1:3000/api/demo"],
  ["Bloom upload service", "http://127.0.0.1:4318/health"],
  ["Convex", process.env.NEXT_PUBLIC_CONVEX_URL || ""],
]) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    rows.push({
      service,
      status: r.ok
        ? "Reachable"
        : service === "Web" && r.status === 401
          ? "Reachable · WorkOS sign-in required"
          : `HTTP ${r.status}`,
    });
  } catch {
    rows.push({ service, status: "Not running" });
  }
}
try {
  const r = await exec(process.env.CUE_CODEX_PATH || "codex", [
    "login",
    "status",
  ]);
  rows.push({
    service: "Codex account",
    status: /logged in/i.test(r.stdout + r.stderr)
      ? "Logged in"
      : "Check login",
  });
} catch {
  rows.push({ service: "Codex account", status: "Login needed" });
}
try {
  await exec("gh", ["auth", "status"]);
  rows.push({ service: "GitHub account", status: "Logged in" });
} catch {
  rows.push({ service: "GitHub account", status: "Login needed" });
}
rows.push({
  service: "Gemini",
  status:
    process.env.GOOGLE_CLOUD_PROJECT || process.env.GEMINI_API_KEY
      ? "Configured (verify makes a live call)"
      : "Project or key needed",
});
rows.push({
  service: "WorkOS",
  status:
    process.env.WORKOS_API_KEY &&
    process.env.WORKOS_CLIENT_ID &&
    process.env.CUE_OPERATOR_EMAIL
      ? "Configured; sign in to verify"
      : "Credentials needed",
});
const [slack, email, slackRuntime, notificationRuntime] = await Promise.all([
  slackConfig(),
  emailConfig(),
  slackRuntimeStatus(),
  notificationRuntimeStatus(),
]);
rows.push({
  service: "Slack",
  status: slackRuntime.connected
    ? "Connected · " + slackRuntime.detail
    : slack
      ? "Configured · " + slackRuntime.detail
      : "Credentials needed",
});
rows.push({
  service: "Email receiving",
  status: notificationRuntime.connected
    ? `Connected · local polling · ${notificationRuntime.imported} imported`
    : email?.pollReceiving
      ? "Configured · " + notificationRuntime.detail
      : email?.webhookSecret
        ? "Configured · webhook delivery unverified"
        : "Receiving connection needed",
});
rows.push({
  service: "Email sending",
  status: email
    ? email.from.toLowerCase() === "onboarding@resend.dev"
      ? "Provider test sender · account owner's inbox only"
      : "Configured · sender domain and inbox delivery need verification"
    : "Credentials needed",
});
const x = (await readIntegrations()).x;
const xStatus = await xRuntimeStatus();
rows.push({
  service: "X API intake",
  status: x?.enabled
    ? xStatus.detail
    : "Disabled · developer access and free credits required",
});
console.table(rows);
