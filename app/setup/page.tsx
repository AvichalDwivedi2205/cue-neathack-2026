import { headers } from "next/headers";
import { operator } from "@/lib/access";
import { requirePermission } from "@/lib/roles";
import { SetupClient } from "./setup-client";
import { WorkspaceShell } from "../components/workspace-shell";
import "./setup.css";
export const dynamic = "force-dynamic";
export default async function Setup() {
  let actor: Awaited<ReturnType<typeof operator>>;
  try {
    actor = await operator(
      new Request("http://127.0.0.1", { headers: await headers() }),
    );
    requirePermission(actor, "manage");
  } catch {
    return (
      <WorkspaceShell active="setup" title="App setup">
        <main className="workspace-auth">
          <h1>Sign in to Cue</h1>
          <p>
            The Owner role is required to change integrations and team access.
          </p>
          <a href="/auth/login">Continue to sign in</a>
        </main>
      </WorkspaceShell>
    );
  }
  const h = await headers();
  const origin =
    process.env.CUE_PUBLIC_URL ||
    new URL("http://" + (h.get("host") || "127.0.0.1:3000")).origin;
  return (
    <WorkspaceShell active="setup" title="App setup" user={actor}>
      <SetupClient origin={origin} />
    </WorkspaceShell>
  );
}
