# Bloom

Standalone photo journal hosted at https://bloom-with-cue.vercel.app. It connects to Cue as a registered customer app. Its own Convex project owns journal entries, photo storage and opaque support-session links; Cue owns support conversations, investigations and provider credentials.

Run `npm ci` and `npm run dev -- --port 4401` from this directory. Configure the server-only variables in `.env.example`. The signed anonymous journal cookie belongs to this host; it is not an account login. Journals from Cue's legacy `/bloom` host remain intact there and are not automatically migrated or shared with this host.

`npm run build` prepares the supplied Bloom design and shared browser assets from the repository root. Configure Vercel's root directory as `apps/bloom`, with files outside that directory included. No Cue credentials, Google service credentials, or WorkOS credentials belong in this project.

Photo bytes upload directly to Convex with a single-use, ten-minute bearer ticket. Vercel then checks ownership, decodes the image, and marks it verified. Only verified photos can become memories. This preserves the 5 MiB limit despite Vercel's function request-body limit. Expired tickets and unused temporary photos are cleaned hourly; saved journal photos are retained.

Before release run `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npx convex deploy`. Then run the repository's `scripts/verify-bloom-hosting.ts` against the actual HTTPS address. Include fresh guest isolation and chat/voice delivery checks; compilation alone does not verify the connection.
