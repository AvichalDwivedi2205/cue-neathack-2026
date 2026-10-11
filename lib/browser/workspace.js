/* Supplied screens backed by persisted coordinator and Agent threads. */
let workspaceBusy = false,
  workspaceSignature = "";
try {
  S.ag.appId = sessionStorage.getItem("cue-agent-app") || "";
} catch {}
function rememberWorkspaceApp(appId) {
  S.ag.appId = appId;
  try {
    sessionStorage.setItem("cue-agent-app", appId);
  } catch {}
}
function selectWorkspaceApp(appId) {
  rememberWorkspaceApp(appId);
  S.ag.connected = false;
  S.ag.convos = {};
  S.ag.tasks = [];
  S.ag.pendingKey = null;
  S.sub = "";
  workspaceSignature = "";
  growthData = null;
  growthSignature = "";
  S.growth.opps = [];
  S.growth.campaigns = [];
  S.growth.capabilities = [];
  agRefresh();
  loadWorkspace();
  loadGrowth();
}
agHealth = (a) => a.health;
async function workspaceAPI(body) {
  const response = await fetch("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Agent unavailable");
  return result;
}
async function loadWorkspace() {
  if (workspaceBusy) return;
  workspaceBusy = true;
  const requestedApp = S.ag.appId || "";
  try {
    const response = await fetch(
      "/api/agents" +
        (requestedApp ? "?app=" + encodeURIComponent(requestedApp) : ""),
      { cache: "no-store" },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (requestedApp !== (S.ag.appId || "")) return;
    const signature = JSON.stringify(data);
    if (signature !== workspaceSignature) {
      workspaceSignature = signature;
      S.ag.connected = true;
      rememberWorkspaceApp(data.app.id);
      S.ag.appName = data.app.name;
      S.ag.apps = data.apps;
      S.ag.agents = data.agents;
      S.ag.role = data.operator.role;
      OP.name = data.operator.name;
      OP.short = data.operator.name.split(" ")[0];
      OP.ini = data.operator.name
        .split(" ")
        .map((x) => x[0])
        .join("")
        .slice(0, 2);
      S.ag.tasks = data.tasks;
      S.ag.convos = Object.fromEntries(
        data.conversations.map((c) => [
          c.agent,
          c.messages.map((m) => ({
            who: m.role === "user" ? "op" : "agent",
            text: m.text.split("\n").filter(Boolean),
            t: m.at,
            via: m.via,
            ctx: m.context,
            act: m.answerStatus
              ? {
                  k: "none",
                  l:
                    m.answerStatus === "queued"
                      ? "Context answer queued"
                      : m.answerStatus === "failed"
                        ? "Recorded state · explanation unavailable"
                        : "Context answer from saved state",
                }
              : undefined,
            refs: [
              ...m.text.matchAll(
                /#\/agents\/(x|reddit|growth|engineering)\/([a-z0-9]+)/g,
              ),
            ].map((x) => ({ l: x[2], h: x[0] })),
          })),
        ]),
      );
      // Operator messages are plain text, assistant messages may be paragraphs.
      Object.values(S.ag.convos)
        .flat()
        .forEach((m) => {
          if (m.who === "op") m.text = m.text.join("\n");
        });
      agRefresh();
    }
  } catch (e) {
    if (requestedApp !== (S.ag.appId || "")) return;
    S.ag.connected = false;
    S.ag.error = e.message;
    S.ag.agents = S.ag.agents.map((a) => ({
      ...a,
      health: {
        st: "unknown",
        label: "Health unavailable",
        detail: "Workspace refresh failed. Saved state may be stale.",
      },
    }));
    if (["agents", "agent", "activity", "home"].includes(S.sec)) agRefresh();
  } finally {
    workspaceBusy = false;
  }
}
const designAgentsPage = agentsPage;
agentsPage = () =>
  designAgentsPage()
    .replace(
      "Agent conversations aren’t connected in this workspace yet",
      S.ag.connected
        ? "Ask about saved work, or give an instruction…"
        : "Agent connection unavailable",
    )
    .replace(
      /<span class="chip outline">([^<]|<[^>]+>)*?Bloom<\/span><label for="ag-ctx"/,
      `<select id="ag-app" aria-label="Application">${(S.ag.apps || []).map((a) => `<option value="${esc(a.id)}" ${a.id === S.ag.appId ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select><label for="ag-ctx"`,
    )
    .replace(
      '>Bloom</span><label for="ag-ctx"',
      `>${esc(S.ag.appName || "Bloom")}</span><label for="ag-ctx"`,
    )
    .replace("disabled>", S.ag.connected && !S.ag.typing ? ">" : "disabled>")
    .replace(
      /id="ag-send" disabled/,
      S.ag.connected && S.ag.draft.trim() && !S.ag.typing
        ? 'id="ag-send"'
        : 'id="ag-send" disabled',
    );
allTasks = () => S.ag.tasks;
agSend = async (text) => {
  const a = agentById(S.id) || S.ag.agents[0];
  text = String(text || "").trim();
  if (!text || !S.ag.connected || S.ag.typing) return;
  const context = JSON.stringify({
    app: S.ag.appId,
    agent: a.id,
    text,
    task: S.sub,
  });
  const key =
    S.ag.pendingContext === context && S.ag.pendingKey
      ? S.ag.pendingKey
      : crypto.randomUUID();
  S.ag.pendingContext = context;
  S.ag.pendingKey = key;
  S.ag.typing = a.id;
  agRefresh();
  try {
    await workspaceAPI({
      agent: a.id,
      appId: S.ag.appId,
      text,
      key,
      ...(S.sub ? { taskId: S.sub } : {}),
    });
    S.ag.draft = "";
    S.ag.pendingKey = null;
    workspaceSignature = "";
    await loadWorkspace();
  } catch (e) {
    toast(e.message, "fail");
  } finally {
    S.ag.typing = null;
    agRefresh();
  }
};
A.agSend = () => agSend(S.ag.draft);
A.agSugg = (el) => agSend(el.dataset.v);
A.tkCancel = async (el) => {
  try {
    await workspaceAPI({
      action: "cancel",
      appId: S.ag.appId,
      taskId: el.dataset.id,
    });
    workspaceSignature = "";
    await loadWorkspace();
  } catch (e) {
    toast(e.message, "fail");
  }
};
A.tkRetry = () =>
  toast(
    "Use explicit collection instruction. Review uncertain external outcomes first.",
    "info",
  );
loadWorkspace();
document.addEventListener("change", (e) => {
  if (e.target.id !== "ag-app") return;
  selectWorkspaceApp(e.target.value);
});
setInterval(() => {
  if (!document.hidden) loadWorkspace();
}, 5000);
// Live task fields include actual review and dependency references.
tv = (t) => ({
  ...t,
  events: t.events || [],
  evidence: t.evidence || [],
  sources: t.sources || [],
  owner: agentById(t.agent)?.name || t.owner,
});
A.tkRetry = async (el) => {
  const t = taskById(el.dataset.id);
  try {
    if (
      t.agent === "growth" &&
      ["discover", "qualify", "draft"].includes(t.type)
    )
      await growthAction(t.type, {
        opportunityId: t.opportunityId,
        campaignId: t.campaignId,
      });
    else if (t.agent === "x")
      await workspaceAPI({ action: "retry", appId: S.ag.appId, taskId: t.id });
    else if (t.agent === "engineering" && t.issueId)
      await workspaceAPI({
        agent: t.agent,
        appId: S.ag.appId,
        issueId: t.issueId,
        text:
          t.type === "delegate"
            ? "Delegate approved specification"
            : "Investigate this issue",
        key: crypto.randomUUID(),
      });
    else {
      toast(
        "Select supported original action; prior evidence retained.",
        "info",
      );
      return;
    }
    workspaceSignature = "";
    await loadWorkspace();
  } catch (e) {
    toast(e.message, "fail");
  }
};
const originalLiveTaskPanel = taskPanel;
taskPanel = (t) =>
  originalLiveTaskPanel(t).replace(" Bloom</dd>", " " + esc(t.app) + "</dd>") +
  (t.children?.length
    ? `<div class="tk-sec"><h6>Child work</h6>${t.children.map((r) => refBtn(r)).join("")}</div>`
    : "");
const originalLiveApprovals = approvals;
approvals = () =>
  originalLiveApprovals().filter((a) =>
    a.kind === "growth"
      ? ["owner", "product"].includes(S.ag.role)
      : a.kind === "spec"
        ? ["owner", "product"].includes(S.ag.role)
        : ["owner", "engineering"].includes(S.ag.role),
  );
const originalLiveHome = homePage;
homePage = () =>
  originalLiveHome() +
  `<div class="callout">Saved role: ${esc(S.ag.role || "loading")}. Exact approvals for your role appear in the top review menu.</div>`;
const originalLiveAgentPage = agentPage;
agentPage = () =>
  originalLiveAgentPage().replace(
    '<div class="ta" id="ta-list">',
    `<div class="ta-bar"><label>Application <select id="ta-app" aria-label="Activity application">${(S.ag.apps || []).map((a) => `<option value="${esc(a.id)}" ${a.id === S.ag.appId ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label><label>Time <select id="ta-time" aria-label="Activity time"><option value="0">All time</option><option value="86400000" ${S.ag.af.time === 86400000 ? "selected" : ""}>Past day</option><option value="604800000" ${S.ag.af.time === 604800000 ? "selected" : ""}>Past week</option></select></label></div><div class="ta" id="ta-list">`,
  );
const taskFilterBase = taRows;
taRows = () => {
  const all = allTasks;
  const q = S.ag.af.q.trim().toLowerCase();
  allTasks = () =>
    all().filter(
      (t) =>
        (!S.ag.af.time || lastT(t) > Date.now() - S.ag.af.time) &&
        (!q ||
          (
            t.id +
            " " +
            t.title +
            " " +
            (t.issueId || "") +
            " " +
            (t.opportunityId || "") +
            " " +
            JSON.stringify(t.sources)
          )
            .toLowerCase()
            .includes(q)),
    );
  const oldQuery = S.ag.af.q;
  S.ag.af.q = "";
  try {
    return taskFilterBase();
  } finally {
    S.ag.af.q = oldQuery;
    allTasks = all;
  }
};
document.addEventListener("change", (e) => {
  if (e.target.id === "ta-time") {
    S.ag.af.time = Number(e.target.value);
    renderMain(false);
  }
  if (e.target.id === "ta-app") {
    selectWorkspaceApp(e.target.value);
  }
});

const liveAgentRefresh = agRefresh;
agRefresh = () => {
  const el = document.activeElement;
  const focused = el?.id === "ag-ta",
    start = focused ? el.selectionStart : null,
    end = focused ? el.selectionEnd : null;
  liveAgentRefresh();
  if (focused) {
    const restored = document.getElementById("ag-ta");
    if (restored) {
      restored.focus({ preventScroll: true });
      restored.setSelectionRange(start, end);
    }
  }
};
