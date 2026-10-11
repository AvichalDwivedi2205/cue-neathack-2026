import { expect, test } from "vitest";
import vm from "node:vm";
import { design } from "../lib/design";

async function harness(storage = new Map<string, string>()) {
  const html = await (await design("cue")).text();
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((s) => s.includes("function growthPage()"))!;
  const elements = new Map<string, { value?: string; open?: boolean }>();
  let writes = 0;
  const context = vm.createContext({
    window: {},
    document: {
      addEventListener: () => {},
      getElementById: () => null,
      querySelector: (s: string) => elements.get(s),
    },
    addEventListener: () => {},
    matchMedia: () => ({ matches: false }),
    setInterval: () => 1,
    fetch: (_url: string, options?: { method?: string }) => {
      if (options?.method === "POST") writes++;
      return new Promise(() => {});
    },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    },
  });
  const executable = script.replace(
    /hydrateIcons\(\);\s*initLanding\(\);\s*route\(\);\s*\}\)\(\);\s*$/,
    `
    S.ag.appId = 'bloom'; S.growth.opps = [];
    growthData = {opportunities: [], drafts: [], touches: [], browsers: []};
    gRerender = () => {}; toast = () => {};
    window.demo = {render: () => gResults(), state: () => growthDemoState(),
      app: (id) => {S.ag.appId = id;},
      choose: (v) => A.gResultView({dataset: {v}}),
      save: () => A.gDemoSave(), reset: () => A.gDemoReset(),
      live: () => growthData};
  })();`,
  );
  vm.runInContext(executable, context);
  const demo = context.window.demo as {
    render(): string;
    state(): { show: boolean; counts: Record<string, number> };
    app(id: string): void;
    choose(v: string): void;
    save(): void;
    reset(): void;
    live(): unknown;
  };
  const fill = (values: number[]) => {
    [
      "discovered",
      "qualified",
      "approved",
      "published",
      "visits",
      "activated",
    ].forEach((key, i) =>
      elements.set("#growth-demo-" + key, { value: String(values[i]) }),
    );
    elements.set("#growth-demo-editor", { open: true });
  };
  return { demo, fill, storage, writes: () => writes };
}

test("demo numbers are opt-in, labeled, app-local and cannot enter live results or writes", async () => {
  const h = await harness();
  const before = JSON.stringify(h.demo.live());
  expect(h.demo.render()).not.toContain('data-testid="growth-demo-scenario"');
  h.demo.choose("demo");
  expect(h.demo.render()).toContain("Sample numbers");
  expect(h.demo.render()).toContain("not observed growth");
  h.fill([60, 18, 10, 8, 40, 12]);
  h.demo.save();
  expect(h.demo.render()).toContain("30.0% sample");
  expect(h.demo.state().counts.activated).toBe(12);
  h.demo.app("another-app");
  expect(h.demo.state().show).toBe(false);
  expect(h.demo.state().counts.activated).toBe(7);
  h.demo.app("bloom");
  h.demo.choose("live");
  expect(h.demo.render()).not.toContain("30.0% sample");
  expect(JSON.stringify(h.demo.live())).toBe(before);
  expect(h.writes()).toBe(0);
  const reloaded = await harness(h.storage);
  expect(reloaded.demo.state().counts.activated).toBe(12);
  expect(reloaded.demo.state().show).toBe(false);
});

test("invalid funnel numbers and corrupt saved data cannot masquerade as valid demo figures", async () => {
  const h = await harness(
    new Map([["cue:growth-demo:bloom", '{"activated":900}']]),
  );
  h.demo.choose("demo");
  for (const values of [
    [1, 2, 1, 1, 1, 1],
    [10, 8, 9, 6, 8, 7],
    [10, 8, 6, 7, 8, 7],
    [10, 8, 6, 5, 7, 8],
    [10, 8, 6, 0, 7, 1],
    [10, 8, 6, 5, 7, -1],
    [10, 8, 6, 5, 7, 1.5],
  ]) {
    h.fill(values);
    h.demo.save();
    expect(h.demo.state().counts.activated).toBe(7);
  }
  h.fill([60, 18, 10, 8, 40, 12]);
  h.demo.save();
  h.demo.reset();
  expect(h.demo.state().counts.activated).toBe(7);
  expect(h.storage.has("cue:growth-demo:bloom")).toBe(false);
  expect(h.writes()).toBe(0);
});
