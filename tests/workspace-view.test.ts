import { expect, test } from "vitest";
import vm from "node:vm";
import { design } from "../lib/design";

async function workspaceBrowser(selected: string) {
  const html = await (await design("cue")).text();
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((s) => s.includes("function growthPage()"))!;
  const storage = new Map([["cue-agent-app", selected]]);
  const changes: ((e: unknown) => void)[] = [];
  const reads: { url: string; resolve: (r: unknown) => void }[] = [];
  const context = vm.createContext({
    window: {},
    document: {
      addEventListener: (name: string, fn: (e: unknown) => void) => {
        if (name === "change") changes.push(fn);
      },
    },
    addEventListener: () => {},
    matchMedia: () => ({ matches: false }),
    fetch: (url: string) =>
      new Promise((resolve) => reads.push({ url, resolve })),
    setInterval: () => 1,
    localStorage: { getItem: () => null },
    sessionStorage: {
      getItem: (k: string) => storage.get(k),
      setItem: (k: string, v: string) => storage.set(k, v),
    },
  });
  vm.runInContext(
    script.replace(
      /hydrateIcons\(\);\s*initLanding\(\);\s*route\(\);\s*\}\)\(\);\s*$/,
      `agRefresh = () => {}; gRerender = () => {};
     window.controls = { state: S, workspace: loadWorkspace, growth: loadGrowth, action: growthAction }; })();`,
    ),
    context,
  );
  return {
    context,
    storage,
    reads,
    changes,
    controls: context.window.controls,
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const snapshot = (id: string) => ({
  app: { id, name: id },
  apps: [{ id, name: id }],
  operator: { name: "Owner", role: "owner" },
  agents: [],
  tasks: [{ id: "task-" + id }],
  conversations: [],
});
const growth = (appId: string) => ({
  appId,
  capabilities: [],
  campaigns: [],
  opportunities: [],
  drafts: [],
  touches: [],
  browsers: [],
  reviewDeliveries: [],
});

test("reload restores selected application and app switch rejects old workspace and Growth responses", async () => {
  const browser = await workspaceBrowser("legacy-app");
  expect(browser.controls.state.ag.appId).toBe("legacy-app");
  expect(browser.reads.map((r) => r.url)).toContain(
    "/api/agents?app=legacy-app",
  );
  expect(browser.reads.map((r) => r.url)).toContain(
    "/api/growth?app=legacy-app",
  );
  browser.changes.forEach((fn) =>
    fn({ target: { id: "ag-app", value: "current-app" } }),
  );
  expect(browser.storage.get("cue-agent-app")).toBe("current-app");
  expect(browser.controls.state.ag.connected).toBe(false);
  browser.reads
    .find((r) => r.url.startsWith("/api/agents"))!
    .resolve({ ok: true, json: async () => snapshot("legacy-app") });
  browser.reads
    .find((r) => r.url.startsWith("/api/growth"))!
    .resolve({ ok: true, json: async () => growth("legacy-app") });
  await flush();
  expect(browser.controls.state.ag.appId).toBe("current-app");
  expect(browser.controls.state.ag.tasks).toHaveLength(0);
  const refreshed = browser.controls.workspace();
  browser.reads
    .at(-1)!
    .resolve({ ok: true, json: async () => snapshot("current-app") });
  await refreshed;
  expect(browser.controls.state.ag.tasks).toEqual([{ id: "task-current-app" }]);
  const reloaded = await workspaceBrowser(
    browser.storage.get("cue-agent-app")!,
  );
  expect(reloaded.controls.state.ag.appId).toBe("current-app");
});

test("Activity app switch cannot submit a Growth action using previous app data", async () => {
  const browser = await workspaceBrowser("legacy-app");
  browser.reads
    .find((r) => r.url.startsWith("/api/agents"))!
    .resolve({ ok: true, json: async () => snapshot("legacy-app") });
  browser.reads
    .find((r) => r.url.startsWith("/api/growth"))!
    .resolve({ ok: true, json: async () => growth("legacy-app") });
  await flush();
  browser.changes.forEach((fn) =>
    fn({ target: { id: "ta-app", value: "current-app" } }),
  );
  const before = browser.reads.length;
  await expect(
    browser.controls.action("capture", { url: "https://x.test/source" }),
  ).rejects.toThrow("selected application");
  expect(browser.reads).toHaveLength(before);
  expect(browser.controls.state.ag.tasks).toHaveLength(0);
  expect(browser.controls.state.growth.opps).toHaveLength(0);
});

test("failed refresh for previous app cannot mark newly selected app unavailable", async () => {
  const browser = await workspaceBrowser("legacy-app");
  browser.changes.forEach((fn) =>
    fn({ target: { id: "ta-app", value: "current-app" } }),
  );
  browser.controls.state.ag.connected = true;
  browser.controls.state.growth.state = "populated";
  browser.reads
    .find((r) => r.url.startsWith("/api/agents"))!
    .resolve({ ok: false, json: async () => ({ error: "old scope failure" }) });
  browser.reads
    .find((r) => r.url.startsWith("/api/growth"))!
    .resolve({ ok: false, json: async () => ({ error: "old scope failure" }) });
  await flush();
  expect(browser.controls.state.ag.connected).toBe(true);
  expect(browser.controls.state.growth.state).toBe("populated");
});
