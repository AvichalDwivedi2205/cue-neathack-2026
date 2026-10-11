/* Growth screens retain supplied design; all state comes from server records. */
if (!G_TODO.includes("discovered")) G_TODO.unshift("discovered");
let growthLoading = false,
  growthSignature = "",
  growthData = null;
const growthApp = () => S.ag.appId || "";
async function loadGrowth() {
  if (growthLoading) return;
  growthLoading = true;
  const requestedApp = growthApp();
  try {
    const r = await fetch(
      "/api/growth" +
        (requestedApp ? "?app=" + encodeURIComponent(requestedApp) : ""),
      { cache: "no-store" },
    );
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    if (requestedApp !== growthApp()) return;
    const signature = JSON.stringify(d);
    if (signature !== growthSignature) {
      growthSignature = signature;
      growthData = d;
      S.growth.state = "populated";
      S.growth.capabilities = d.capabilities.map((c) => ({
        id: c._id,
        title: c.name,
        claim: c.claims.join(" "),
        release: c.release,
        by: c.verifiedBy || "Deployed acceptance",
        verifiedAt: c.checkedAt,
        check: c.evidence,
        status: c.valid ? "valid" : "stale",
        staleWhy: "Release changed. Acceptance check required.",
      }));
      S.growth.campaigns = d.campaigns.map((c) => ({
        id: c._id,
        title: c.name,
        cap: c.capabilityId,
        sources: ["Official X recent search"],
        queries: [c.query],
        goal: "New browser saves first memory, then finds it by caption",
        budget: {
          used:
            c.budgetDay === new Date().toISOString().slice(0, 10) ? c.used : 0,
          limit: c.dailyLimit,
        },
        paused: c.paused,
        lastRun: c.lastRunAt,
        lastRead: "up to 10",
        error: c.lastError,
      }));
      const previous = new Map(S.growth.opps.map((o) => [o.id, o]));
      S.growth.opps = d.opportunities.map((o) => {
        const draft = d.drafts
          .filter((x) => x.opportunityId === o._id)
          .sort((a, b) => b.version - a.version)[0];
        const touch = d.touches
          .filter((x) => x.opportunityId === o._id)
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        const browsers = d.browsers.filter((b) => b.touchId === touch?._id);
        const browser = browsers
          .filter((b) => b.confirmedAt)
          .sort(
            (a, b) =>
              !!(b.activatedAt && b.savedAt && b.savedAt <= b.activatedAt) -
                !!(a.activatedAt && a.savedAt && a.savedAt <= a.activatedAt) ||
              (b.savedAt || 0) - (a.savedAt || 0),
          )[0];
        const delivery =
          draft && d.reviewDeliveries.find((r) => r.draftId === draft._id);
        const old = previous.get(o._id);
        return {
          id: o._id,
          ch: o.channel,
          name: o.author,
          author: o.author,
          ini: o.author.replace("@", "").slice(0, 2).toUpperCase(),
          color: "#1E7A53",
          t: o.sourceAt,
          url: o.sourceUrl,
          text: o.text,
          need: o.need || "Awaiting qualification",
          fit: o.fit,
          reasons: o.reasons || ["Source saved; qualification pending."],
          cap: o.capabilityId,
          fr: o.featureIssueId,
          status:
            o.status === "awaiting-review"
              ? "awaiting"
              : o.status === "publication-recorded"
                ? "approved"
                : o.status,
          controlled: o.controlled,
          sample: false,
          draft: draft && {
            id: draft._id,
            text: draft.text,
            hash: draft.hash,
            version: draft.version,
          },
          editText: old?.draft?.id === draft?._id ? old?.editText : undefined,
          changes:
            draft?.status === "rejected"
              ? "Product requested changes. Save a new draft version, then request review."
              : undefined,
          review: draft && {
            requested: draft.requestedAt,
            reviewer: "Product",
            via: delivery
              ? "Slack " +
                delivery.status +
                (delivery.receipt ? " · " + delivery.receipt : "")
              : "Cue",
            by: draft.reviewer,
            at: draft.reviewedAt,
            hash: draft.hash,
          },
          pub:
            touch && touch.status !== "unpublished"
              ? {
                  state:
                    touch.status === "verified"
                      ? "verified"
                      : touch.status === "failed"
                        ? "failed"
                        : "reported",
                  url: touch.publicationUrl,
                  draftUrl: touch.publicationUrl,
                  at: touch.publishedAt,
                  method: touch.verification,
                  error: touch.verification,
                }
              : null,
          link: touch?.link,
          j: {
            click: touch?.lastClickAt || null,
            visit: browser?.confirmedAt,
            saved:
              browser?.savedAt && browser.confirmedAt <= browser.savedAt
                ? browser.savedAt
                : null,
            activated:
              browser?.activatedAt &&
              browser.savedAt &&
              browser.confirmedAt <= browser.savedAt &&
              browser.savedAt <= browser.activatedAt
                ? browser.activatedAt
                : null,
          },
          provenance: o.provenance,
        };
      });
      if (["growth", "home"].includes(S.sec)) gRerender();
    }
  } catch {
    if (requestedApp !== growthApp()) return;
    S.growth.state = "error";
    if (S.sec === "growth") gRerender();
  } finally {
    growthLoading = false;
  }
}
async function growthAction(action, args = {}) {
  if (!growthData || growthData.appId !== growthApp())
    throw new Error(
      "Wait for the selected application to refresh, then retry.",
    );
  const r = await fetch("/api/growth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action,
      appId: growthData?.appId || growthApp(),
      ...args,
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Growth request failed");
  growthSignature = "";
  await loadGrowth();
  workspaceSignature = "";
  await loadWorkspace();
  return d;
}
async function growthFor(action, args = {}) {
  const o = gCur();
  if (!o) return;
  try {
    const result = await growthAction(action, {
      opportunityId: o.id,
      ...(o.draft ? { draftId: o.draft.id, hash: o.draft.hash } : {}),
      ...args,
    });
    toast(
      result.taskId ? "Work queued · inspect Agent Activity" : "Saved",
      "ok",
    );
  } catch (e) {
    toast(e.message, "fail");
  }
}
gLink = (o) => o.link || "Campaign link not prepared";
gEdit = (v) => {
  const o = gCur();
  if (!o?.draft) return;
  o.editText = v;
  const length = $("#g-len");
  if (length) {
    length.textContent = v.length + "/280";
    length.classList.toggle("over", v.length > 280);
  }
  if ($("#g-hash"))
    $("#g-hash").textContent = "Unsaved edits · Save before review";
};
const suppliedDraftHtml = gDraftHtml;
gDraftHtml = (o) => {
  if (!o.draft && o.status === "qualified")
    return '<div class="g-none">Growth is preparing a reply from the verified feature. It will appear here for your review.</div>';
  return (
    suppliedDraftHtml(o)
      .replace(
        esc(o.draft?.text || "") + "</textarea>",
        esc(o.editText ?? o.draft?.text ?? "") + "</textarea>",
      )
      .replace(
        "campaign link added when copied",
        "complete link included in reviewed text",
      )
      .replace(/\d+\/280/, o.draft ? o.draft.text.length + "/280" : "0/280")
      .replace(
        "draft #" + o.draft?.hash,
        "draft v" +
          (o.draft?.version || 0) +
          " · " +
          o.draft?.hash.slice(0, 12),
      ) +
    (o.draft && o.status !== "published"
      ? '<button class="btn sm" data-act="gSave">Save edited draft</button>'
      : "")
  );
};
const suppliedGrowthFoot = gFootHtml;
gFootHtml = (o) =>
  o.status === "discovered"
    ? '<span class="note">Growth checks this source automatically, then prepares a reply if it matches.</span><a class="btn sm" href="#/agents/growth">View agent</a>'
    : o.status === "qualified"
      ? '<span class="note">Growth is preparing a reply for your review.</span><button class="btn" data-act="gDismiss">Dismiss</button>'
      : suppliedGrowthFoot(o);
const suppliedCampaigns = gCampaigns;
gCampaigns = () => {
  let html =
    suppliedCampaigns()
      .replaceAll(
        /≈ \$[^<]+ in post reads/g,
        "10 reads reserved per bounded page",
      )
      .replaceAll("Last successful run", "Last successful search")
      .replaceAll(rel(undefined) + " ago · up to 10 posts read", "Not yet run")
      .replaceAll("up to 10 posts read", "bounded page · 10 reads reserved") +
    S.growth.campaigns
      .filter((c) => c.error)
      .map(
        (c) =>
          `<div class="callout">${esc(c.error)} · Retry remains available after cooldown.</div>`,
      )
      .join("");
  for (const c of S.growth.campaigns) {
    const query = c.queries[0];
    html = html.replace(
      `<span class="g-qc">${esc(query)}</span>`,
      `<div><span class="g-qc">${esc(query)}</span><details><summary>Edit discovery query</summary><label for="growth-query-${c.id}">X recent-search query</label><textarea class="inp" id="growth-query-${c.id}" maxlength="500" rows="3">${esc(query)}</textarea><button class="btn sm" data-act="gQuery" data-id="${c.id}">Save query</button><small>Starts a fresh search checkpoint. Saved sources and today's budget remain. Schedule pauses.</small></details></div>`,
    );
  }
  return (
    html
      .replaceAll("Daily schedule", "Automatic discovery")
      .replaceAll(
        "Off. Run now does one bounded search.",
        "Paused. Run now finds, qualifies and drafts in one pass.",
      )
      .replaceAll(
        "One bounded search per day, within budget.",
        "Finds recent requests daily, qualifies them and prepares replies for review.",
      ) +
    `<details class="blk" id="growth-source-import" style="margin-top:16px"><summary class="blk-h">Import a source (optional)</summary><div class="blk-b"><p>Growth discovers X posts automatically. Use this only for a source you already have. Imported sources keep assisted provenance.</p><div class="field"><label for="growth-source">Original source URL</label><input class="inp" id="growth-source" placeholder="https://x.com/handle/status/…"></div><details><summary>Reddit supplied text · API unavailable</summary><div class="field"><label for="growth-author">Source author</label><input class="inp" id="growth-author"></div><div class="field"><label for="growth-source-text">Original text</label><textarea class="inp" id="growth-source-text" maxlength="1200"></textarea></div></details><button class="btn sm" data-act="gCapture">Import source</button></div></details>`
  );
};
function growthAgentStatus() {
  const c = S.growth.campaigns[0];
  if (!c) return "";
  const pending = S.growth.opps.filter((o) =>
    ["discovered", "qualified"].includes(o.status),
  ).length;
  const full = c.budget.used + 10 > c.budget.limit;
  const state = c.paused
    ? "Paused"
    : c.error
      ? "Needs attention"
      : full
        ? "Daily limit reached"
        : "Monitoring X";
  const next = c.paused
    ? "Start once. Growth finds requests and prepares replies automatically."
    : full
      ? "Today's discovery limit is reached. The agent resumes after the daily budget resets at 00:00 UTC."
      : "One bounded search per day. Free-credit and capability checks run before work starts.";
  return `<div class="blk" data-testid="growth-agent-status" style="margin-bottom:20px"><div class="blk-h">${ic("sparkle", 15, "var(--accent)")}Growth agent<span class="r"><span class="chip ${c.paused ? "outline" : "ok"}">${state}</span><button class="btn ${c.paused ? "primary" : ""} sm" data-act="gPause" data-id="${c.id}">${c.paused ? "Start agent" : "Pause agent"}</button></span></div><div class="blk-b"><p>Finds recent X requests, checks them against verified features and drafts useful replies. You review before anything is published.</p><small>${esc(next)}${pending ? ` ${pending} source${pending === 1 ? "" : "s"} awaiting agent processing.` : ""}</small></div></div>`;
}
const suppliedGrowthList = gListHtml;
gListHtml = (selected) =>
  suppliedGrowthList(selected).replace(
    "Nothing waiting. Run the campaign to look for new requests.",
    "Nothing waiting. Growth checks for matching requests automatically.",
  );
const suppliedGrowthPage = growthPage;
growthPage = () =>
  suppliedGrowthPage()
    .replace(
      "Explicit requests your verified features answer. Every reply is reviewed and posted by a person.",
      "Growth finds requests and prepares replies. You review and publish.",
    )
    .replace("</nav>", "</nav>" + growthAgentStatus()) +
  (growthData?.releaseHealth
    ? `<div class="callout">${esc(growthData.releaseHealth)}</div>`
    : "");
const suppliedGrowthDetail = gDetail;
gDetail = (o) =>
  suppliedGrowthDetail(o)
    .replace("X recent search", esc(o.provenance))
    .replace("source with recorded provenance", esc(o.provenance));
const suppliedGrowthOpportunities = gOpportunities;
gOpportunities = () =>
  suppliedGrowthOpportunities()
    .replace("Select an opportunity", "No replies ready for review")
    .replace(
      "Each one shows the source need, the verified capability and the proposed reply.",
      "Growth checks new sources automatically. Replies appear here when ready; filtered posts remain in Dismissed and unmet needs in Unmet.",
    );
const suppliedCapabilityHtml = gCapHtml;
gCapHtml = (o) => {
  if (o.status === "discovered")
    return '<div class="g-none">Capability matching awaits source qualification.</div>';
  if (o.status === "needs-feature" && !o.cap && !o.fr)
    return '<div class="g-cap nf"><div class="cb"><div class="ct"><b>No verified capability answers this request</b><span class="chip violet">Needs feature</span></div><p>Product review can consider this need. No feature or release is promised.</p></div></div>';
  return suppliedCapabilityHtml(o);
};
// Metrics count browsers, not opportunities. Ordered milestones required even after out-of-order delivery.
gResults = () => {
  if (!growthData) return '<div class="empty">Loading results…</div>';
  const d = growthData;
  const organicTouchIds = new Set(
    d.touches
      .filter(
        (t) =>
          t.status === "verified" &&
          !d.opportunities.find((o) => o._id === t.opportunityId)?.controlled,
      )
      .map((t) => t._id),
  );
  const browsers = d.browsers.filter(
    (b) => organicTouchIds.has(b.touchId) && !b.internal && !b.returning,
  );
  const visits = browsers.filter((b) => b.confirmedAt).length;
  const activated = browsers.filter(
    (b) =>
      b.confirmedAt &&
      b.savedAt &&
      b.activatedAt &&
      b.confirmedAt <= b.savedAt &&
      b.savedAt <= b.activatedAt,
  ).length;
  const org = d.opportunities.filter((o) => !o.controlled);
  const cells = [
    ["Discovered", org.length],
    ["Qualified", org.filter((o) => o.eligible).length],
    [
      "Approved",
      org.filter((o) =>
        d.drafts.some(
          (x) =>
            x.opportunityId === o._id &&
            x.status === "approved" &&
            x._id === S.growth.opps.find((y) => y.id === o._id)?.draft?.id,
        ),
      ).length,
    ],
    ["Published", organicTouchIds.size],
    ["Visits", visits],
    ["Activated", activated],
  ];
  const touches = S.growth.opps.filter((o) => o.pub?.state === "verified");
  return `<div class="g-funnel">${cells.map(([label, n]) => `<div class="g-fc"><b>${n}</b><span>${label}</span></div>`).join("")}</div><div class="g-excl">Controlled/internal traffic excluded. Returning browsers: ${d.browsers.filter((b) => b.returning && b.confirmedAt).length}. Snapshot bounded to latest 100 opportunities and 1,000 browsers.</div><p class="g-none">Campaign attribution identifies browsers, not social authors or purchase intent.</p>${touches.length ? touches.map(gJourney).join("") : '<div class="empty">No independently verified publication yet.</div>'}`;
};
Object.assign(GA, {
  gDraft: () => growthFor("draft"),
  gFixed: () => {
    const o = gCur(),
      cap = o && gCap(o.cap);
    if (
      !o?.link ||
      cap?.status !== "valid" ||
      !/photo.*caption/i.test(cap.claim) ||
      !/all (?:query )?words/i.test(cap.claim)
    ) {
      toast(
        "A current verified capability and campaign link are required",
        "info",
      );
      return;
    }
    return growthFor("edit", {
      text:
        (S.ag.appName || "Bloom") +
        " lets you save a photo with a caption, then find it using all query words in the saved caption. " +
        o.link,
    });
  },
  gQualify: () => growthFor("qualify"),
  gSave: () =>
    growthFor("edit", { text: gCur()?.editText ?? $("#g-draft")?.value }),
  gRequest: async () => {
    const o = gCur();
    if (o?.editText !== undefined && o.editText !== o.draft.text) {
      toast("Save edited draft before requesting exact review", "info");
      return;
    }
    await growthFor("requestReview");
  },
  gApprove: () => growthFor("approve"),
  gChanges: () => growthFor("reject"),
  gDismiss: () => growthFor("dismiss"),
  gRestore: () => growthFor("restore"),
  gRecord: () => growthFor("record", { url: $("#g-url")?.value.trim() }),
  gCopy: async () => {
    try {
      await navigator.clipboard.writeText(gCur().draft.text);
      toast("Exact reviewed text copied", "ok");
    } catch {
      toast("Copy unavailable; select exact reply text", "info");
    }
  },
  gRun: async (el) => {
    try {
      await growthAction("discover", { campaignId: el.dataset.id });
      toast("Bounded discovery queued", "ok");
    } catch (e) {
      toast(e.message, "fail");
    }
  },
  gPause: async (el) => {
    const c = S.growth.campaigns.find((c) => c.id === el.dataset.id);
    try {
      await growthAction("pause", { campaignId: c.id, paused: !c.paused });
      toast(
        c.paused
          ? "Growth agent started · replies arrive for review"
          : "Automatic discovery paused · queued work can finish",
        "ok",
      );
    } catch (e) {
      toast(e.message, "fail");
    }
  },
  gQuery: async (el) => {
    try {
      await growthAction("query", {
        campaignId: el.dataset.id,
        query: $("#growth-query-" + el.dataset.id).value.trim(),
      });
      toast("Query saved · schedule paused · budget preserved", "ok");
    } catch (e) {
      toast(e.message, "fail");
    }
  },
  gRetry: () => loadGrowth(),
});
Object.assign(A, GA);
loadGrowth();
setInterval(() => {
  if (!document.hidden && ["growth", "home", "agents", "agent"].includes(S.sec))
    loadGrowth();
}, 5000);
const liveGrowthFooter = gFootHtml;
gFootHtml = (o) =>
  liveGrowthFooter(o) +
  (o.status === "needs-feature" && !o.fr
    ? '<button class="btn violet" data-act="gFeature">Propose feature candidate</button>'
    : "");
Object.assign(A, {
  gFeature: () => growthFor("feature"),
  gCapture: async () => {
    try {
      await growthAction("capture", {
        source: {
          url: $("#growth-source").value.trim(),
          ...($("#growth-source-text").value.trim()
            ? {
                text: $("#growth-source-text").value.trim(),
                author: $("#growth-author").value.trim(),
              }
            : {}),
        },
      });
      toast("Source saved with provenance", "ok");
    } catch (e) {
      toast(e.message, "fail");
    }
  },
});
const oldRoleControls = applyRoleControls;
applyRoleControls = () => {
  oldRoleControls();
  const role = S.ag.role || S.integrations?.role;
  for (const b of document.querySelectorAll("button[data-act]")) {
    const act = b.dataset.act;
    if (
      ([
        "gDraft",
        "gFixed",
        "gQualify",
        "gSave",
        "gRequest",
        "gApprove",
        "gChanges",
        "gDismiss",
        "gRestore",
        "gRun",
        "gPause",
        "gCapture",
        "gFeature",
        "gQuery",
      ].includes(act) &&
        !["owner", "product"].includes(role)) ||
      (act === "gRecord" && role !== "owner")
    ) {
      b.disabled = true;
      b.title = "Your saved role cannot perform this action";
    }
  }
};

gRevHtml = (o) => {
  if (!o.review) return "";
  if (o.status === "awaiting")
    return `<div class="g-rev">Exact Product review requested${o.review.requested ? " · " + rel(o.review.requested) + " ago" : ""} · ${esc(o.review.via)}</div>`;
  if (["approved", "published"].includes(o.status))
    return `<div class="g-rev ok">Approved by ${esc(o.review.by)} · ${hm(o.review.at)} · draft ${esc(o.review.hash.slice(0, 12))}</div>`;
  return "";
};
const liveGrowthRender = gRerender;
gRerender = () => {
  const el = document.activeElement;
  const id = el?.id;
  const focused =
    [
      "g-draft",
      "g-url",
      "growth-source",
      "growth-author",
      "growth-source-text",
    ].includes(id) || id?.startsWith("growth-query-");
  const value = focused ? el.value : null,
    start = focused ? el.selectionStart : null,
    end = focused ? el.selectionEnd : null;
  liveGrowthRender();
  if (focused) {
    const restored = document.getElementById(id);
    if (restored) {
      for (
        let details = restored.closest("details");
        details;
        details = details.parentElement?.closest("details")
      )
        details.open = true;
      restored.value = value;
      restored.focus({ preventScroll: true });
      if (start !== null) restored.setSelectionRange(start, end);
    }
  }
};

gJourney = (o) => {
  const j = o.j || {};
  const rows = [
    ["Original source", o.provenance, o.t],
    ["Exact reply approved", o.review?.by, o.review?.at],
    [
      "Publication verified",
      o.pub?.method,
      o.pub?.state === "verified" && o.pub.at,
    ],
    ["Redirect click", "Preview clicks are not visits", j.click],
    ["Confirmed Bloom session", "Signed, attributed guest browser", j.visit],
    [
      "First memory saved",
      "Private Bloom mutation; no caption or photo shared",
      j.saved,
    ],
    [
      "Found through caption search",
      "Same browser and first saved memory; ordered server events",
      j.activated,
    ],
  ];
  return `<div class="blk"><div class="blk-h">${esc(o.author)}${o.controlled ? '<span class="chip outline">Controlled · excluded</span>' : ""}</div><div class="blk-b"><div class="stepper">${rows.map(([label, detail, at]) => `<div class="st ${at ? "done" : "todo"}"><span class="sn">${at ? ic("check", 10, "#fff") : ""}</span><div class="stl">${label}${at ? " · " + hm(at) : " · pending"}<small>${esc(detail || "")}</small></div></div>`).join("")}</div><p>One attributed browser journey shown. Browsers do not identify social authors. No retention measurement claimed.</p></div></div>`;
};

// Demonstration figures never enter Growth records, agent context or attribution.
const growthDemoFields = [
  ["discovered", "Discovered"],
  ["qualified", "Qualified"],
  ["approved", "Approved"],
  ["published", "Published"],
  ["visits", "Visits"],
  ["activated", "Activated"],
];
const growthDemoDefaults = {
  discovered: 48,
  qualified: 12,
  approved: 8,
  published: 6,
  visits: 24,
  activated: 7,
};
const growthDemoStates = new Map();
function growthDemoValid(counts) {
  return (
    counts &&
    growthDemoFields.every(
      ([key]) =>
        Number.isInteger(counts[key]) &&
        counts[key] >= 0 &&
        counts[key] <= 1000000,
    ) &&
    counts.qualified <= counts.discovered &&
    counts.approved <= counts.qualified &&
    counts.published <= counts.approved &&
    counts.activated <= counts.visits &&
    (counts.published > 0 || counts.visits === 0)
  );
}
function growthDemoState() {
  const appId = growthApp();
  if (!growthDemoStates.has(appId)) {
    let counts = { ...growthDemoDefaults };
    try {
      const saved = JSON.parse(
        localStorage.getItem("cue:growth-demo:" + appId),
      );
      if (growthDemoValid(saved)) counts = saved;
    } catch {
      /* Browser storage is optional; live results remain available. */
    }
    growthDemoStates.set(appId, { show: false, counts });
  }
  return growthDemoStates.get(appId);
}
const liveGrowthResults = gResults;
gResults = () => {
  const { show, counts } = growthDemoState();
  const views = `<div class="seg-ctl" role="tablist" aria-label="Result view" style="margin-bottom:16px"><button role="tab" aria-selected="${!show}" class="${show ? "" : "on"}" data-act="gResultView" data-v="live">Live results</button><button role="tab" aria-selected="${show}" class="${show ? "on" : ""}" data-act="gResultView" data-v="demo">Demo scenario</button></div>`;
  if (!show) return views + liveGrowthResults();
  return (
    views +
    `<div class="blk" data-testid="growth-demo-scenario"><div class="blk-h">Demo scenario<span class="chip sample">Sample numbers</span></div><div class="blk-b"><p>Manually entered figures for a product walkthrough. These are illustrative, not observed growth.</p><div class="g-funnel">${growthDemoFields.map(([key, label]) => `<div class="g-fc ${key === "activated" ? "hl" : ""}"><b>${counts[key]}</b><span>${label}</span><small>Demo figure</small></div>`).join("")}</div><p class="g-excl">${counts.visits ? ((counts.activated / counts.visits) * 100).toFixed(1) : "0"}% sample visit-to-activation rate. Real source posts appear in Opportunities; this scenario does not describe their outcomes.</p><details id="growth-demo-editor"><summary>Edit demo numbers</summary><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:12px 0">${growthDemoFields.map(([key, label]) => `<div><label for="growth-demo-${key}">${label}</label><input class="inp" id="growth-demo-${key}" type="number" min="0" max="1000000" step="1" value="${counts[key]}"></div>`).join("")}</div><button class="btn sm" data-act="gDemoSave">Save demo numbers</button><button class="btn sm" data-act="gDemoReset">Reset example</button><small>Saved only in this browser for this application. Reload opens Live results.</small></details></div></div>`
  );
};
Object.assign(A, {
  gResultView: (el) => {
    growthDemoState().show = el.dataset.v === "demo";
    gRerender();
  },
  gDemoSave: () => {
    const counts = Object.fromEntries(
      growthDemoFields.map(([key]) => {
        const value = $("#growth-demo-" + key).value.trim();
        return [key, /^\d+$/.test(value) ? Number(value) : NaN];
      }),
    );
    if (!growthDemoValid(counts)) {
      toast(
        "Use whole counts: discovered ≥ qualified ≥ approved ≥ published; visits ≥ activated. Visits need a publication.",
        "info",
      );
      return;
    }
    growthDemoState().counts = counts;
    try {
      localStorage.setItem(
        "cue:growth-demo:" + growthApp(),
        JSON.stringify(counts),
      );
    } catch {
      toast(
        "Demo numbers kept for this page; browser storage unavailable",
        "info",
      );
    }
    $("#growth-demo-editor").open = false;
    gRerender();
  },
  gDemoReset: () => {
    growthDemoState().counts = { ...growthDemoDefaults };
    try {
      localStorage.removeItem("cue:growth-demo:" + growthApp());
    } catch {
      /* Optional storage. */
    }
    $("#growth-demo-editor").open = false;
    gRerender();
  },
});
const growthResultRender = gRerender;
gRerender = () => {
  const editor = document.getElementById("growth-demo-editor");
  const open = editor?.open;
  const values = open
    ? growthDemoFields.map(([key]) => [key, $("#growth-demo-" + key)?.value])
    : [];
  growthResultRender();
  const restored = document.getElementById("growth-demo-editor");
  if (open && restored) {
    restored.open = true;
    for (const [key, value] of values) {
      const input = $("#growth-demo-" + key);
      if (input && value !== undefined) input.value = value;
    }
  }
};
