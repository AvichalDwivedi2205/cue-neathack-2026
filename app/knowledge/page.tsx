import { headers } from "next/headers";
import { operator } from "@/lib/access";
import { KnowledgeClient } from "./knowledge-client";
import { WorkspaceShell } from "../components/workspace-shell";
import "./knowledge.css";
export const dynamic = "force-dynamic";
export default async function KnowledgePage() {
  let actor: Awaited<ReturnType<typeof operator>>;
  try {
    actor = await operator(
      new Request("http://127.0.0.1", { headers: await headers() }),
    );
  } catch {
    return (
      <WorkspaceShell active="knowledge" title="Knowledge">
        <main className="workspace-auth">
          <h1>Sign in to Cue</h1>
          <p>Company knowledge is available to authorised team members.</p>
          <a href="/auth/login">Continue to sign in</a>
        </main>
      </WorkspaceShell>
    );
  }
  return (
    <WorkspaceShell active="knowledge" title="Knowledge" user={actor}>
      <KnowledgeClient />
    </WorkspaceShell>
  );
}
