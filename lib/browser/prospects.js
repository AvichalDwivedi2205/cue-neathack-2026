// Company research is for Cue's own buyers, independent of the selected app's Growth replies.
let prospectData = null,
  prospectLoading = false,
  prospectBusy = false,
  prospectLoaded = false;
let prospectQuery =
  "Small companies building consumer mobile apps for journaling, habits, wellness or personal productivity";
let prospectFilter = "all",
  prospectError = "";
const prospectActive = () => S.sec === "growth" && S.growth.tab === "prospects";
function prospectRender() {
  if (prospectActive()) renderMain(false);
}
async function loadProspects() {
  if (prospectLoading) return;
  prospectLoading = true;
  try {
    const r = await fetch("/api/prospects", { cache: "no-store" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load company research");
    prospectData = d;
    prospectError = "";
  } catch (e) {
    prospectError = e.message;
  } finally {
    prospectLoading = false;
    prospectLoaded = true;
    prospectRender();
  }
}
const prospectPriorGrowth = growthPage;
growthPage = () => {
  if (!prospectActive()) return prospectPriorGrowth();
  if (!prospectLoaded && !prospectLoading) queueMicrotask(loadProspects);
  const d = prospectData,
    companies = d?.companies || [],
    latest = d?.runs[0];
  const running =
    latest?.state === "running" && Date.now() - latest.createdAt < 120000;
  const disabled = prospectBusy || running || !d?.configured || !d?.canResearch;
  const rows = companies.filter(
    (c) => prospectFilter === "all" || c.disposition === prospectFilter,
  );
  const tabs = [
    ["Opportunities", "#/growth"],
    ["Campaigns", "#/growth/campaigns"],
    ["Results", "#/growth/results"],
    ["Cue customers", "#/growth/prospects"],
  ];
  return `<div class="page g-page enter prospect-page" style="max-width:1240px">
    <style>.prospect-page .r{display:flex;align-items:center;gap:8px}.prospect-page .muted{color:var(--ink-3)}.prospect-page .blk-h>.muted{margin-left:auto;font-weight:400;font-size:12px}.prospect-page ul{margin:7px 0 0;padding-left:19px}.prospect-page .seg-ctl{width:auto;flex-wrap:wrap}.prospect-page .seg-ctl button{flex:0 0 auto;padding:0 12px;height:28px;white-space:nowrap}.prospect-page p{overflow-wrap:anywhere}</style>
    <div class="page-h"><div><h1>Cue customers</h1><p>Research small consumer-app teams that could benefit from Cue.</p></div><span class="chip ${d?.configured ? "ok" : "outline"}">Crustdata ${d?.configured ? "connected" : d ? "not configured" : "loading…"}</span></div>
    <nav class="g-tabs" aria-label="Growth">${tabs.map(([l, h]) => `<a href="${h}" class="${h.endsWith("prospects") ? "on" : ""}">${l}</a>`).join("")}</nav>
    <div class="blk"><div class="blk-h"><b>Find potential buyers</b><span class="muted">Company research for Cue</span></div><div class="blk-b" style="display:grid;gap:12px">
      <label for="prospect-query">Describe the companies to research</label>
      <textarea id="prospect-query" class="inp" style="min-height:66px;width:100%;resize:vertical" minlength="10" maxlength="400" ${prospectBusy ? "disabled" : ""}>${esc(prospectQuery)}</textarea>
      <div class="r" style="justify-content:space-between;flex-wrap:wrap;gap:12px"><span class="muted">Up to 5 companies · 15-credit ceiling per search · 5 searches per day (UTC)</span><button class="btn primary" data-act="prospectSearch" ${disabled ? "disabled" : ""}>${prospectBusy || running ? "Researching…" : "Find companies"}</button></div>
      ${!d?.canResearch && d ? '<p class="muted">An Owner or Product member can search and review companies.</p>' : ""}
      <p class="muted" style="margin:0">Product and team-size fit are research signals. Buying intent, feedback volume and willingness to pay still need validation.</p>
      ${prospectError ? `<div role="alert">${esc(prospectError)}</div>` : ""}
      ${latest ? `<div class="callout">Last search: ${esc(latest.state)} · ${latest.count} companies · ${latest.usedCredits === null ? "usage not reported" : esc(latest.usedCredits.toFixed(2)) + " credits reported"} · ${esc(new Date(latest.createdAt).toLocaleString())}${latest.warning ? `<p>${esc(latest.warning)}</p>` : ""}</div>` : ""}
    </div></div>
    <div class="r" style="justify-content:space-between;margin:18px 0 12px"><div class="seg-ctl">${[
      ["all", "All"],
      ["candidate", "To review"],
      ["shortlisted", "Shortlisted"],
      ["dismissed", "Dismissed"],
    ]
      .map(
        ([k, l]) =>
          `<button data-act="prospectFilter" data-v="${k}" class="${k === prospectFilter ? "on" : ""}">${l} ${companies.filter((c) => k === "all" || c.disposition === k).length}</button>`,
      )
      .join(
        "",
      )}</div><button class="btn sm" data-act="prospectRefresh">Refresh</button></div>
    ${
      rows.length
        ? rows
            .map(
              (
                c,
              ) => `<article class="blk" style="margin-bottom:14px"><div class="blk-h" style="gap:12px"><b>${esc(c.name)}</b><div class="r"><span class="chip ${c.fit === "potential" ? "ok" : "outline"}">${c.fit === "potential" ? "Potential fit" : c.fit === "low" ? "Outside target size" : "Needs review"}</span><span class="chip outline">${esc(c.disposition)}</span></div></div><div class="blk-b" style="display:grid;gap:10px">
      <div class="r" style="gap:18px;flex-wrap:wrap"><span>${c.employees === null ? "Team size unavailable" : esc(c.employees) + " employees"}${c.country ? " · " + esc(c.country) : ""}</span>${c.domain ? `<a href="https://${esc(c.domain)}" target="_blank" rel="noopener noreferrer">${esc(c.domain)} ↗</a>` : ""}<span class="muted">Crustdata · ${c.enriched ? "exact company match" : "search facts only"}</span></div>
      <p style="margin:0;max-width:90ch">${esc(c.description || "Description unavailable")}</p>
      ${c.reasons.length ? `<div><b>Why research this team</b><ul>${c.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : ""}
      <div class="muted"><b>Still to verify</b><ul>${c.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></div>
      <div class="r" style="justify-content:space-between;flex-wrap:wrap;gap:12px"><small class="muted">Company ID ${esc(c.companyId)} · researched ${esc(new Date(c.lastFoundAt).toLocaleDateString())}</small>${d.canResearch ? `<div class="r">${c.disposition !== "shortlisted" ? `<button class="btn sm" data-act="prospectReview" data-id="${esc(c._id)}" data-v="shortlisted" ${prospectBusy ? "disabled" : ""}>Shortlist</button>` : ""}${c.disposition !== "dismissed" ? `<button class="btn sm" data-act="prospectReview" data-id="${esc(c._id)}" data-v="dismissed" ${prospectBusy ? "disabled" : ""}>Dismiss</button>` : ""}${c.disposition !== "candidate" ? `<button class="btn sm" data-act="prospectReview" data-id="${esc(c._id)}" data-v="candidate" ${prospectBusy ? "disabled" : ""}>Return to review</button>` : ""}</div>` : ""}</div>
    </div></article>`,
            )
            .join("")
        : `<div class="empty" style="height:auto;padding:40px"><h3>${prospectLoading ? "Loading company research…" : "No companies in this view"}</h3><p>Search to build a shortlist, then review the company facts.</p></div>`
    }
  </div>`;
};
async function prospectPost(body) {
  prospectBusy = true;
  prospectError = "";
  prospectRender();
  try {
    const r = await fetch("/api/prospects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Company research failed");
    toast(
      body.action === "search" ? "Company research saved" : "Review saved",
      "ok",
    );
  } catch (e) {
    prospectError = e.message;
  } finally {
    const error = prospectError;
    await loadProspects();
    prospectError = error;
    prospectBusy = false;
    prospectRender();
  }
}
Object.assign(A, {
  prospectSearch: () => {
    if (prospectBusy) return;
    prospectQuery = $("#prospect-query")?.value?.trim() || prospectQuery;
    if (prospectQuery.length < 10) {
      prospectError = "Enter at least 10 characters.";
      prospectRender();
      return;
    }
    return prospectPost({
      action: "search",
      key: crypto.randomUUID(),
      query: prospectQuery,
      limit: 5,
    });
  },
  prospectReview: (el) =>
    prospectBusy
      ? null
      : prospectPost({
          action: "review",
          companyId: el.dataset.id,
          disposition: el.dataset.v,
        }),
  prospectFilter: (el) => {
    prospectFilter = el.dataset.v;
    prospectRender();
  },
  prospectRefresh: loadProspects,
});
document.addEventListener("input", (e) => {
  if (e.target.id === "prospect-query") prospectQuery = e.target.value;
});
