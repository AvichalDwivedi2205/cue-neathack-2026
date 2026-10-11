/* Live adapter. Design remains intact; Convex is the source of truth. */
let liveSnapshot = null,
  liveSignature = "",
  loadingLive = false;
async function cueAPI(action, data = {}) {
  const r = await fetch("/api/demo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...data }),
  });
  const body = await r.json();
  if (!r.ok) {
    const message = body.error || "Request failed";
    throw new Error(
      message.includes("Live coding demo supports the Bloom upload issue.")
        ? "Automated implementation currently supports Bloom upload issues."
        : message.includes("Reset the demo to run again.")
          ? "An investigation already exists. Open its timeline to review it."
          : message,
    );
  }
  return body;
}
function liveIssue(id) {
  return liveSnapshot?.issues.find(
    (i) =>
      i._id ===
      (S.issues[id]?._backend || S.features.find((f) => f.id === id)?._backend),
  );
}
function syncCue(data) {
  // Keep illustrative and verification records out of the product views.
  // The original records remain available to the backend and test tooling.
  const hiddenCases = data.cases.filter(
    (c) =>
      c.provenance === "Seeded demo report" ||
      c.provenance.startsWith("Synthetic ") ||
      (c.appId &&
        ["Demo visitor", "Widget verification"].includes(c.customer) &&
        /^Connected App(?: Demo)?: Widget (?:HTTP )?verification/.test(
          c.title,
        )),
  );
  const hiddenIds = new Set(hiddenCases.map((c) => c._id));
  const cases = data.cases.filter((c) => !hiddenIds.has(c._id));
  const issueIds = new Set(cases.map((c) => c.issueId).filter(Boolean));
  data = {
    ...data,
    cases,
    issues: data.issues.filter((i) => issueIds.has(i._id)),
    messages: data.messages.filter(
      (m) =>
        !hiddenIds.has(m.caseId) &&
        !(m.role === "cue" && m.body.startsWith("Demo reset:")),
    ),
    attachments: data.attachments.filter((a) => !hiddenIds.has(a.caseId)),
    runs: data.runs.filter((r) => issueIds.has(r.issueId)),
    events: data.events
      .filter(
        (e) =>
          issueIds.has(e.issueId) &&
          !/Seeded |Demo .*reset/i.test(e.detail + " " + e.title) &&
          (e.runId || !hiddenCases.some((c) => e.detail.includes(c.title))),
      )
      .map((e) => ({
        ...e,
        title: e.title.replace(/^Demo deployment/, "Deployment"),
        detail: e.detail.replaceAll("local demo", "local Bloom environment"),
      })),
  };
  liveSnapshot = data;
  const issueLabels = new Map(
    data.issues.map((i, n) => [
      i._id,
      i.fingerprint === "bloom:upload:413"
        ? "ISS-14"
        : i.kind === "feature"
          ? i.fingerprint.includes("export")
            ? "FR-3"
            : i.fingerprint.includes("dark")
              ? "FR-4"
              : "FR-" + (n + 10)
          : "ISS-" + (n + 20),
    ]),
  );
  const seedIds = {
    "Maya Chen": "c1",
    "Oliver Park": "c2",
    "Aisha Patel": "c3",
    "Leo Martin": "c4",
    "Sofia Rivera": "c5",
  };
  const colors = ["#C2552F", "#3563C9", "#8A5A2B", "#6D4FC2", "#B7791F"];
  const memberName = (c) =>
    c.channel === "slack"
      ? data.integration.members?.find(
          (m) => `Slack ${m.slackId}` === c.customer,
        )?.name
      : undefined;
  S.cases = data.cases.map((c, n) => ({
    id:
      c.provenance === "Seeded demo report"
        ? seedIds[c.customer] || c._id
        : c._id,
    _backend: c._id,
    customer: memberName(c) || c.customer,
    verifiedEmail: c.sourceKey?.startsWith("email:"),
    ini: memberName(c) ? memberName(c).slice(0, 2).toUpperCase() : c.initials,
    color: colors[n % colors.length],
    channel: c.channel,
    handle: c.customer,
    subject: c.title,
    excerpt: c.body,
    priority: c.priority,
    status: c.status === "requested" ? "waiting" : c.status,
    issue:
      c.issueId && issueLabels.get(c.issueId)?.startsWith("ISS")
        ? issueLabels.get(c.issueId)
        : undefined,
    fr:
      c.issueId && issueLabels.get(c.issueId)?.startsWith("FR")
        ? issueLabels.get(c.issueId)
        : undefined,
    t: c.updatedAt,
    unread: false,
    tags: c.tags,
    plan: c.appId ? "Connected app visitor" : "Bloom customer",
    other: data.cases.filter(
      (other) =>
        other._id !== c._id &&
        other.appId === c.appId &&
        (c.owner
          ? other.owner === c.owner
          : ["x", "email", "slack", "reddit"].includes(c.channel) &&
            c.customer !== "Reddit author unverified" &&
            other.channel === c.channel &&
            other.customer.toLowerCase() === c.customer.toLowerCase()),
    ).length,
    sample:
      c.provenance === "Seeded demo report" ||
      c.provenance.startsWith("Synthetic "),
    source: {
      intakeLabel: c.provenance.startsWith("Imported from official X API")
        ? "Collected via X API"
        : /^Imported (?:X|Reddit) notification email/.test(c.provenance)
          ? "Imported from email"
          : "Captured by operator",
      label:
        c.channel === "x"
          ? "X post"
          : c.channel === "email"
            ? "Email report"
            : c.channel === "reddit"
              ? "Reddit post or comment"
              : c.channel === "slack"
                ? "Slack thread"
                : c.appId
                  ? "Connected app support"
                  : "Bloom support",
      url: c.sourceUrl || "/bloom",
      by:
        c.provenance === "Live demo message"
          ? "Bloom in-app chat"
          : c.provenance,
    },
    msgs: data.messages
      .filter((m) => m.caseId === c._id)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((m) => ({
        k:
          m.role === "customer"
            ? c.channel === "x"
              ? "xpost"
              : "in"
            : m.role === "note"
              ? "note"
              : "out",
        who: m.role === "cue" || m.role === "draft" ? CUE : OP,
        t: m.createdAt,
        text: m.body,
        meta:
          m.role === "draft"
            ? "Draft · not sent to " + c.channel
            : m.role === "cue"
              ? c.channel === "x" || c.channel === "email"
                ? "Draft · not sent"
                : "Cue · in-app reply"
              : m.author,
      })),
  }));
  S.issues = Object.fromEntries(
    data.issues
      .filter((i) => i.kind === "bug")
      .map((i) => {
        const id = issueLabels.get(i._id);
        return [
          id,
          {
            id,
            _backend: i._id,
            title: i.title,
            priority: i.priority,
            status: i.status,
            cases: S.cases.filter((c) => c.issue === id).map((c) => c.id),
            created: i.createdAt,
          },
        ];
      }),
  );
  S.features = data.issues
    .filter((i) => i.kind === "feature")
    .map((i) => {
      let spec = {
        need: i.description,
        specification:
          "Generate a specification from the recorded customer requests.",
        acceptanceCriteria: [],
      };
      try {
        if (i.spec) spec = JSON.parse(i.spec);
      } catch {
        spec.specification = i.spec;
      }
      const id = issueLabels.get(i._id);
      return {
        id,
        _backend: i._id,
        title: i.title,
        need: spec.need,
        status:
          i.status === "resolved"
            ? "released"
            : ["spec_ready", "spec_rejected"].includes(i.status)
              ? "spec-ready"
              : i.specApprovedAt
                ? "approved"
                : "collecting",
        created: i.createdAt,
        spec: spec.specification,
        ac: spec.acceptanceCriteria || [],
        approvedAt: i.specApprovedAt,
        approvedBy: i.specApprovedBy || "Operator",
        requesters: S.cases
          .filter((c) => c.fr === id)
          .map((c) => ({
            name: c.customer,
            ini: c.ini,
            color: c.color,
            channel: c.channel,
            quote: c.excerpt,
            case: c.id,
            sample: c.sample,
          })),
      };
    });
  S.events = data.events.map((e) => ({
    t: e.createdAt,
    title: e.title,
    detail: e.detail,
    kind:
      e.kind === "failure"
        ? "fail"
        : e.kind === "success"
          ? "ok"
          : e.kind === "agent"
            ? "run"
            : "warn",
    ref: issueLabels.get(e.issueId) || "ISS-14",
    _backend: e._id,
    runId: e.runId,
  }));
  const upload = data.issues.find((i) => i.fingerprint === "bloom:upload:413");
  const r = data.runs
    .filter((r) => r.issueId === upload?._id && r.status !== "archived")
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  S.liveRun = r || null;
  if (!r) S.run = freshRun();
  else {
    const status =
      {
        awaiting_approval: "awaiting",
        resolved: "done",
        canceled: "failed",
        rejected: "rejected",
        failed: "failed",
        running: r.phase === "deploying" ? "deploying" : "running",
      }[r.status] || "running";
    const cur = r.verified
      ? 10
      : r.deployed
        ? 9
        : r.phase === "deploying"
          ? 8
          : r.after
            ? 7
            : r.before
              ? 5
              : 2;
    S.run = {
      ...freshRun(),
      status,
      cur,
      startedAt: r.createdAt,
      approvedAt: r.approval ? r.updatedAt : null,
      reject: r.error,
      stages: STAGES.map((_, n) => ({
        st:
          n < 2
            ? "done"
            : n === 2
              ? r.repoPath
                ? "done"
                : cur === 2
                  ? "running"
                  : "queued"
              : n === 3 || n === 4
                ? r.before
                  ? "done"
                  : "queued"
                : n === 5
                  ? r.after
                    ? "done"
                    : r.before
                      ? "running"
                      : "queued"
                  : n === 6
                    ? r.after
                      ? "done"
                      : "queued"
                    : n === 7
                      ? r.approval
                        ? "done"
                        : r.status === "awaiting_approval"
                          ? "waiting"
                          : "queued"
                      : n === 8
                        ? r.deployed
                          ? "done"
                          : cur === 8
                            ? "running"
                            : "queued"
                        : n === 9
                          ? r.verified
                            ? "done"
                            : cur === 9
                              ? "running"
                              : "queued"
                          : r.status === "resolved"
                            ? "done"
                            : "queued",
        start: r.createdAt,
        end: r.updatedAt,
      })),
    };
    if (status === "failed") S.run.stages[cur].st = "failed";
  }
  S.integrations = {
    ...data.integration,
    slack: data.integration.slack,
  };
  OP.name = data.integration.actor;
  OP.ini = OP.name
    .split(/\s+/)
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  S.inboxState = S.cases.length ? "populated" : "empty";
  if (S.sec === "inbox" && S.cases.some((c) => c.id === S.id)) S.sel = S.id;
  else if (!S.cases.find((c) => c.id === S.sel)) S.sel = S.cases[0]?.id;
}
async function loadCue() {
  if (loadingLive) return;
  loadingLive = true;
  try {
    const r = await fetch("/api/demo", { cache: "no-store" }),
      data = await r.json();
    if (!r.ok) throw new Error(data.error);
    const signature = JSON.stringify(data);
    if (signature !== liveSignature) {
      liveSignature = signature;
      syncCue(data);
      refresh({ thread: true });
      renderDemo();
      renderIncoming();
    }
  } catch (e) {
    if (!liveSnapshot) {
      S.inboxState = "error";
      if (S.sec) renderMain(false);
    }
    console.error(e);
  } finally {
    loadingLive = false;
  }
}
async function liveAction(action, data = {}) {
  try {
    const result = await cueAPI(action, data);
    await loadCue();
    return result;
  } catch (e) {
    toast(e.message, "fail");
    throw e;
  }
}
startRun = async () => {
  const c = curCase(),
    issue = liveIssue(c?.issue || "ISS-14");
  if (!issue) return toast("Select a bug issue first", "warn");
  await liveAction("investigate", { issueId: issue._id });
  setTab("investigation");
};
approve = async () => {
  const r = S.liveRun;
  if (!r) return;
  await liveAction("approve", { runId: r._id, commit: r.commit });
  toast("Approved exact commit · deployment queued", "run");
};
A.start = () => startRun();
A.approve = () => approve();
A.apprFix = () => {
  const c = S.cases.find((c) => c.issue === "ISS-14");
  if (!c) return;
  closeOverlays(true);
  S.pendingTab = "changes";
  S.tab = "changes";
  go("#/inbox/" + c.id);
};
A.retry = () => startRun();
A.rerun = () => startRun();
A.cancel = () => S.liveRun && liveAction("cancel", { runId: S.liveRun._id });
A.rejectConfirm = async () => {
  const reason = $("#rej")?.value?.trim();
  if (!reason) return;
  await liveAction("reject", {
    runId: S.liveRun._id,
    commit: S.liveRun.commit,
    reason,
  });
  closeOverlays();
};
A.send = async () => {
  const c = curCase(),
    text = S.compose.text.trim(),
    note = S.compose.mode === "note";
  if (!c || !text) return;
  await liveAction("message", {
    caseId: c._backend,
    body: text,
    note,
    channel: c.channel,
  });
  S.compose.text = "";
  renderTabBody();
  toast(
    note
      ? "Internal note saved"
      : c.channel !== "chat"
        ? "Reply saved as draft"
        : "Reply saved",
  );
};
send = () => A.send();
A.draft = async () => {
  const c = curCase();
  if (!c) return;
  S.drafting = true;
  renderTabBody();
  try {
    const { text } = await cueAPI("draft", { caseId: c._backend });
    if (curCase()?._backend === c._backend) S.compose.text = text;
    toast("Cue draft ready");
  } catch (e) {
    toast(e.message, "fail");
  } finally {
    S.drafting = false;
    renderTabBody();
  }
};
streamDraft = () => A.draft();
openCapture = (source = "x") => {
  XC.channel = source === "reddit" ? "reddit" : "x";
  Object.assign(XC, {
    url: "",
    author: "",
    text: "",
    shot: null,
    errs: {},
    busy: false,
  });
  const name = XC.channel === "reddit" ? "Reddit" : "X";
  openDrawer(
    `Capture ${name} post`,
    captureBody(),
    '<button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="createCase">Create case</button>',
  );
};
A.capture = () => openCapture("x");
A.captureReddit = () => openCapture("reddit");
capturePreview = () =>
  `<div class="xpost"><b>${esc(XC.author || "Customer")}</b><p style="white-space:pre-wrap">${esc(XC.text || "Post text appears here…")}</p><small>Operator capture · ${XC.channel === "reddit" ? "Reddit" : "X"}</small></div>`;
captureBody = () => {
  const reddit = XC.channel === "reddit",
    e = XC.errs;
  return `<div class="callout" style="margin-bottom:16px">Capture a brand mention or complaint. Paste the public permalink and original text. Cue stores and triages it; no live post is fetched or sent.</div>
    <div class="field"><label for="xc-url">Post URL</label><input class="inp" id="xc-url" data-xc="url" value="${esc(XC.url)}" placeholder="${reddit ? "https://www.reddit.com/r/.../comments/..." : "https://x.com/username/status/..."}">${e.url ? `<span class="f-err">${esc(e.url)}</span>` : ""}</div>
    <div class="field"><label for="xc-author">Author</label><input class="inp" id="xc-author" data-xc="author" value="${esc(XC.author)}" placeholder="${reddit ? "u/username" : "@handle"}">${e.author ? `<span class="f-err">${esc(e.author)}</span>` : ""}</div>
    <div class="field"><label for="xc-text">Post text</label><textarea class="inp" id="xc-text" data-xc="text" maxlength="12000">${esc(XC.text)}</textarea>${e.text ? `<span class="f-err">${esc(e.text)}</span>` : ""}</div>
    <div class="field"><label>Screenshot (optional)</label><label class="drop-sm" for="xc-shot">${XC.shot ? "Screenshot selected" : "Choose a screenshot"}</label><input type="file" id="xc-shot" accept="image/png,image/jpeg,image/webp" class="sr"></div><div id="xc-prev">${capturePreview()}</div>`;
};
validateX = () => {
  const errors = {};
  try {
    const url = new URL(XC.url.trim()),
      reddit = XC.channel === "reddit";
    if (
      url.protocol !== "https:" ||
      !(
        reddit
          ? ["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com"]
          : ["x.com", "www.x.com", "twitter.com", "www.twitter.com"]
      ).includes(url.hostname) ||
      !(
        reddit ? /\/(?:r|user)\/[^/]+\/comments\// : /\/[^/]+\/status\/\d+/
      ).test(url.pathname)
    )
      throw new Error();
  } catch {
    errors.url = "Add a complete public post or comment permalink.";
  }
  if (!XC.author.trim()) errors.author = "Add the author's handle.";
  if (!XC.text.trim()) errors.text = "Paste the original post text.";
  return errors;
};
A.createCase = async (button) => {
  XC.errs = validateX();
  if (Object.keys(XC.errs).length) {
    $(".dr-b").innerHTML = captureBody();
    return;
  }
  if (XC.busy) return;
  XC.busy = true;
  if (button) {
    button.disabled = true;
    button.textContent = "Saving case…";
  }
  try {
    const { id } = await liveAction("report", {
      title: XC.text.slice(0, 80),
      body: XC.text,
      customer: XC.author,
      channel: XC.channel || "x",
      sourceUrl: XC.url,
      attachment: XC.shot || undefined,
    });
    closeOverlays();
    go("#/inbox/" + id);
    toast("Post captured · duplicate captures reuse this case");
  } catch {
  } finally {
    XC.busy = false;
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = "Create case";
    }
  }
};
A.approveSpec = async (el) => {
  const f = S.features.find((f) => f.id === el.dataset.id);
  if (!f) return;
  await liveAction("spec", {
    issueId: f._backend,
    spec: liveIssue(f.id)?.spec,
    approved: true,
  });
  toast("Specification approved · implementation requires a separate task");
};
A.generateSpec = async (el) => {
  const f = S.features.find((f) => f.id === el.dataset.id);
  if (f) await liveAction("generateSpec", { issueId: f._backend });
};
A.specApproval = async (el) => {
  const f = S.features.find((f) => f.id === el.dataset.id);
  if (f) {
    await liveAction("specApproval", { issueId: f._backend });
    toast("Specification sent to the Product reviewer in Slack");
  }
};
A.connectSlack = () => (location.href = "/connections");
A.manage = (el) => {
  if (["GitHub", "Slack", "WorkOS"].includes(el.dataset.v))
    location.href = "/connections";
  else
    toast(
      el.dataset.v === "Email"
        ? "Connect an email sender to send replies"
        : "Connection details shown here",
      "info",
    );
};
A.retryInbox = loadCue;
A.linkIssue = async () => {
  const c = curCase(),
    i = liveIssue("ISS-14");
  if (c && i) await liveAction("link", { caseId: c._backend, issueId: i._id });
};
A.editTags = () => {
  const c = curCase();
  if (!c) return;
  openDrawer(
    "Edit case tags",
    `<label class="f-label">Comma-separated tags</label><input id="case-tags" class="inp" value="${esc(c.tags.join(", "))}"><p style="color:var(--ink-2)">Tags describe the problem; workflow status stays separate.</p>`,
    `<button class="btn primary" data-act="saveTags">Save tags</button>`,
  );
};
A.saveTags = async () => {
  const c = curCase();
  await liveAction("tags", {
    caseId: c._backend,
    tags: $("#case-tags")
      .value.split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  });
  closeOverlays();
  toast("Tags saved");
};
A.emailSend = async () => {
  const c = curCase(),
    body = S.compose.text.trim();
  if (!body) return toast("Compose the email reply first", "warn");
  await liveAction("emailSend", { caseId: c._backend, body });
  S.compose.text = "";
  renderTabBody();
  toast("Email accepted by provider");
};
A.slackSend = async () => {
  const c = curCase(),
    body = S.compose.text.trim();
  if (!body) return toast("Compose the Slack reply first", "warn");
  await liveAction("slackSend", { caseId: c._backend, body });
  S.compose.text = "";
  renderTabBody();
  toast("Reply delivered to Slack thread");
};
A.slackApproval = () =>
  S.liveRun && liveAction("slackApproval", { runId: S.liveRun._id });
A.triage = async () => {
  const c = curCase();
  if (!c) return;
  toast("Gemini reviewing the recorded evidence…");
  await liveAction("triage", { caseId: c._backend });
  toast("Triage recorded · review the internal note");
};
const oldContext = renderCtx;
renderCtx = () => {
  oldContext();
  const b = $('#ctx button[title="Add tag"],#ctx button[aria-label="Add tag"]');
  if (b) b.dataset.act = "editTags";
  if (!curCase()?.sample) {
    const badge = $("#ctx .chip.sample");
    if (badge) {
      badge.className = "chip ok";
      badge.textContent = "Live customer";
    }
  }
};
const originalRefresh = refresh;
function applyRoleControls() {
  const actions = {
    start: "investigate",
    cancel: "investigate",
    slackApproval: "investigate",
    approve: "deploy",
    rejectOpen: "deploy",
    reject: "deploy",
    generateSpec: "spec",
    approveSpec: "spec",
    editSpec: "spec",
    saveSpec: "spec",
    specApproval: "spec",
    send: "support",
    draft: "support",
    triage: "support",
    editTags: "support",
    saveTags: "support",
    emailSend: "support",
    slackSend: "support",
    createCase: "support",
    linkIssue: "support",
    implementFeature: "investigate",
    featureSlack: "investigate",
    featureCancel: "investigate",
    featureApprove: "deploy",
  };
  for (const button of document.querySelectorAll("button[data-act]")) {
    const permission = actions[button.dataset.act];
    if (
      permission &&
      S.integrations?.permissions &&
      !S.integrations.permissions[permission]
    ) {
      button.disabled = true;
      button.title = `Your ${S.integrations.role} role cannot perform this action`;
    }
  }
}
refresh = (opts) => {
  if (S.sec === "inbox" && S.inboxState === "populated" && !$("#case-b"))
    renderCase();
  originalRefresh(opts);
  applyRoleControls();
};
const originalRenderMain = renderMain;
renderMain = (anim) => {
  originalRenderMain(anim);
  applyRoleControls();
};
const originalCaseHead = renderCaseHead;
renderCaseHead = () => {
  originalCaseHead();
  const c = curCase();
  if (!c?.sample) {
    const badge = $("#case-h .chip.sample");
    if (badge) {
      badge.className = "chip ok";
      badge.textContent = "Live report";
    }
  }
};
caseStatus = (c) =>
  c.status === "resolved"
    ? "resolved"
    : c.issue &&
        ["investigating", "awaiting_approval"].includes(
          S.issues[c.issue]?.status,
        )
      ? "investigating"
      : c.status === "requested"
        ? "waiting"
        : c.status;
const originalPrimary = primary;
primary = (c) => {
  const action = originalPrimary(c);
  if (c.issue) {
    action.next = action.next.replace(
      "all 3 linked reports",
      `all ${S.issues[c.issue]?.cases.length || 0} linked reports`,
    );
    if (action.done)
      action.next =
        "Deployed fix verified. Chat updated; external replies saved as drafts.";
  }
  return action;
};
const oldConversation = conversation;
conversation = (c) =>
  (
    oldConversation(c) +
    (c.verifiedEmail && S.integrations.emailSend
      ? '<div style="padding:12px 24px"><button class="btn primary sm" data-act="emailSend">Send composed reply by email</button></div>'
      : c.channel === "slack" && S.integrations.slackSend
        ? '<div style="padding:12px 24px"><button class="btn primary sm" data-act="slackSend">Send composed reply to Slack thread</button></div>'
        : "")
  )
    .replace("Copy &amp; mark posted", "Save reply draft")
    .replace("Copy & mark posted", "Save reply draft")
    .replace(
      /(<button\b[^>]*id="send-btn"[^>]*>)[\s\S]*?(<\/button>)/,
      (markup, open, close) =>
        c.channel !== "chat" && S.compose.mode !== "note"
          ? open + "Save reply draft" + close
          : markup,
    )
    .replace(
      "Delivered to the Bloom in-app widget",
      c.channel === "reddit"
        ? "Reddit replies stay as drafts for the brand operator to post."
        : c.channel === "slack"
          ? "Save a draft, or send the composed reply to the connected Slack thread."
          : c.plan === "Connected app visitor"
            ? "Delivered to this app’s support widget"
            : "Delivered to the Bloom in-app widget",
    )
    .replace(
      `Replies by email to ${esc(c.handle)}`,
      S.integrations.emailSend
        ? S.integrations.emailTestSender
          ? "Test sender connected · replies can reach the configured operator email."
          : "Save a draft, or send the composed reply by email."
        : "Email replies stay as drafts until a sender is configured.",
    )
    .replace(
      '<button class="btn ghost icon sm" aria-label="Attach file">' +
        ic("clip", 14) +
        "</button>",
      '<button class="btn ghost sm" data-act="triage">Triage with Gemini</button>',
    );
const oldRowHtml = rowHtml;
rowHtml = (c) =>
  oldRowHtml(c).replace(
    '<span class="chip sample" style="margin-left:auto">Sample</span>',
    "",
  );
changes = () => {
  const r = S.liveRun;
  if (!r)
    return '<div class="empty"><h3>No proposed change yet</h3><p>Reproduce the bug, then delegate to your Codex account.</p><button class="btn primary" data-act="start">Start investigation</button></div>';
  const block = (title, body) =>
    `<div class="blk"><div class="blk-h">${title}</div><div class="blk-b">${body}</div></div>`;
  const pre = (text) =>
    `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.65 var(--mono);margin:0">${esc(
      text?.includes("1 MB photo: HTTP")
        ? text
            .split("\n")
            .filter((l) => /HTTP|^PASS/.test(l))
            .join("\n")
        : text || "Pending",
    )}</pre>`;
  return `<div class="chg">${block("Root cause", esc(r.rootCause || "Reproduction in progress"))}${block("Actual repository diff", pre(r.diff))}${block("Independent HTTP regression tests", `<p>Before</p>${pre(r.before)}<p style="margin-top:16px">After</p>${pre(r.after)}`)}${block("Source and exact commit", `<p class="mono">${esc(r.commit || "No commit yet")}</p>${r.prUrl ? `<a class="btn" href="${esc(r.prUrl)}" target="_blank" rel="noopener">Open draft pull request ↗</a>` : "<p>No pull request yet.</p>"}`)}<div id="reject-slot"></div>${r.status === "awaiting_approval" && S.integrations.slackApproval ? '<button class="btn" data-act="slackApproval">Send approval request to Slack</button>' : ""}${r.status === "awaiting_approval" ? `<div class="decide"><b>Review this exact commit before deployment</b><div class="d-r"><button class="btn danger" data-act="rejectOpen">Reject</button><button class="btn primary" data-act="approve">Approve &amp; deploy</button></div></div>` : ""}${r.verified ? block("Deployed scenario verified", `<p style="color:var(--accent)">Valid 3 MB photo accepted · 6 MB control rejected.</p><p>Customer chat updated. X and email replies saved as operator drafts.</p>`) : block("Verification", esc(r.error || "Approval is separate from deployed verification."))}</div>`;
};
timeline = () => {
  const r = S.liveRun,
    events =
      liveSnapshot?.events
        .filter((e) => e.runId === r?._id)
        .sort((a, b) => a.createdAt - b.createdAt) || [];
  if (!r)
    return '<div class="empty"><h3>No investigation yet</h3><p>One run covers matching reports.</p><button class="btn primary" data-act="start">Start investigation</button></div>';
  return `<div class="tl"><div class="tl-head">${ic("bot", 18)}<div><b>Codex · ${esc(r.status.replaceAll("_", " "))}</b><p>Isolated checkout · live execution events</p></div>${r.status === "running" && r.phase !== "deploying" ? '<button class="btn danger sm" style="margin-left:auto" data-act="cancel">Cancel run</button>' : ""}</div>${events.map((e) => `<div class="step seen"><div class="s-time">${clock(e.createdAt)}</div><div class="s-rail"><span class="s-node">✓</span></div><div class="s-card"><b>${esc(e.title)}</b><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 var(--mono);color:var(--ink-2);max-height:280px;overflow:auto">${esc(e.detail)}</pre></div></div>`).join("")}${r.status === "running" ? `<div class="callout"><span class="dot investigating pulse"></span>${esc(r.phase)} · waiting for the worker’s next result</div>` : ""}${r.error ? `<div class="err-banner">${esc(r.error)}</div>` : ""}${r.status === "awaiting_approval" ? '<button class="btn primary" data-act="tabChg">Review actual fix</button>' : ""}</div>`;
};
const originalConversation = conversation;
conversation = (c) =>
  originalConversation(c) +
  (liveSnapshot?.attachments || [])
    .filter((a) => a.caseId === c._backend)
    .map(
      (a) =>
        `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" alt="Customer screenshot" style="max-width:300px;border-radius:12px;margin:12px 24px"></a>`,
    )
    .join("");
const oldFeatureDetail = featureDetail;
featureDetail = (f) =>
  oldFeatureDetail(f).replace(
    '<div class="fr-sec"><h4>Suggested specification',
    `<div class="fr-sec"><button class="btn violet sm" data-act="generateSpec" data-id="${f.id}">Generate with Gemini</button>${liveIssue(f.id)?.status === "spec_ready" && S.integrations.slackSend ? `<button class="btn sm" data-act="specApproval" data-id="${f.id}">Request Product review in Slack</button>` : ""}</div><div class="fr-sec"><h4>Suggested specification`,
  );
const loadedFeaturesPage = featuresPage;
featuresPage = () =>
  S.features.length
    ? loadedFeaturesPage()
    : `<div class="page"><h1>Feature requests</h1><p>${liveSnapshot ? "No feature requests yet. Customer requests will appear here as they arrive." : "Loading recorded requests…"}</p></div>`;
const loadedFeatureDetail = featureDetail;
featureDetail = (f) => {
  let html = loadedFeatureDetail(f);
  const issue = liveIssue(f.id);
  const run = liveSnapshot?.runs
    .filter((r) => r.issueId === f._backend)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const events = liveSnapshot?.events.filter((e) => e.runId === run?._id) || [];
  if (run?.verified && run?.deployed && run?.releaseEvidence)
    html = html.replace(
      /<div class="fr-foot">[\s\S]*?<\/div>/,
      '<div class="fr-foot"><span class="approved-bar">Release verified. Customer updates are recorded in their cases.</span></div>',
    );
  html += `<div class="fr-sec"><h4>Implementation</h4>${!run ? (issue?.status === "approved" ? `<p>Implement the reviewed specification in an isolated checkout. Engineering reviews the tested PR before release.</p>${S.integrations.codingApps?.includes(issue.appId || "bloom") ? `<button class="btn primary" data-act="implementFeature" data-id="${f.id}">Implement with Codex</button>` : '<a class="btn" href="/setup#coding">Connect app repository</a>'}` : "<p>Product must approve the current specification before implementation.</p>") : `<p><b>${esc(run.status.replaceAll("_", " "))}</b> · ${esc(run.phase.replaceAll("_", " "))}</p>${run.prUrl ? `<a class="btn" href="${esc(run.prUrl)}" target="_blank" rel="noopener">Review pull request ↗</a>` : ""}${run.commit ? `<p class="mono">${esc(run.commit)}</p>` : ""}${run.status === "awaiting_approval" ? `<button class="btn primary" data-act="featureApprove" data-id="${f.id}">Approve implementation</button>${S.integrations.slackSend ? `<button class="btn" data-act="featureSlack" data-id="${f.id}">Request Engineering review in Slack</button>` : ""}` : ""}${run.status === "running" ? `<button class="btn danger" data-act="featureCancel" data-id="${f.id}">Cancel implementation</button>` : ""}${run.after ? `<details><summary>Independent validation</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(run.after)}</pre></details>` : ""}${run.diff ? `<details><summary>Proposed code change</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(run.diff)}</pre></details>` : ""}${run.error ? `<p class="err-banner">${esc(run.error)}</p>` : ""}<p>Implementation approval does not deploy or resolve the customer request. Use your repository’s release process.</p>`}</div>`;
  if (run?.releaseEvidence)
    html = html.replace(
      "<p>Implementation approval does not deploy or resolve the customer request. Use your repository’s release process.</p>",
      `<details open><summary>Deployed acceptance evidence</summary><p style="white-space:pre-wrap">${esc(run.releaseEvidence)}</p></details>`,
    );
  if (liveIssue(f.id)?.status === "spec_rejected")
    html =
      '<div class="callout">Product requested changes. Revise and save the specification before requesting another review.</div>' +
      html;
  if (run && events.length)
    html += `<div class="fr-sec"><h4>Agent activity</h4>${events
      .slice()
      .reverse()
      .map(
        (e) =>
          `<details><summary>${esc(e.title)}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(e.detail)}</pre></details>`,
      )
      .join("")}</div>`;
  let n = 0;
  html = html.replaceAll('<span class="chip sample">Sample</span>', () =>
    f.requesters[n++]?.sample
      ? '<span class="chip sample">Sample</span>'
      : '<span class="chip ok">Live</span>',
  );
  return html
    .replace(
      "Approving sends this spec to engineering. Nothing is built automatically.",
      "Approval records the specification for engineering.",
    )
    .replace(
      '<button class="btn" style="margin-left:auto">Edit spec</button>',
      `<button class="btn" style="margin-left:auto" data-act="editSpec" data-id="${f.id}">Edit spec</button>`,
    );
};
A.implementFeature = async (el) => {
  const f = S.features.find((f) => f.id === el.dataset.id);
  if (f) await liveAction("implementFeature", { issueId: f._backend });
};
const featureRun = (el) =>
  liveSnapshot?.runs
    .filter(
      (r) =>
        r.issueId === S.features.find((f) => f.id === el.dataset.id)?._backend,
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
A.featureApprove = async (el) => {
  const r = featureRun(el);
  if (r) await liveAction("approve", { runId: r._id, commit: r.commit });
};
A.featureSlack = async (el) => {
  const r = featureRun(el);
  if (r) await liveAction("slackApproval", { runId: r._id });
};
A.featureCancel = async (el) => {
  const r = featureRun(el);
  if (r) await liveAction("cancel", { runId: r._id });
};
A.editSpec = (el) => {
  const f = S.features.find((f) => f.id === el.dataset.id);
  if (!f) return;
  openDrawer(
    "Edit specification",
    `<textarea id="edit-spec" class="inp" style="width:100%;height:320px">${esc(JSON.stringify({ need: f.need, specification: f.spec, acceptanceCriteria: f.ac }, null, 2))}</textarea>`,
    `<button class="btn primary" data-act="saveSpec" data-id="${f.id}">Save specification</button>`,
  );
};
A.saveSpec = async (el) => {
  const f = S.features.find((f) => f.id === el.dataset.id);
  try {
    const spec = JSON.parse($("#edit-spec").value);
    if (
      typeof spec.need !== "string" ||
      typeof spec.specification !== "string" ||
      !Array.isArray(spec.acceptanceCriteria) ||
      spec.acceptanceCriteria.length < 2
    )
      throw new Error(
        "Use need, specification and at least two acceptance criteria.",
      );
    await liveAction("spec", {
      issueId: f._backend,
      spec: JSON.stringify(spec),
    });
    closeOverlays();
  } catch (e) {
    toast(e.message, "fail");
  }
};
issuesList = () =>
  `<div class="page"><div class="page-h"><div><h1>Issues</h1><p>Shared investigations and their linked customer evidence.</p></div></div><table class="table"><thead><tr><th>ID</th><th>Title</th><th>Reports</th><th>Priority</th><th>Status</th></tr></thead><tbody>${Object.values(
    S.issues,
  )
    .filter((i) => i.cases.length)
    .map(
      (i) =>
        `<tr data-act="goto" data-v="#/issues/${i.id}" tabindex="0"><td class="mono">${esc(i.id)}</td><td><a href="#/issues/${i.id}">${esc(i.title)}</a></td><td>${i.cases.length}</td><td>${prio(i.priority)}</td><td>${issueStatusChip(i)}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
issueDetail = (id) => {
  const issue = S.issues[id],
    record = liveIssue(id);
  if (!issue || !record)
    return '<div class="empty"><h3>Issue not found</h3></div>';
  const cases = issue.cases.map(caseById).filter(Boolean),
    r = id === "ISS-14" ? S.liveRun : null;
  return `<div class="page"><a class="btn ghost sm" href="#/issues">← Issues</a><div class="issue-hdr"><div class="ih-id">${esc(id)}</div><h1>${esc(issue.title)}</h1><div class="ih-m">${prio(issue.priority)}${issueStatusChip(issue)}<span>${cases.length} reports</span></div></div><div class="issue-grid"><div class="stack"><div class="blk"><div class="blk-h">Linked customer reports</div>${cases.map((c) => `<button class="rel" data-act="selCase" data-id="${c.id}" style="padding:12px">${av(c, "sm")}<span class="rel-t">${esc(c.customer)} · ${esc(c.subject)}</span></button>`).join("")}</div><div class="blk"><div class="blk-h">Recorded impact</div><div class="blk-b"><p>${esc(record.description)}</p><p style="color:var(--ink-3)">Impact reflects linked customer reports.</p></div></div>${r ? changes() : ""}</div><div class="stack"><div class="blk"><div class="blk-h">Engineering workflow</div><div class="blk-b">${id === "ISS-14" ? (r ? `<p>${esc(r.status.replaceAll("_", " "))}</p><button class="btn" data-act="toRun">View live timeline</button>` : '<p>One isolated Codex run covers these linked reports.</p><button class="btn primary" data-act="start">Start investigation</button>') : "<p>This issue is recorded for triage. Automated implementation currently covers Bloom upload changes.</p>"}</div></div></div></div></div>`;
};
settingsPage = () =>
  `<div class="page"><div class="page-h"><h1>Settings</h1></div><div class="blk"><div class="blk-h">Current permissions</div><div class="blk-b"><p>Cue may reproduce the Bloom upload bug, delegate a scoped code change, run independent tests and open a draft PR.</p><p>Deployment requires approval of the exact commit. Resolution requires a successful deployed upload and an oversized negative control.</p><p>X and Reddit replies are operator drafts. Slack and email require verified connection credentials.</p><a class="btn" href="/setup">Manage integrations</a></div></div></div>`;
integrationsPage = () => {
  const i = S.integrations;
  const cards = [
    [
      "In-app widget",
      "Connected",
      "Live Bloom chat · install in your own app",
      "/setup#widget",
    ],
    [
      "GitHub",
      i.github ? "Configured" : "Not connected",
      i.github ? "Connected Bloom repository" : "Choose a repository",
      "/setup#codex",
    ],
    [
      "Codex",
      "Local account",
      "ChatGPT login · isolated checkouts",
      "/setup#codex",
    ],
    [
      "Gemini",
      i.gemini ? "Configured" : "Project needed",
      "Google Cloud · support drafts and specifications",
      "/connections",
    ],
    [
      "WorkOS",
      i.workos ? "Configured" : "Operator setup needed",
      "AuthKit login + Pipes connections",
      "/connections",
    ],
    [
      "Slack",
      i.slack === "on"
        ? "Connected"
        : i.slack === "configured"
          ? "Configured"
          : "Not connected",
      "Team messages require a connected workspace",
      "/setup#slack",
    ],
    [
      "Email",
      i.email ? "Configured" : "Not connected",
      "Receive support emails and send customer replies",
      "/setup#email",
    ],
    [
      "X",
      i.x?.connected
        ? "API polling active"
        : i.x?.configured
          ? "API configured"
          : i.notifications?.connected
            ? "Notification inbox connected"
            : i.notificationPolling
              ? "Polling configured"
              : "Not connected",
      i.x?.configured
        ? `${i.x.detail} · ${i.x.imported} posts collected`
        : "Brand mentions → notification email → Cue · delivery not guaranteed",
      "/setup#x",
    ],
    [
      "Reddit",
      i.notifications?.connected
        ? "Notification inbox connected"
        : i.notificationPolling
          ? "Polling configured"
          : "Not connected",
      "u/brand mentions → notification email → Cue · delivery may be incomplete",
      "/setup#email",
    ],
  ];
  return `<div class="page"><div class="page-h"><div><h1>Integrations</h1><p>Connect the channels your customers and team use.</p></div></div><div class="int-grid">${cards.map(([n, status, detail, url]) => `<div class="int"><div class="int-h"><span class="int-logo">${ic(n === "X" ? "xlogo" : "plug", 18)}</span><h3>${n}</h3></div><div class="int-st"><span class="dot ${status === "Connected" ? "resolved" : "waiting"}"></span>${status}</div><div class="int-d">${esc(detail)}</div><div class="int-f">${n === "Reddit" ? '<a class="btn sm" href="/bloom#/support">Bloom support</a>' : ""}${url ? `<a class="btn sm" href="${url}">${n === "In-app widget" ? "Install widget" : "Manage"}</a>` : ""}${["X", "Reddit"].includes(n) ? '<button class="btn primary sm" data-act="' + (n === "Reddit" ? "captureReddit" : "capture") + '">Capture post</button>' : ""}</div></div>`).join("")}</div></div>`;
};
renderDemo = () => {};
function renderIncoming() {
  const el = $("#ticker");
  if (!el) return;
  el.innerHTML = S.cases.length
    ? S.cases
        .slice(0, 4)
        .map(
          (c) =>
            `<div class="t-item"><div class="av-wrap">${av(c, "sm")}${chIc(c.channel)}</div><div class="t-body"><div class="t-top"><b>${esc(c.customer)}</b>${CH[c.channel]?.label || "Support"}</div><div class="t-text">${esc(c.subject)}</div></div>`,
        )
        .join("")
    : `<div style="padding:24px;color:var(--ink-3)">${liveSnapshot ? "New customer reports will appear here." : "Loading customer reports…"}</div>`;
}
startTicker = renderIncoming;
initLanding = () => {
  const items = [
    ["widget", "In-app widget"],
    ["github", "GitHub"],
    ["bot", "Codex"],
    ["slack", "Slack"],
    ["mail", "Email"],
    ["xlogo", "X · manual capture"],
    ["flask", "Independent tests"],
  ];
  const one = items.map(([i, n]) => `<span>${ic(i, 18)}${n}</span>`).join("");
  $("#marquee").innerHTML = one + one;
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-scroll]");
    if (!a) return;
    e.preventDefault();
    const target = $(a.getAttribute("href"));
    target?.scrollIntoView({
      behavior: REDUCE ? "auto" : "smooth",
      block: "start",
    });
  });
};
// Disable the design's browser-only story mutations.
onBus = () => {};
receiveReport = () => {};
A.speed = () => {};
A.failToggle = () => {};
S.cases = [];
S.issues = {
  "ISS-14": {
    id: "ISS-14",
    title: "Loading issue…",
    cases: [],
    status: "open",
  },
};
S.features = [];
S.events = [];
// Growth has no backend yet; show its honest empty state instead of design samples.
S.growth = {
  ...S.growth,
  state: "empty",
  opps: [],
  campaigns: [],
  capabilities: [],
};
// Agent records and conversations have no backend yet; never show design samples as live work.
S.ag = {
  ...S.ag,
  live: true,
  tasks: [],
  convos: {},
  agents: S.ag.agents.map((a) => ({
    ...a,
    health: {
      st: "unknown",
      label: "Health not reported yet",
      detail: "Agent records aren’t connected in this workspace yet.",
    },
  })),
};
S.inboxState = "loading";
S.firstInbox = false;
CH.slack = { label: "Slack", icon: "slack", s: 10 };
CH.reddit = { label: "Reddit", icon: "chat", s: 10 };
loadCue();
setInterval(() => {
  if (!document.hidden) loadCue();
}, 1500);
