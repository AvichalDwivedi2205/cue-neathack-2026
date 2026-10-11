import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const config = JSON.parse(readFileSync("/run/secrets/cue-env.json", "utf8"));
if (
  !config.WORKOS_API_KEY ||
  !config.WORKOS_CLIENT_ID ||
  !config.WORKOS_COOKIE_PASSWORD ||
  !config.CUE_DEMO_SECRET ||
  !config.CUE_CONVEX_URL ||
  config.CUE_LOCAL_DEMO !== "false"
)
  throw new Error("Hosted server requires authenticated configuration");
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "0.0.0.0",
    "--port",
    process.env.PORT || "8080",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, ...config, NODE_ENV: "production" },
  },
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", () => process.exit(1));
