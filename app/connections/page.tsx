import { withAuth } from "@workos-inc/authkit-nextjs";
import { WorkOS } from "@workos-inc/node";
import { PipesConnections } from "./pipes-connections";
import { workosReady } from "@/lib/access";
import { signOutAction } from "@/app/auth/actions";
import { WorkspaceShell } from "../components/workspace-shell";
import "@workos-inc/widgets/styles.css";
export const dynamic = "force-dynamic";
export default async function Connections() {
  const configured = workosReady();
  const session = configured ? await withAuth({ ensureSignedIn: true }) : null;
  const allowed =
    configured &&
    session?.user.email.toLowerCase() ===
      process.env.CUE_OPERATOR_EMAIL?.toLowerCase();
  let enabledProviders = false;
  let providerError = false;
  if (allowed) {
    try {
      const workos = new WorkOS(process.env.WORKOS_API_KEY, {
        clientId: process.env.WORKOS_CLIENT_ID,
      });
      const integrations = await workos.pipes.listDataIntegrations({
        limit: 100,
      });
      enabledProviders = integrations.data.some(
        (integration) => integration.enabled,
      );
    } catch {
      providerError = true;
    }
  }
  return (
    <WorkspaceShell
      active="integrations"
      title="Connected accounts"
      user={
        session?.user
          ? {
              name:
                [session.user.firstName, session.user.lastName]
                  .filter(Boolean)
                  .join(" ") || session.user.email,
              role: allowed ? "owner" : "signed in",
            }
          : undefined
      }
    >
      <main className="workspace-connections">
        <h1>Connected accounts</h1>
        <p>
          WorkOS AuthKit identifies the operator. Pipes manages provider consent
          and credentials.
        </p>
        {allowed && session?.accessToken ? (
          providerError ? (
            <p role="alert">
              WorkOS provider settings could not be loaded. Refresh to retry.
            </p>
          ) : enabledProviders ? (
            <PipesConnections
              accessToken={session.accessToken}
              shared={!!session.organizationId}
            />
          ) : (
            <section>
              <h2>No external providers enabled yet</h2>
              <p>
                Your WorkOS login is connected. Enable the Slack provider with
                your Slack app credentials in the WorkOS dashboard, then connect
                the intended workspace here.
              </p>
              <a
                href="https://dashboard.workos.com"
                target="_blank"
                rel="noreferrer"
              >
                Open WorkOS dashboard ↗
              </a>
            </section>
          )
        ) : (
          <section>
            <h2>
              {configured
                ? "Operator access required"
                : "WorkOS account setup needed"}
            </h2>
            <p>
              {configured
                ? "Sign in with your operator account."
                : "Add the WorkOS API key and client ID to the local environment. Login and account connections will become available here."}
            </p>
            <a
              href="https://workos.com/docs/authkit"
              target="_blank"
              rel="noreferrer"
            >
              AuthKit setup guide ↗
            </a>
          </section>
        )}
        <section>
          <h2>Engineering connections</h2>
          <p>
            Codex uses the existing local ChatGPT login. GitHub uses the
            connected local GitHub CLI account. Gemini uses the selected Google
            Cloud project.
          </p>
          <p>
            Slack event handling requires a Slack app signing secret. Provider
            consent must include the scopes needed for each action.
          </p>
        </section>
        {session?.user && (
          <form action={signOutAction}>
            <button type="submit">Sign out</button>
          </form>
        )}
      </main>
    </WorkspaceShell>
  );
}
