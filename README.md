# Cue · neatHack 2026

Cue helps consumer-app teams turn customer feedback into investigated, reviewed and independently verified product changes. Bloom is the reference photo-journal app.

- [Cue](https://cue.latchgrid.in) · [operator workspace](https://cue.latchgrid.in/cue#/home) (sign-in and team membership required)
- [Bloom customer app](https://bloom-with-cue.vercel.app)
- [Business plan](docs/neathack-business-plan.md) · [Demo script](docs/neathack-demo-script.md) · [Submission evidence](docs/neathack-submission.md)

## What works

Support reports are saved, classified and linked to issues. Cue can run a scoped Codex investigation against its Bloom fixture, keep independent tests outside the editable surface, and require human approval of the exact patch before release. App-bound feature repositories have a separate trusted execution path. Arbitrary repositories and arbitrary bug deployment are outside this demo's supported scope.

The retained upload run has a real coding session, independently checked patch and approved release. Fresh neatlogs evidence includes actual Gemini support/triage/specification/Growth calls and a temporary-copy replay of the upload regression. The replay applies the known correction; it is not a new autonomous coding run. Growth activation evidence is controlled; no organic acquisition or paying customers are claimed.

## Run locally

Requires Node 24+, npm, a Convex development deployment and FFmpeg for voice uploads. Install the Codex CLI and sign in if running coding investigations. For Gemini use Application Default Credentials with a Google Cloud project, or a Gemini API key.

```sh
npm ci
cp .env.example .env.local
npx convex dev --typecheck disable
```

Fill the local Convex URL/deployment and a random `CUE_DEMO_SECRET` in `.env.local`. Keep `CUE_LOCAL_DEMO=true` strictly for loopback development. Leave `CUE_GITHUB_REPO` empty to use the bundled fixture without external repository writes. In a second terminal:

```sh
npm run dev
```

For hosted operator access, configure WorkOS credentials/callback, saved team membership and `CUE_LOCAL_DEMO=false`. Provider integrations need their own accounts and server credentials. Never expose `.env.local` or use the local auth bypass on a shared host.

## Verify

```sh
npm run test:backend
npm run lint
npm run build
npx tsx scripts/verify-observability.ts
```

The last command needs model credentials and a neatlogs project key. It sends controlled unsent examples, reproduces the upload failure in a disposable copy and records trace IDs under ignored `artifacts/`. Successful calls are traced once; agent failures have explicit status and inputs/outputs are redacted.

## Provenance

This clean source snapshot derives from Cue commit `b4b7ee0d8160004b6fa19ed49d6f272573e6a791` on October 11, 2026. It contains code and a lockfile, with private account artifacts, environment files and earlier private documentation excluded. The source project began October 10, 2026.
