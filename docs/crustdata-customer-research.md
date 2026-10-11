# Crustdata customer research for Cue

Open **Growth → Cue customers** in the signed-in [Cue workspace](https://cue.latchgrid.in/cue#/growth/prospects).
Describe a company cohort, click **Find companies**, then review the returned
facts and use **Shortlist**, **Dismiss**, or **Return to review**. These are
potential buyers of Cue, separate from Bloom's explicit-request Growth flow.

## Implementation

The authenticated Next.js route derives the actor from the saved workspace
membership. Owner and Product members can search/review; other signed-in team
members can read. Same-origin checks protect writes. Convex keeps the key in a
server environment variable and stores research runs and company facts.

The action reads free account permission/pricing metadata, reserves a bounded
run, performs [hybrid company search](https://docs.crustdata.com/company-docs/search/introduction)
with reported headcount 1–50, then requests
[company enrichment](https://docs.crustdata.com/company-docs/enrichment/introduction)
by the exact returned company IDs. Requested fields are company name, domain,
description, headcount and country. Person/contact endpoints are unused.
Provider-response extras are discarded before saving; neatlogs records
request metadata and usage, rather than the raw response.

Each search returns at most five companies, has a 15-credit reservation ceiling,
and allows at most five reserved searches per UTC day. Reservations are atomic;
duplicate request keys reuse the existing run, failures retain their reservation,
and paid provider calls are never automatically retried. Repeated company IDs
update facts while preserving human shortlist decisions. Missing or ambiguous
enrichment produces review-only search evidence. The UI displays unavailable
usage as unknown rather than guessing a dollar conversion.

## Live check on October 11, 2026

Two successful live searches (one direct action and one authenticated hosted UI
search) returned **ten unique exact-ID enriched records**. Each reported
**11.15 credits** across search and enrichment, totaling **22.30 credits** for
the successful runs. Each reservation was 11.15 credits.
The initial filter request failed because Crustdata's inclusive operators are
`=>` and `=<`; a diagnostic response reported zero credits for that rejection.
The failed run remains recorded with unknown saved usage and retains its
reservation. No company was contacted.

| Company | Crustdata-reported employees | Independent product-site observation |
|---|---:|---|
| Reflection | 4 | [Official site](https://www.reflection.app/) describes a journaling app on iOS, Android, macOS and web. |
| Atoms | 5 | [James Clear's official site](https://jamesclear.com/) links the official Atomic Habits app. |
| HabitYou | 1 | [Official site](https://habityou.com/) links iOS/Android habit tracking, journaling and planning. |
| Habit Nest | 8 | [Official site](https://habitnest.com/) describes its mobile app alongside physical journals. |
| Raz Industries | 1 | No website returned; product identity remains unverified. |

After inspecting the four official product sites, Reflection, Atoms, HabitYou
and Habit Nest were shortlisted through the hosted UI. Raz Industries was
dismissed because its product identity could not be checked. The second search
added The Journaling Habit, hiMoment, Done!, JournPad: Voice Journal and
ReflectRise; these five remain candidates requiring website and fit review.
Reloading the hosted screen preserved all four shortlist decisions and the
dismissal. The new fit rule requires a valid website for automatic potential-fit
labeling; earlier saved labels are historical facts, not retroactively rescored.

neatlogs recorded successful workflow/tool traces
[`89e926a915fab8a022aed17d08155e7e`](https://app.neatlogs.com/traces/89e926a915fab8a022aed17d08155e7e)
and [`3adc1f7bab98003dcffd94bdd2ee476d`](https://app.neatlogs.com/traces/3adc1f7bab98003dcffd94bdd2ee476d).
The [hosted shortlist](evidence/crustdata-cue-customers.jpg) and
[trace screenshot](evidence/neatlogs-crustdata-research.jpg) provide public
evidence without credentials.

Employee counts are provider-reported observations, not independently confirmed.
The fit rule is a simple description/category plus team-size baseline. It does
not establish support pain, current engineering capacity, a decision-maker,
budget, permission to contact, or willingness to pay. The website checks support
product identity only. Ten records are a smoke test, not acquisition evidence.

## Smallest next validation

Review 20 unseen company records against a manual product-site baseline before
expanding search. Use the same headcount target and research budget for both
methods. Success: at least 80% correctly identified consumer-app teams and at
least 30% less review time, with zero identity mismatches in the shortlist.
Stop automatic fit labeling on any identity mismatch; pivot to raw company
facts and manual review if precision is below 80%. Founder conversations and
a measured paid pilot are separate future work requiring user authorization.

## Configuration and checks

Set `CRUSTDATA_API_KEY` and `NEATLOGS_API_KEY` on the existing Convex deployment
using `npx convex env set NAME --from-file private-value-file`. Keep key files
outside tracked source; never use `NEXT_PUBLIC_` for either key. Deploy with
`npx convex deploy`. The website needs its existing authenticated Convex
connection and server secret; no Crustdata key is delivered to the browser.

Tests cover request field selection and exact-ID association, partial failure,
pricing ceilings, atomic reservations and duplicate keys, role/secret checks,
CSRF, decision preservation, and metadata-only telemetry. Full backend suite:
319 passing tests across 46 files; lint, typecheck and production build passed.
