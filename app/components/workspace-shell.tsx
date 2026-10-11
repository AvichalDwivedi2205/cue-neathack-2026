import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ReactNode } from "react";
import "./workspace-shell.css";

// The supplied design owns the colours and icons used by the live workspace.
async function foundation() {
  const source = await readFile(
    path.join(process.cwd(), "design/cue.html"),
    "utf8",
  );
  const variables = source.match(/:root\s*\{[^}]+\}/)?.[0];
  if (!variables) throw new Error("Cue design variables are missing");
  const block = source.split("const P = {")[1]?.split("\n};")[0] || "";
  const icons = Object.fromEntries(
    [...block.matchAll(/(\w+): '([^']*)'/g)].map((m) => [m[1], m[2]]),
  );
  return { variables, icons };
}

const groups = [
  {
    label: "",
    links: [
      ["home", "Home", "home", "/cue#/home"],
      ["inbox", "Inbox", "inbox", "/cue#/inbox"],
    ],
  },
  {
    label: "Resolve",
    links: [
      ["issues", "Issues", "bug", "/cue#/issues"],
      ["features", "Feature requests", "bulb", "/cue#/features"],
    ],
  },
  {
    label: "Grow",
    links: [
      ["growth", "Growth", "trend", "/cue#/growth"],
      ["prospects", "Cue customers", "search", "/cue#/growth/prospects"],
    ],
  },
  {
    label: "Agents",
    links: [
      ["agents", "Agents", "bot", "/cue#/agents"],
      ["agent", "Agent activity", "activity", "/cue#/agent"],
    ],
  },
  {
    label: "Workspace",
    links: [
      ["knowledge", "Knowledge", "bulb", "/knowledge"],
      ["integrations", "Integrations", "plug", "/cue#/integrations"],
      ["setup", "App setup", "widget", "/setup"],
      ["settings", "Settings", "settings", "/cue#/settings"],
    ],
  },
] as const;

export async function WorkspaceShell({
  active,
  title,
  user,
  children,
}: {
  active: string;
  title: string;
  user?: { name: string; role: string };
  children: ReactNode;
}) {
  const { variables, icons } = await foundation();
  const icon = (name: string, size = 16) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "cue" ? 3.2 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: icons[name] || icons.plug }}
    />
  );
  const initials = (user?.name || "Cue")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (
    <div className="workspace-shell">
      <style dangerouslySetInnerHTML={{ __html: variables }} />
      <a className="workspace-skip" href="#workspace-content">
        Skip to content
      </a>
      <aside className="workspace-sidebar" aria-label="Sidebar">
        <a className="workspace-brand" href="/cue#/home" aria-label="Cue home">
          <span className="workspace-logo">{icon("cue", 13)}</span>
          <span>Cue</span>
        </a>
        <nav aria-label="Workspace navigation">
          {groups.map((group) => (
            <div className="workspace-nav-group" key={group.label}>
              {group.label && (
                <div className="workspace-nav-heading">{group.label}</div>
              )}
              {group.links.map(([key, label, symbol, href]) => (
                <a
                  key={key}
                  href={href}
                  className={active === key ? "active" : ""}
                  aria-current={active === key ? "page" : undefined}
                  aria-label={label}
                  title={label}
                >
                  {icon(symbol)}
                  <span>{label}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="workspace-sidebar-footer">
          {icon("leaf", 14)}
          <span>Cue workspace</span>
        </div>
      </aside>
      <header className="workspace-topbar">
        <a className="workspace-name" href="/cue#/home">
          <span>{icon("leaf", 12)}</span>Cue workspace
        </a>
        <span className="workspace-divider">/</span>
        <span className="workspace-location">{title}</span>
        <div className="workspace-topbar-actions">
          <a href="/cue#/home" title="Review pending decisions on Home">
            {icon("hourglass", 15)}
            <span>Approvals</span>
          </a>
          <span
            className="workspace-avatar"
            title={user ? `${user.name} · ${user.role}` : "Cue workspace"}
          >
            {initials}
          </span>
        </div>
      </header>
      <div className="workspace-content" id="workspace-content">
        {children}
      </div>
    </div>
  );
}
