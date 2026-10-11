import { expect, test } from "vitest";
import { promises as fs } from "node:fs";
import vm from "node:vm";
import { design } from "../lib/design";

test("assembled Cue bridge initializes against the supplied design bindings", async () => {
  const html = await (await design("cue")).text();
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .find((source) => source.includes("function growthPage()"))!;
  const context = vm.createContext({
    window: {},
    document: { addEventListener: () => {} },
    addEventListener: () => {},
    matchMedia: () => ({ matches: false }),
    fetch: () => new Promise(() => {}),
    setInterval: () => 1,
    localStorage: { getItem: () => null },
  });
  // Exercise every synchronous bridge initializer. DOM boot and provider requests
  // are covered by native deployed checks rather than this isolated harness.
  const executable = script.replace(
    /hydrateIcons\(\);\s*initLanding\(\);\s*route\(\);\s*\}\)\(\);\s*$/,
    `window.initialized = {
      link: gLink({ link: 'https://cue.test/g/current' }),
      capture: typeof A.gCapture,
      approve: typeof A.gApprove,
      discovered: G_TODO.includes('discovered'),
      journey: gJourney({ author: '@tester', j: {} })
    };
    S.growth.state = 'populated'; S.growth.opps = [];
    S.growth.campaigns = [{id: 'campaign', title: 'Caption search', cap: 'cap',
      sources: ['Official X recent search'], queries: ['photo journal'],
      budget: {used: 20, limit: 20}, paused: false, goal: 'Activation'}];
    S.growth.capabilities = [{id: 'cap', title: 'Caption search', claim: 'Find captions',
      release: 'current-release', status: 'valid', check: 'Verified', verifiedAt: Date.now()}];
    S.growth.tab = 'opportunities';
    window.agentUI = {opportunities: growthPage()};
    S.growth.tab = 'campaigns'; window.agentUI.campaigns = growthPage();
    S.growth.tab = 'results'; window.agentUI.results = growthPage();
    })();`,
  );
  expect(() => vm.runInContext(executable, context)).not.toThrow();
  expect(context.window.initialized).toMatchObject({
    link: "https://cue.test/g/current",
    capture: "function",
    approve: "function",
    discovered: true,
  });
  expect(context.window.initialized.journey).toContain("Original source");
  expect(context.window.agentUI.opportunities).toContain(
    'data-testid="growth-agent-status"',
  );
  expect(context.window.agentUI.opportunities).toContain("Daily limit reached");
  expect(context.window.agentUI.opportunities).toContain("Pause agent");
  expect(context.window.agentUI.opportunities).toContain(
    "Growth checks for matching requests automatically",
  );
  expect(context.window.agentUI.opportunities).not.toContain(
    "Run the campaign",
  );
  expect(context.window.agentUI.opportunities).not.toContain(
    'id="growth-source"',
  );
  expect(context.window.agentUI.results).not.toContain('id="growth-source"');
  expect(context.window.agentUI.campaigns).toContain(
    '<details class="blk" id="growth-source-import"',
  );
  expect(context.window.agentUI.campaigns).not.toContain(
    'id="growth-source-import" open',
  );
});

test("actual Growth bridge renders unqualified sources and unsupported needs without fixture facts", async () => {
  const supplied = await fs.readFile("design/cue.html", "utf8");
  const detail = supplied.slice(
    supplied.indexOf("function gDetail("),
    supplied.indexOf("function gOpportunities("),
  );
  const adapter = await fs.readFile("lib/browser/growth.js", "utf8");
  const capabilityLookup = supplied.match(/const gCap = id =>[^\n]+/)![0];
  const writes: Record<string, unknown>[] = [];
  const data = {
    appId: "registered-app",
    capabilities: [
      {
        _id: "verified-cap",
        claims: [
          "Save a photo with a caption",
          "Find saved memories using all words",
        ],
        valid: true,
      },
    ],
    campaigns: [],
    drafts: [],
    touches: [
      {
        _id: "prepared-touch",
        opportunityId: "qualified-source",
        link: "https://cue.test/g/opaque",
        status: "unpublished",
      },
    ],
    browsers: [],
    reviewDeliveries: [],
    opportunities: [
      {
        _id: "discovered-source",
        author: "@tester",
        text: "Photo caption search request",
        sourceUrl: "https://x.test/source",
        status: "discovered",
        provenance: "Official read",
      },
      {
        _id: "unsupported-source",
        author: "@tester",
        text: "PDF request",
        sourceUrl: "https://x.test/unsupported",
        status: "needs-feature",
        need: "PDF export",
        reasons: ["No verified export"],
        provenance: "Official read",
      },
      {
        _id: "qualified-source",
        author: "@tester",
        text: "Find photo memories by caption",
        sourceUrl: "https://x.test/qualified",
        status: "qualified",
        capabilityId: "verified-cap",
        reasons: ["Caption search matches"],
        provenance: "Official read",
      },
    ],
  };
  const empty = () => "";
  const context = vm.createContext({
    S: {
      sec: "growth",
      ag: { appId: data.appId },
      growth: { opps: [], campaigns: [], capabilities: [] },
    },
    A: {},
    GA: {},
    G_TODO: ["qualified", "drafted", "awaiting", "approved"],
    fetch: async (_url: string, options?: RequestInit) => {
      if (options?.body) writes.push(JSON.parse(String(options.body)));
      return {
        ok: true,
        json: async () => (options?.body ? { ok: true } : data),
      };
    },
    toast: empty,
    gCur: () => null,
    setInterval: () => 1,
    loadWorkspace: async () => {},
    workspaceSignature: "",
    document: {
      activeElement: null,
      querySelectorAll: () => [],
      getElementById: () => null,
    },
    gDraftHtml: empty,
    gOpportunities: empty,
    gListHtml: empty,
    gFootHtml: empty,
    gCampaigns: empty,
    growthPage: empty,
    gRerender: empty,
    applyRoleControls: empty,
    gCapHtml: empty,
    gSteps: empty,
    gStepsHtml: empty,
    gPubHtml: empty,
    gStatusChip: empty,
    gFit: empty,
    gJourney: empty,
    esc: (v: unknown) => String(v || ""),
    ic: empty,
    av: empty,
    chIc: empty,
    rel: empty,
    hm: empty,
  });
  vm.runInContext(capabilityLookup + "\n" + detail + "\n" + adapter, context);
  await vm.runInContext("loadGrowth()", context);
  // The eager initial load may own the in-flight guard; wait its promise chain.
  await new Promise((resolve) => setImmediate(resolve));
  expect(vm.runInContext("G_TODO.includes('discovered')", context)).toBe(true);
  const discovered = vm.runInContext("gDetail(S.growth.opps[0])", context);
  expect(discovered).toContain("qualification pending");
  expect(discovered).toContain("matching awaits source qualification");
  expect(discovered).toContain("checks this source automatically");
  expect(discovered).not.toContain("Qualify source");
  expect(discovered).not.toContain("Not a product need");
  const unsupported = vm.runInContext("gDetail(S.growth.opps[1])", context);
  expect(unsupported).toContain("No verified capability answers this request");
  expect(unsupported).toContain("No feature or release is promised");
  expect(unsupported).toContain("Propose feature candidate");
  expect(vm.runInContext("gDraftHtml(S.growth.opps[2])", context)).toContain(
    "Growth is preparing a reply",
  );
  expect(
    vm.runInContext("gDraftHtml(S.growth.opps[2])", context),
  ).not.toContain('data-act="gFixed"');
  vm.runInContext("gCur = () => S.growth.opps[2]", context);
  await vm.runInContext("GA.gFixed()", context);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    action: "edit",
    appId: data.appId,
    opportunityId: "qualified-source",
  });
  expect(writes[0].text).toContain("all query words");
  expect(writes[0].text).toContain("https://cue.test/g/opaque");
  vm.runInContext("S.growth.capabilities[0].status = 'stale'", context);
  await vm.runInContext("GA.gFixed()", context);
  expect(writes).toHaveLength(1);
});
