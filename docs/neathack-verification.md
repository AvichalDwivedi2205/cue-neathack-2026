# Cue · neatHack verification

Verified October 11, 2026. Required sponsor completion is **neatlogs: done;
Entire: done; cfo.ai: done**. All three required sponsors have actual usage
evidence. Submission publication remains a separate step.

## Working source and release

- Public source: <https://github.com/AvichalDwivedi2205/cue-neathack-2026>.
- Tracing implementation: source commit `b4b7ee0d8160004b6fa19ed49d6f272573e6a791`.
- Clean public snapshot: `e2ac467e783582211e0514e57440643e75776bdc`.
- Hosted Cue: <https://cue.latchgrid.in>; Cloud Run revision `cue-00026-mds`,
  serving 100% of traffic. Container digest
  `sha256:a906fa1b12c6bafe84ef35f471e5e29df3055f37a7a270cd3fe4a30304a34137`.
- Public checks passed: secure customer cookie; exact 5 MiB acceptance and
  one-byte-over rejection; persisted photo storage; denied foreign-origin
  deletion; authenticated operator/integration endpoints; WorkOS PKCE callback.
- The engineering companion is a local worker. It must stay running for coding
  jobs; hosted support and triage also work with the worker offline.

All 306 backend tests in 43 files, lint, typecheck and the production build
passed after the instrumentation changes. The public source snapshot also
passed all 306 tests. Production dependency audit:
12 moderate advisories, zero high or critical. This is not a clean-audit claim.

## neatlogs

SDK `1.1.28` initializes once per server/worker process. Official Gemini/Vertex
wrappers own model capture. Unsupported Codex provider calls use agent spans
and actual SDK-reported usage, without inventing LLM spans. Semantic failures
are marked explicitly, including failures saved instead of thrown.

The local Doctor and an authenticated finalized probe passed. The probe's
synthetic 11/7/18 token counts are diagnostic values, not measured model usage.
Application calls below are separate actual executions.

| Evidence | Exact trace ID | Observed result |
|---|---|---|
| Upload replay before correction | `a7a8ec6c20758403387c477f8c06b328` | One workflow, one tool; tool ERROR; three acceptance failures reproduced |
| Upload replay after correction | `f2e68c85961368df8b7e2bdf86ad4f37` | One workflow, one tool; tool OK; all eight independent HTTP checks passed |
| Controlled support call | `7b0a2dc2f8d99f7eb704c869e0f84d5e` | Workflow → agent → one Gemini LLM; SUCCESS; 778 input + 23 output = 801 tokens |
| Controlled triage call | `8f9e5f5451f06c807f1e214294b34374` | Finalized actual classification result |
| Controlled specification call | `5be5a0d7ad938161506e354c5d5d9141` | Explicit all-word and ownership constraints preserved in this example |
| Controlled Growth calls | `2b64c131c0335a844482ee6999f8d2eb` | Qualification and an unsent, capability-grounded draft |
| Hosted Bloom → Cue support | `faae69efef9fae80cec287b7d8f2d9f3` | One workflow and one actual Gemini call; 807 total tokens; saved product-review reply |
| Hosted report triage | `f2a4c72067e111716660cfe671ac4ee0` | Finalized three-span trace following the same controlled hosted request |

Trace URLs use `https://app.neatlogs.com/traces/<trace-id>` and require project
access. Screenshots in [evidence](evidence/) provide inspectable public proof.
The dashboard groups these under the process label “Cue”; root span names
distinguish the workflows. Inputs/outputs are redacted at export. Provider PII
redaction also masks some benign terms such as MB and PNG.

The regression replay uses a disposable copy and applies the known one-line
correction. It is not a fresh autonomous Codex investigation. The actual
retained coding run is visible in Cue issue `ISS-14`: commit
`d71bbd03a95a909b2b08e5da5c0182dd12ff46db`, independent protected tests, exact
human approval and deployed 3 MiB acceptance/6 MiB rejection.

The trace review exposed a Gemini specification error: “all words” became
“any word.” The prompt now explicitly preserves supplied functional
constraints; subsequent controlled examples kept “all.” This does not establish
held-out accuracy or remove the need for product review.

## Entire

The GitHub App is installed only on the original `cue-b2c` repository. A
separate clean public snapshot is also pushed to an Entire-native repository;
the app's GitHub access was not expanded.

Checkpoint ID: **`01M4N3E1W54RN7FC20B4GJGPEV`**.

- [Public captured session](https://entire.io/et/cue-neathack-2026/cue/session/01a129c7-7f3e-7e00-80a5-dbdbea47cf3c)
- [Commit carrying the checkpoint trailer](https://entire.io/et/cue-neathack-2026/cue/commit/e2ac467e783582211e0514e57440643e75776bdc)

The official CLI attached the genuine Codex session and created the checkpoint.
Its Git ref was pushed to Entire and GitHub. Entire's Share dialog confirms
anyone with the link can view the session. Before publication, exported source
and checkpoint blobs were checked against configured secrets; no matches
remained. Transcript credentials, verification codes and private contact
details were redacted by Entire. Routine provider sender addresses remain.

Codex hook configuration is checked in. Future automatic capture requires
reviewing/enabling it through Codex's `/hooks`; this checkpoint was captured
using the official manual session-attach command.

## cfo.ai and plan

The organiser's dedicated link is <https://cfo.ai/neathacks>. The user completed
card signup. Billing was inspected: Startup **Canceled**, trial **won't renew**,
access ends October 25, 2026, and the October 11 invoice is **$0**. Payment
details are excluded from public evidence.

cfo.ai saved **Cue neatHack — pilot economics and runway** in the Cue workspace.
Its [public view-only link](https://cfo.ai/s/IfzpWk2LZv2xR34C) was opened in a
separate browser profile without signing in. The editable assumptions feed
native tables and a separate coding-cost stress scenario. Base surplus at
0/1/5/20 hypothetical customers is -$75/$5/$325/$1,525; the $12/run stress case
is -$75/-$40/$100/$625. Modeled break-even is 1/3 customers, and 20-customer
modeled margins are 77.0%/31.6%. The hypothetical $1,000 cash scenario gives
13.3 months of infrastructure-only runway at zero revenue.

[Business plan](neathack-business-plan.md) and [screenshots](evidence/)
preserve limitations and pilot success/kill/pivot criteria. Costs and customers
are planning assumptions; labor and other listed expenses are excluded.
Organiser-allocated cfo.ai credits have not been verified.

The first shared Canvas failed because it requested a dataset from a scenario
outside the public share. The saved Canvas now derives the $12/run stress case
from Main Scenario inputs and an explicit same-page stress allowance. Public
rendering was inspected after the repair: chart, all eight comparison rows and
13.3-month runway were visible. Changing the public local-preview allowance
from $3 to $12 produced $625 surplus, 31.6% modeled margin and 3-customer
break-even; Reset restored $1,525, 77.0% and 1. Canvas controls do not save.

## Demo and submission

A narrated **2:29** final evidence walkthrough was created from authentic UI
screenshots. It is a documentary walkthrough, not a continuous recording of a
new coding run. H.264 1920×1080, AAC 48 kHz. The retained patch and tests are
separate from fresh sponsor replay/model calls. The final scene shows the
actual cfo.ai model and labels its figures as planning assumptions.

Growth activation evidence is controlled, with no organic acquisition or
paying-customer claim. External replies in the retained fix are drafts.

The video, public code, checkpoint and plan links are recorded in
[submission preparation](neathack-submission.md). Optional Crustdata signup
was completed with the organiser's promo code entered before email signup.
An available usage balance was verified on October 11, 2026; the dashboard
reports dollars rather than the advertised 5,000-credit count. Crustdata is
available for optional research, but Cue does not call its API. No X
submission was posted.
