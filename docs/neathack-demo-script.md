# Cue — a support report becomes a verified fix

Target: 2 minutes 30 seconds or less. Show the working application and its
recorded evidence. Narration must identify controlled tests and historical
runs accurately.

1. **Problem, 15 seconds.** Open Bloom and Cue's Inbox. “A customer reports that
   a three-megabyte photo is rejected, even though the app promises five.”
2. **Support and triage, 25 seconds.** Open the retained upload case and issue.
   Show the conversation, related reports, and evidence. “Cue saves the report,
   investigates the symptoms, and keeps uncertain grouping available for human
   review. A reply does not claim a fix before one has been verified.”
3. **Coding and independent checks, 35 seconds.** Open Changes and the retained
   upload investigation. Show the actual diff and before/after HTTP output.
   “Codex changed the allowed limit in an isolated checkout. The supervisor
   protected the tests and ran them independently: the three failing checks
   become eight passing checks, while oversized and invalid images stay blocked.”
4. **Approval and release, 20 seconds.** Show the exact approved commit and
   verified deployment state. “The recorded run requires approval of the exact
   commit. Deployment and acceptance evidence are separate from the agent's
   claim that its patch works.”
5. **Sponsor evidence, 35 seconds.** Open the fresh neatlogs support trace and
   regression pair, then the Entire checkpoint. “neatlogs captures model calls,
   usage, tools, and failures. Entire keeps the code change and captured session
   context together.” Show the actual cfo.ai model only after it exists; otherwise
   leave this section explicitly marked pending in a draft video.
6. **Close, 20 seconds.** Return to Bloom/Cue. “Cue is an agent for small app teams:
   investigate, propose, review, verify, and update. Today’s demo proves a scoped
   workflow. Wider repository support and organic growth are still to be tested.”

The demonstration app's known upload failure is already fixed in production.
Do not regress it for recording. Use the retained actual run plus the fresh,
clearly labeled temporary-copy trace replay. Do not imply every displayed
stage was performed live during the recording.
