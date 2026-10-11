import { headers } from "next/headers";
import { operator } from "@/lib/access";
import { KnowledgeClient } from "./knowledge-client";
import "./knowledge.css";
export const dynamic = "force-dynamic";
export default async function KnowledgePage() {
  try {
    await operator(
      new Request("http://127.0.0.1", { headers: await headers() }),
    );
  } catch {
    return (
      <main className="knowledge-shell">
        <h1>Sign in to Cue</h1>
        <p>Company knowledge is available to authorised team members.</p>
        <a href="/auth/login">Continue to sign in</a>
      </main>
    );
  }
  return <KnowledgeClient />;
}
