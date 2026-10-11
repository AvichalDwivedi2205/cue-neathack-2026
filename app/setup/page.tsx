import { headers } from "next/headers";
import { operator } from "@/lib/access";
import { requirePermission } from "@/lib/roles";
import { SetupClient } from "./setup-client";
import "./setup.css";
export const dynamic = "force-dynamic";
export default async function Setup() {
  try {
    const actor = await operator(
      new Request("http://127.0.0.1", { headers: await headers() }),
    );
    requirePermission(actor, "manage");
  } catch {
    return (
      <main className="setup">
        <h1>Sign in to Cue</h1>
        <p>
          The Owner role is required to change integrations and team access.
        </p>
        <a href="/auth/login">Continue to sign in</a>
      </main>
    );
  }
  const h = await headers();
  const origin =
    process.env.CUE_PUBLIC_URL ||
    new URL("http://" + (h.get("host") || "127.0.0.1:3000")).origin;
  return <SetupClient origin={origin} />;
}
