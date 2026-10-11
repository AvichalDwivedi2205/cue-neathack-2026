# Bloom × Cue — UI design spec (draft 1)

One story, two apps:
**customer can't upload photo → reports it → Cue investigates → proposes fix → engineer approves → upload works → customer gets update.**

Deliverables: `design/bloom.html`, `design/cue.html` — standalone, no build step, vanilla JS + CSS, Google Fonts only.
Serve both from same origin (`npx serve design` or `python3 -m http.server -d design`) so they share state live.

---

## 0. Shared system

### Cross-app wiring (demo bus)
Both pages talk through `BroadcastChannel('bloom-cue')` + `localStorage` (`storage` event fallback). Keys:

| Key | Written by | Effect |
|---|---|---|
| `bc:limitMB` | Cue (after deploy) | Bloom server limit: `2` → `5` |
| `bc:caseStage` | Cue | Bloom widget case tracker step (0–4) |
| `bc:customerUpdate` | Cue (stage 11) | Bloom widget shows fix message |
| `bc:newReport` | Bloom widget | Cue inbox gets live "Oliver Park" message |

Each page also has a **Demo controls** pill (bottom-left, collapsible) to force screen states (loading / empty / error / populated) and reset the story. Gives reviewers every state without a backend, and marks seams where real data plugs in.

### Motion language (both apps)
- Easing: `--ease-out: cubic-bezier(.2,.8,.2,1)`, `--ease-spring: cubic-bezier(.34,1.56,.64,1)` (used sparingly, Bloom only).
- Durations: 120ms (hover/press), 220ms (panels, tabs), 420ms (page transitions), 700ms+ (story/landing only).
- Enter: fade + 8px rise, list items staggered 30–40ms. Exit: faster than enter (≈ 60%).
- Route change: `document.startViewTransition` when available, crossfade fallback.
- Loading: shimmer skeletons matching final layout (no spinners for content); spinners only inside buttons.
- Running work: soft pulsing ring; never bouncing.
- Success: one-shot check draw (stroke-dashoffset), no confetti in Cue; tiny petal burst allowed in Bloom.
- `prefers-reduced-motion`: all transforms off, opacity-only, scroll-story becomes static stacked sections.

### State checklist (every screen)
`loading` (skeleton) · `empty` (illustration + one sentence + primary action) · `error` (plain cause + retry) · `populated` · `in-progress` (button spinner, disabled, label changes "Saving…") · `success` (toast + inline confirmation). Buttons: default / hover / active (scale .98) / focus-visible ring / disabled / loading.

### Accessibility
Focus rings visible (2px accent + offset), all icon buttons have `aria-label`, dialogs trap focus + Esc closes, live region for toasts & chat, contrast ≥ 4.5:1 for body text, hit targets ≥ 40px in Bloom, ≥ 32px in Cue.

---

## 1. Bloom — photo journal (consumer)

### Feel
Warm, calm, personal. Lots of air. Photography leads; chrome recedes.

### Tokens
```
--paper   #FBF8F3   page
--card    #FFFFFF
--sand    #F1EADF   subtle fills, dropzone
--ink     #1E2A22   text
--ink-2   #5B6A60   secondary text
--forest  #2F5D46   primary
--forest-d#234838   primary pressed
--moss    #E4EEE6   primary tint
--clay    #B65A3C   error (warm, not alarm red)
--clay-bg #FBEDE7
radius: 14 / 22 / 28 / pill
shadow: 0 1px 2px rgba(30,42,34,.06), 0 12px 32px -12px rgba(30,42,34,.18)
```
Type: **Fraunces** (display, titles, captions' first line, italic for dates) + **DM Sans** (UI). Title 44/52, H2 28/34, body 16/26.

### Information architecture
```
Landing (#/)              short story hero → "Open my journal"
My journal (#/journal)    signed-in as Maya Chen
  ├ Add memory (#/new)    sheet over journal
  └ Memory detail (#/m/:id) shared-element zoom from grid card
Support widget            floating, global
```

### Landing
Full-bleed hero: headline *"Keep the small moments."* in Fraunces, floating collage of 5 rounded photos that drift with scroll (parallax 0.1–0.3), soft grain. Three scroll beats, each a sticky photo + line of copy: *Capture → Caption → Remember.* CTA "Open my journal" (pill, forest). Short — it's a consumer app, not a pitch.

### My journal
- Top bar: Bloom wordmark (leaf glyph), journal search (expands on focus, `/` shortcut), avatar "Maya".
- Greeting: *"Good evening, Maya"* + "12 memories · since March".
- Prominent **Add a memory** — large pill top-right + floating FAB on mobile.
- Masonry grid of rounded cards: photo, title (Fraunces), date (italic), caption 2-line clamp. Hover: photo scales 1.03, card lifts. Grouped by month headers ("September 2026").
- Search: live filter, matched text highlighted; no results → "No memories match 'tokyo'" + clear.
- States: skeleton masonry · empty ("Your journal is waiting for its first page" + Add a memory) · error ("We couldn't load your journal" + Try again).

### Add memory (sheet / modal, 2 columns on desktop)
Left: dropzone.
```
[ cloud-up icon ]
Add a photo
JPG, PNG or WebP · Up to 5 MB
Drop here or browse
```
Dropzone states: idle (dashed sand) → drag-over (forest border, tint, icon lifts) → preview (image fills, file name + size chip, "Replace") → uploading (progress bar along bottom, % ) → error (clay banner *"Couldn't upload your photo. Please try again."* with Try again + "Get help" link that opens support widget prefilled) → uploaded (check).
Client-side validation (honest): wrong type → "That file type isn't supported. Use JPG, PNG or WebP." · > 5 MB → "This photo is larger than 5 MB."
**The bug:** "server" limit = `bc:limitMB` (default 2). 2 < size ≤ 5 → generic error. Demo helpers: "Use sample photo (1.2 MB)" and "Use sample photo (3.1 MB)" chips, since reviewers may not have files handy.
Right: Title, Caption (textarea, char count), Date (defaults today). **Save memory** disabled until photo uploaded + title. Saving → card flies into grid at top with highlight glow; toast "Memory saved".

### Memory detail
Shared-element transition from card → large photo (rounded 28), title, italic date, caption. Edit (inline fields, Save/Cancel), Delete (confirm popover, not browser dialog; undo toast for 5s). Prev/next arrows + keyboard ←/→. Esc returns.

### Support widget
Floating 56px forest button bottom-right; opens 380×600 panel with spring scale from corner.
- Header: "Bloom support" + online dot + "Typically replies in a few minutes".
- Opens with: **"Hi! What can we help you with?"** + suggestion chips.
- Composer: text, attach screenshot (📎 → file or "Attach screenshot of last error" — auto-generated thumbnail of the upload error card).
- Flow after customer sends *"My 3 MB photo won't upload, but your app says up to 5 MB."*:
  1. typing dots → acknowledgement: "Thanks for flagging this, Maya — that shouldn't happen. I've opened case **#BLM-2041** with our team."
  2. Follow-up questions as quick replies: "Which device?" [iPhone] [Android] [Computer]; "Did smaller photos work?" [Yes] [No / not sure].
  3. **Case progress** card pinned in thread: Received ✓ → Investigating (pulsing) → Fix in progress → Fixed. Updates live from `bc:caseStage`.
  4. Fix update (from Cue stage 11): "Good news — photos up to 5 MB now upload. Sorry for the trouble!" + **Try your upload again** button (opens Add memory with last file).
- Engineering details never shown to the customer (no HTTP codes, no PRs).
- States: offline/error ("Message not sent · Retry"), sending (faded bubble + clock), delivered.

---

## 2. Cue — customer problems → verified resolution (work tool)

### Feel
Linear/Attio-grade precision. Dense, quiet, honest. Color only means something (priority, status, agent running). No vanity metric cards.

### Tokens
```
--bg       #F6F6F3   workspace
--panel    #FFFFFF
--sunken   #F0F0EC
--sidebar  #111513   (text #C9CFCB, active #FFFFFF on #1D2420)
--ink      #14181A
--ink-2    #5F6764
--ink-3    #8C9390
--line     #E5E5E0   1px borders everywhere
--accent   #1E7A53   restrained green
--accent-t #E5F1EA
--p1       #C24127  --p2 #B7791F  --p3 #6B7280
--run      #2563EB (agent running only)
--feature  #6D4FC2 (feature requests: violet family, visually distinct from bugs)
radius 6 / 8 / 12 ; shadow only on popovers
```
Type: **Inter** (UI, 13px base, tabular nums), **JetBrains Mono** (evidence, diffs, IDs), **Instrument Serif** (landing headlines only).

### Landing (#/) — scroll story, neatlogs-style
Long page, grid-paper background, mono section labels (`01 / REPORT`), thin rules, sticky storytelling:
- **Hero:** "Customer problems in. *Verified fixes* out." Live ticker of incoming complaints sliding through (X, chat, email icons). CTA **Open Bloom workspace** + "See how it works ↓".
- **Sticky story (7 chapters).** Left column = chapter text, right = sticky "stage" that morphs per chapter as you scroll (IntersectionObserver drives `data-chapter`); progress rail with numbered dots:
  1. *A customer hits a wall* — Bloom upload card turns to the clay error.
  2. *They tell you, wherever they are* — X post, chat bubble, email fly in.
  3. *Cue sees one problem, not three* — three cards collapse into one issue card ("Photos above 2 MB fail · 3 reports").
  4. *Reproduce before you guess* — mini terminal: `POST /upload 3.1MB → 413` expected 201.
  5. *Codex writes the fix* — diff types itself: `2 * 1024 * 1024` → `5 * 1024 * 1024`.
  6. *Nothing ships without you* — Approve & deploy button gets pressed, commit hash shown.
  7. *Verified. Then everyone hears back.* — green verification row + three customer replies.
- **Principles strip:** "Evidence over guesses · One issue, many voices · Humans approve · Verification ≠ approval".
- **Integrations marquee** (widget, GitHub, Codex, Slack, Email, X).
- Footer CTA. Scroll-progress hairline at top.

### App shell
```
┌sidebar 232┬──────────── top bar 52 ─────────────────────────────┐
│ ◆ Cue      │ Bloom workspace ▾ │ ⌘K Search…  │ ⏳ 1 approval │ AV │
│ Inbox   5  ├──────────────────────────────────────────────────────┤
│ Issues  1  │                                                      │
│ Feature… 2 │                 route content                         │
│ Agent act. │                                                      │
│ Integrat.  │                                                      │
│ Settings   │                                                      │
│  … run chip│                                                      │
└────────────┴──────────────────────────────────────────────────────┘
```
- Sidebar bottom: live "Agent running · Reproducing bug" chip when a run is active.
- Pending approvals: badge pulses once on change; popover lists items → jumps to Changes tab.
- ⌘K command palette: search cases/issues/actions ("Start investigation", "Go to Integrations").
- Toasts bottom-right, stacked, auto-dismiss 4s, with action.

### Inbox (default, #/inbox) — 3 panes
**List (340px):** filter tabs All · Open · Waiting · Resolved, sort by last activity. Row: avatar, name, channel icon (X / chat / email), subject (bold if unread), 1-line excerpt, priority chip, status dot, relative time, "Sample" tag. Linked rows show a small chain icon "→ ISS-14". Keyboard j/k.
**Case (flex):** header — subject, customer · channel · P1 · Open, primary action button (state-driven):
`Start investigation → View progress → Review fix → Approve demo deployment → View verification` (then "Resolved" chip).
Tabs: **Conversation** | **Investigation** (with live dot when running) | **Changes** (badge when awaiting approval). Tab underline slides.
- Conversation: customer messages left, Cue/staff right, internal notes yellow-tinted; X post rendered as embedded post card; composer with Reply / Internal note toggle, "Draft with Cue" button that streams a suggested reply, channel note "Post via @bloomapp (operator)" for X.
- Investigation: timeline (below).
- Changes: change review (below).
**Context (300px):** Customer (name, plan, since, other cases), Source (channel, link, captured by), Tags, Linked issue card (ISS-14 · 3 reports), Related reports list, **Next action** box (one sentence + button) — always mirrors primary action.
States: list skeleton; empty inbox "Inbox zero. New reports from chat, email and X land here."; error banner with retry; no-selection placeholder.

### Investigation timeline (11 stages)
Vertical rail; each entry: time (mono), title, one-line explanation, evidence link (opens side drawer with log/screenshot/test output), status pill.
1 Report received · 2 Related reports linked · 3 Test environment prepared · 4 Bug reproduced · 5 Root cause identified · 6 Codex implementing fix · 7 Independent tests passed · 8 Change awaiting approval · 9 Demo deployment updated · 10 Deployed scenario verified · 11 Customer updated.
Statuses: `queued` (hollow dot, muted) · `running` (blue dot with expanding ring + shimmer text, elapsed timer) · `done` (green check draws) · `waiting` (amber, needs human) · `failed` (red, error block in mono + **Retry stage** button).
Evidence example on 4: `3 MB photo upload returned HTTP 413. Expected HTTP 201.`
Demo control: "Make stage 7 fail once" to show failure + retry.
Run simulation: stages 1–7 auto-advance (~1.2–2.5s each), stops at 8 (approval). Approve → 9 → 10 → 11.

### Change review (Changes tab)
Sections stacked, each a bordered block:
1. **Root cause** — prose + pointer: `demo/bloom/limits.mjs:2` MAX_UPLOAD_BYTES = 2 MB while UI promises 5 MB.
2. **Diff** — unified, line numbers, red/green gutters, file header, "1 file · +1 −1".
3. **Tests** — Before / After split: `upload accepts 3 MB photo ✗ 413` → `✓ 201`, `rejects 6 MB photo ✓ / ✓`, `accepts 1 MB ✓ / ✓`.
4. **Source** — repo `bloom/bloom-app`, branch `cue/fix-upload-limit`, PR #128 link, commit `a3f9c2e` (copy button) "You are reviewing exactly this commit."
5. **Decision bar** (sticky bottom): **Approve & deploy to demo** (accent) + **Reject** (opens reason textarea). Approve → button loading "Deploying…" → deployment block → verification block.
6. **Verification** — separate result card: "Re-ran 3.1 MB upload on demo → 201 Created · 384 ms" with check; until then: "Approval ≠ resolved. Waiting for verification." Issue status flips to Resolved only after verification.

### Issues (#/issues, #/issues/ISS-14)
List table (ID, title, reports, channels, priority, status, run). Detail:
**Photos above 2 MB fail to upload** · 3 customer reports · X, chat, email · P1.
Sections: Linked reports (3 rows → open case), Impact ("Any photo 2–5 MB from modern phones; est. 38% of iPhone photos"), Suspected cause, Reproduction evidence, Current run (mini timeline, single run shared by all three cases — explicit "1 run for 3 reports"), Proposed change (link to Changes), Resolution status stepper.

### Feature requests (#/features)
Violet-accented, lightbulb glyph, dotted "idea" cards — clearly not bugs. Grouped by need:
- **Export journals as PDF** (Leo Martin + sample others) · **Dark mode** (Sofia Rivera).
Detail: requesting customers with their reasons (quotes), suggested specification, acceptance criteria checklist, **Approve specification** → status "Spec approved" + timestamp. States: empty, loading.

### Agent activity (#/agent)
Chronological feed of all agent events across runs (mono timestamps, filters: All · Running · Failed). Empty state when idle.

### Integrations (#/integrations)
6 cards: In-app widget (Connected · Bloom web), GitHub (Connected · bloom/bloom-app), Coding agent / Codex (Connected), Slack (Not connected · Connect), Email (Connected · support@bloom.app), X (**Operator-assisted capture** · Capture post).
Each: logo glyph, status dot + text, last event, setup action. Connect → loading → connected.
**X capture** (drawer): Brand/project, Post URL, Author, Post text, optional screenshot → live **Preview** (rendered X post card tagging @bloomapp) → **Create case** → toast + jump to new case in Inbox. Validation inline (URL must be x.com/twitter.com). Explainer: "Customer tags @bloomapp → operator captures here → Cue drafts reply → operator posts from brand account."

### Settings
Light: workspace name, operator profile, approval policy ("Require human approval before any deploy" locked on), demo reset.

### Demo data (all labeled **Sample**)
| Customer | Channel | Report | Link |
|---|---|---|---|
| Maya Chen | X | Every photo from my phone gets rejected (3 MB) | ISS-14 |
| Oliver Park | In-app chat | Upload contradicts 5 MB promise | ISS-14 |
| Aisha Patel | Email | Upload returns HTTP 413 | ISS-14 |
| Leo Martin | In-app chat | Wants journal PDF export | FR-3 |
| Sofia Rivera | Email | Requests dark mode | FR-4 |

### Mapping to backend (convex/schema.ts)
cases ↔ inbox rows · issues (kind bug|feature) ↔ Issues/Feature requests · messages ↔ Conversation · runs ↔ Investigation/Changes (rootCause, diff, before, after, prUrl, commit, approval, deployed, verified) · events ↔ timeline & Agent activity.
