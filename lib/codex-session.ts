import type { Thread, ThreadEvent } from "@openai/codex-sdk";
import { annotateTelemetry, observed } from "./observability";

// The Codex SDK has no supported neatlogs provider wrapper. Capture the whole
// streamed agent operation, and use only the SDK's reported aggregate usage.
export const runCodexSession = observed(
  "Cue Codex agent",
  async (
    thread: Thread,
    prompt: string,
    signal: AbortSignal,
    onEvent: (event: ThreadEvent) => Promise<void>,
  ) => {
    const result = await thread.runStreamed(prompt, { signal });
    for await (const event of result.events) {
      if (event.type === "turn.completed") {
        annotateTelemetry({
          "gen_ai.usage.input_tokens": event.usage.input_tokens,
          "gen_ai.usage.output_tokens": event.usage.output_tokens,
          "cue.usage.cached_input_tokens": event.usage.cached_input_tokens,
        });
      }
      await onEvent(event);
    }
  },
  { input: (_thread, prompt) => ({ prompt }), kind: "AGENT" },
);
