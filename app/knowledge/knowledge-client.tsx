"use client";
import { useCallback, useEffect, useRef, useState } from "react";
type Source = {
  _id: string;
  title: string;
  kind: string;
  status: string;
  visibility: string;
  revision: number;
  activeVersionId?: string;
  latestVersionId?: string;
  indexStatus: string;
  error?: string;
};
type Version = {
  title: string;
  text: string;
  question?: string;
  answer?: string;
  alternatives?: string[];
  visibility: string;
  url?: string;
  fileName?: string;
};
type Passage = { text: string; heading: string; page?: number };
type Snapshot = {
  apps: { id: string; name: string }[];
  sources: Source[];
  canEdit: boolean;
  canPublish: boolean;
  model: string;
  litellm: boolean;
};
type TestResult = {
  text: string;
  status: string;
  model: string;
  retrieval: string;
  inputTokens: number;
  outputTokens: number;
  citations: {
    title: string;
    heading: string;
    page?: number;
    excerpt: string;
  }[];
  passages: {
    title: string;
    heading: string;
    page?: number;
    excerpt: string;
  }[];
};
const empty = {
  title: "",
  text: "",
  question: "",
  answer: "",
  alternatives: "",
  visibility: "customer",
  url: "",
};
export function KnowledgeClient() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [app, setApp] = useState(""),
    [selected, setSelected] = useState(""),
    [kind, setKind] = useState("faq");
  const [form, setForm] = useState(empty),
    [editorRevision, setEditorRevision] = useState(0),
    [dirty, setDirty] = useState(false),
    [passages, setPassages] = useState<Passage[]>([]),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [file, setFile] = useState<File | null>(null),
    [question, setQuestion] = useState(""),
    [testModel, setTestModel] = useState(""),
    [testMode, setTestMode] = useState("hybrid"),
    [answer, setAnswer] = useState<TestResult | null>(null);
  const serial = useRef(0),
    detailSerial = useRef(0);
  const invalidateLoad = useCallback(() => {
    serial.current++;
  }, []);
  const load = useCallback(async (id: string) => {
    const current = ++serial.current;
    const response = await fetch(
      "/api/knowledge" + (id ? "?app=" + encodeURIComponent(id) : ""),
      { cache: "no-store" },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (current === serial.current) {
      setSnapshot(data);
      if (!id && data.apps[0]) setApp(data.apps[0].id);
    }
  }, []);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void load(app).catch((e) => setNotice(e.message));
    });
    const timer = setInterval(() => void load(app).catch(() => {}), 5000);
    return () => {
      active = false;
      invalidateLoad();
      clearInterval(timer);
    };
  }, [app, load, invalidateLoad]);
  const source = snapshot?.sources.find((s) => s._id === selected);
  async function select(id: string) {
    const current = ++detailSerial.current;
    setNotice("");
    setSelected(id);
    setPassages([]);
    const response = await fetch(
      `/api/knowledge?app=${encodeURIComponent(app)}&source=${encodeURIComponent(id)}`,
      { cache: "no-store" },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (current !== detailSerial.current) return;
    const v = data.version as Version;
    setEditorRevision(data.source.revision);
    setDirty(false);
    setKind(data.source.kind);
    setForm({
      title: v.title,
      text: v.text,
      question: v.question || "",
      answer: v.answer || "",
      alternatives: (v.alternatives || []).join("\n"),
      visibility: v.visibility,
      url: v.url || "",
    });
    setPassages(data.passages);
  }
  function add(type: string) {
    detailSerial.current++;
    setSelected("");
    setKind(type);
    setForm({ ...empty, visibility: type === "faq" ? "customer" : "internal" });
    setPassages([]);
    setFile(null);
    setDirty(false);
    setNotice("");
  }
  async function call(body: unknown) {
    const response = await fetch("/api/knowledge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  }
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try {
      await operation();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (kind === "file" && !selected) {
      if (!file) throw new Error("Choose a document first");
      const body = new FormData();
      body.set("file", file);
      body.set("appId", app);
      body.set("visibility", form.visibility);
      body.set("title", form.title || file.name);
      const response = await fetch("/api/knowledge", { method: "POST", body }),
        data = await response.json();
      if (!response.ok) throw new Error(data.error);
      await load(app);
      await select(data.sourceId);
      setNotice("Document extracted. Review the draft before publishing.");
      return;
    }
    const data = await call({
      action: "save",
      appId: app,
      ...(selected
        ? { sourceId: selected, expectedRevision: editorRevision }
        : {}),
      kind,
      title: form.title || form.question.slice(0, 160),
      visibility: form.visibility,
      ...(kind === "faq"
        ? {
            question: form.question,
            answer: form.answer,
            alternatives: form.alternatives
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : { text: form.text }),
      ...(["url", "github"].includes(kind) && !selected
        ? { url: form.url }
        : {}),
    });
    await load(app);
    await select(data.sourceId);
    setNotice("Draft saved. Publish when the extracted content is ready.");
  }
  async function publish() {
    await call({
      action: "publish",
      appId: app,
      sourceId: selected,
      expectedRevision: editorRevision,
    });
    await load(app);
    setNotice(
      "Publishing queued. The previous published revision stays active until indexing finishes.",
    );
  }
  const field = (name: keyof typeof empty) => ({
    value: form[name],
    onChange: (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ) => {
      setDirty(true);
      setForm((old) => ({ ...old, [name]: e.target.value }));
    },
  });
  return (
    <main className="knowledge-shell">
      <div className="knowledge-heading">
        <div>
          <h1>Knowledge</h1>
          <p>
            Give customers answers grounded in your FAQs, policies and
            documents.
          </p>
        </div>
        <label>
          Application
          <select
            aria-label="Application"
            value={app}
            disabled={busy}
            onChange={(e) => {
              setApp(e.target.value);
              add("faq");
              setAnswer(null);
            }}
          >
            {snapshot?.apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="knowledge-notice" role="status">
        {notice ||
          (snapshot
            ? `${snapshot.sources.filter((s) => s.status === "published").length} published sources · Widget model: ${snapshot.model}`
            : "Loading company knowledge…")}
      </div>
      {!snapshot?.apps.length && snapshot && (
        <section className="knowledge-card">
          <h2>Connect your application first</h2>
          <p>
            Register its name and allowed website origins, then add its
            knowledge here.
          </p>
          <a href="/setup#widget">Register an application →</a>
        </section>
      )}
      {!!snapshot?.apps.length && (
        <div className="knowledge-layout">
          <aside className="knowledge-card knowledge-library">
            <div className="knowledge-card-head">
              <h2>Sources</h2>
              <span>{snapshot.sources.length}</span>
            </div>
            <button
              className="knowledge-primary"
              onClick={() => add("faq")}
              disabled={!snapshot.canEdit || busy}
            >
              ＋ Add context
            </button>
            {!snapshot.sources.length && (
              <p className="knowledge-muted">
                Start with the questions customers ask most.
              </p>
            )}
            <div className="knowledge-source-list">
              {snapshot.sources.map((s) => (
                <button
                  key={s._id}
                  className={selected === s._id ? "selected" : ""}
                  onClick={() => void run(() => select(s._id))}
                  disabled={busy}
                >
                  <strong>{s.title}</strong>
                  <span>
                    {s.kind.toUpperCase()} ·{" "}
                    {s.visibility === "customer"
                      ? "Customer-facing"
                      : "Internal"}
                  </span>
                  <span className={"knowledge-badge " + s.status}>
                    {s.indexStatus === "idle" ? s.status : s.indexStatus}
                    {s.status === "published" &&
                    s.latestVersionId !== s.activeVersionId
                      ? " · new draft"
                      : ""}
                  </span>
                </button>
              ))}
            </div>
          </aside>
          <section className="knowledge-card knowledge-editor">
            <div className="knowledge-card-head">
              <h2>{selected ? "Review source" : "Add context"}</h2>
              {source && <span>Revision {source.revision}</span>}
            </div>
            {!selected && (
              <div className="knowledge-tabs" aria-label="Context type">
                {[
                  ["faq", "FAQ"],
                  ["text", "Write / paste"],
                  ["file", "Upload"],
                  ["url", "Website"],
                  ["github", "GitHub document"],
                ].map(([k, l]) => (
                  <button
                    key={k}
                    className={kind === k ? "selected" : ""}
                    onClick={() => add(k)}
                    disabled={busy}
                  >
                    {l}
                  </button>
                ))}
              </div>
            )}
            <label>
              {kind === "faq" ? "Title (optional)" : "Title"}
              <input
                {...field("title")}
                placeholder={
                  kind === "faq"
                    ? "Uses the question if left blank"
                    : "e.g. Product guide"
                }
                maxLength={160}
                disabled={!snapshot.canEdit || busy}
              />
            </label>
            <label>
              Visibility
              <select
                {...field("visibility")}
                disabled={!snapshot.canEdit || busy}
              >
                <option value="customer">Customer-facing</option>
                <option value="internal">Internal team only</option>
              </select>
            </label>
            <p className="knowledge-muted">
              {form.visibility === "customer"
                ? "Published content can be used in customer widget answers."
                : "Available to authorised staff. Excluded from customer widget answers."}
            </p>
            {kind === "faq" ? (
              <>
                <label>
                  Question
                  <input
                    {...field("question")}
                    maxLength={500}
                    placeholder="How do I upload a photo?"
                    disabled={!snapshot.canEdit || busy}
                  />
                </label>
                <label>
                  Approved answer
                  <textarea
                    {...field("answer")}
                    rows={6}
                    maxLength={5000}
                    placeholder="Write the answer your support team would give."
                    disabled={!snapshot.canEdit || busy}
                  />
                </label>
                <label>
                  Alternative questions <small>One per line, optional</small>
                  <textarea
                    {...field("alternatives")}
                    rows={3}
                    disabled={!snapshot.canEdit || busy}
                  />
                </label>
              </>
            ) : kind === "file" && !selected ? (
              <label>
                Document
                <input
                  type="file"
                  accept=".txt,.md,.markdown,.pdf,.docx"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  disabled={!snapshot.canEdit || busy}
                />
                <small>
                  TXT, Markdown, text-based PDF or DOCX · up to 10 MB and 100
                  PDF pages
                </small>
              </label>
            ) : ["url", "github"].includes(kind) && !selected ? (
              <label>
                {kind === "github"
                  ? "Public GitHub file URL"
                  : "Public document URL"}
                <input
                  type="url"
                  {...field("url")}
                  placeholder={
                    kind === "github"
                      ? "https://github.com/company/repo/blob/main/docs/guide.md"
                      : "https://example.com/help"
                  }
                  disabled={!snapshot.canEdit || busy}
                />
                <small>
                  Import one page. Refresh it by importing a new draft. Private
                  pages require a file upload or pasted text.
                </small>
              </label>
            ) : (
              <label>
                Content
                <textarea
                  {...field("text")}
                  rows={13}
                  maxLength={200000}
                  placeholder="Paste your documentation, policies or product context…"
                  disabled={!snapshot.canEdit || busy}
                />
                <small>
                  {form.text.length.toLocaleString()} / 200,000 characters
                </small>
              </label>
            )}
            {source?.error && <p className="knowledge-error">{source.error}</p>}
            <div className="knowledge-actions">
              <button
                onClick={() => void run(save)}
                disabled={busy || !snapshot.canEdit}
              >
                {busy
                  ? "Working…"
                  : kind === "file" && !selected
                    ? "Extract and save draft"
                    : ["url", "github"].includes(kind) && !selected
                      ? "Import and save draft"
                      : "Save draft"}
              </button>
              {selected && (
                <button
                  className="knowledge-primary"
                  onClick={() => void run(publish)}
                  disabled={
                    busy ||
                    dirty ||
                    !snapshot.canPublish ||
                    ["queued", "indexing"].includes(source?.indexStatus || "")
                  }
                >
                  Publish to{" "}
                  {form.visibility === "customer" ? "widget" : "team"}
                </button>
              )}
              {source?.status === "published" && (
                <button
                  className="knowledge-withdraw"
                  disabled={busy || !snapshot.canPublish}
                  onClick={() =>
                    void run(async () => {
                      await call({
                        action: "withdraw",
                        appId: app,
                        sourceId: selected,
                      });
                      await load(app);
                      setNotice(
                        "Source withdrawn. It is excluded from new answers.",
                      );
                    })
                  }
                >
                  Withdraw
                </button>
              )}
              {selected && ["url", "github"].includes(kind) && form.url && (
                <button
                  disabled={busy || !snapshot.canEdit}
                  onClick={() =>
                    void run(async () => {
                      const data = await call({
                        action: "save",
                        appId: app,
                        sourceId: selected,
                        expectedRevision: editorRevision,
                        kind,
                        title: form.title,
                        visibility: form.visibility,
                        url: form.url,
                      });
                      await load(app);
                      await select(data.sourceId);
                      setNotice(
                        "Fresh page imported as a draft. Review and publish the update.",
                      );
                    })
                  }
                >
                  Refresh page draft
                </button>
              )}
              {selected && kind === "file" && (
                <a
                  href={`/api/knowledge?app=${encodeURIComponent(app)}&source=${encodeURIComponent(selected)}&download=1`}
                >
                  Download original
                </a>
              )}
            </div>
            {selected && (
              <p className="knowledge-muted">
                {dirty
                  ? "Save your edits before publishing."
                  : "Publishing uses this saved revision."}
              </p>
            )}
            {!!passages.length && (
              <details className="knowledge-preview">
                <summary>
                  Extracted preview · {passages.length}{" "}
                  {passages.length === 1 ? "passage" : "passages"}
                </summary>
                {passages.map((p, i) => (
                  <article key={i}>
                    <b>
                      {p.heading}
                      {p.page ? ` · page ${p.page}` : ""}
                    </b>
                    <p>{p.text}</p>
                  </article>
                ))}
              </details>
            )}
          </section>
          <aside className="knowledge-card knowledge-tester">
            <h2>Test a question</h2>
            <p className="knowledge-muted">
              Uses the same customer-facing retrieval as the widget. Test
              questions aren’t sent to customers.
            </p>
            <label>
              Customer question
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="Ask something your customers would ask…"
              />
            </label>
            <details>
              <summary>Compare retrieval and models</summary>
              <label>
                Retrieval
                <select
                  value={testMode}
                  onChange={(e) => setTestMode(e.target.value)}
                >
                  <option value="hybrid">Keyword + semantic</option>
                  <option value="keyword">Keyword baseline</option>
                </select>
              </label>
              <label>
                Model
                <select
                  value={testModel}
                  onChange={(e) => setTestModel(e.target.value)}
                >
                  <option value="">Widget model</option>
                  <option value="gemini-2.5-flash">Gemini Flash</option>
                  {snapshot.litellm && (
                    <>
                      <option value="nova-lite">Nova Lite</option>
                      <option value="claude-haiku">Claude Haiku</option>
                      <option value="claude-sonnet-4.6">Claude Sonnet</option>
                    </>
                  )}
                </select>
              </label>
            </details>
            <button
              className="knowledge-primary"
              disabled={busy || !question.trim() || !snapshot.canEdit}
              onClick={() =>
                void run(async () => {
                  setAnswer(
                    await call({
                      action: "test",
                      appId: app,
                      question,
                      ...(testModel ? { model: testModel } : {}),
                      mode: testMode,
                    }),
                  );
                })
              }
            >
              Ask Cue
            </button>
            {snapshot.litellm && (
              <p className="knowledge-muted">
                LiteLLM connected · $20 shared team allowance. Provider requests
                stop at its budget limit.
              </p>
            )}
            {answer && (
              <div className="knowledge-answer">
                <span
                  className={
                    "knowledge-badge " +
                    (answer.status === "answered" ? "published" : "draft")
                  }
                >
                  {answer.status.replaceAll("_", " ")}
                </span>
                <p>{answer.text}</p>
                <small>
                  {answer.model} · {answer.retrieval} ·{" "}
                  {answer.inputTokens + answer.outputTokens
                    ? `${answer.inputTokens + answer.outputTokens} reported tokens`
                    : answer.model === "none"
                      ? "No answer model call"
                      : "Token usage unavailable"}
                </small>
                {answer.citations.map((c, i) => (
                  <details key={i}>
                    <summary>
                      {c.title}
                      {c.page ? ` · page ${c.page}` : ""}
                    </summary>
                    <p>{c.excerpt}</p>
                  </details>
                ))}
                <details>
                  <summary>
                    Retrieved passages ({answer.passages.length})
                  </summary>
                  {answer.passages.map((p, i) => (
                    <article key={i}>
                      <b>
                        {p.title} · {p.heading}
                      </b>
                      <p>{p.excerpt}</p>
                    </article>
                  ))}
                </details>
              </div>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
