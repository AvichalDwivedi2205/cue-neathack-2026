import { AsyncLocalStorage } from "node:async_hooks";
import {
  init,
  trace,
  flush,
  shutdown,
  wrapGoogleGenAI,
  wrapVertexAI,
  type TraceSpanKind,
} from "neatlogs";

const active = new AsyncLocalStorage<{
  failure?: string;
  traceId: string;
  annotate: (attributes: Record<string, string | number>) => void;
}>();
let initialization: Promise<boolean> | undefined;
let tracingEnabled = false;

// Mask at the final export boundary, including JSON embedded in span attributes.
// Keep the numeric usage fields intact so cost and latency remain inspectable.
export function redactTelemetry(value: unknown, key = ""): unknown {
  if (
    /^((api|private)[_-]?key|authorization|secret|password|cookie|(access|refresh|bearer|api)[_-]?token|audioContent|inlineData|fileData)$/i.test(
      key,
    )
  )
    return "[redacted]";
  if (Buffer.isBuffer(value)) return { bytes: value.length };
  if (typeof value === "string") {
    if (/^[\s]*[\[{]/.test(value)) {
      try {
        return JSON.stringify(redactTelemetry(JSON.parse(value)));
      } catch {
        /* Ordinary text, not serialized JSON. */
      }
    }
    let text = value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
    for (const [name, secret] of Object.entries(process.env))
      if (
        /(KEY|SECRET|TOKEN|PASSWORD|COOKIE|CREDENTIAL)/i.test(name) &&
        secret &&
        secret.length >= 8
      )
        text = text.split(secret).join("[redacted]");
    // Raw recordings and other binary payloads have no debugging value here.
    if (/^[A-Za-z0-9+/]{256,}={0,2}$/.test(text)) return "[binary redacted]";
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redactTelemetry(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        redactTelemetry(item, name),
      ]),
    );
  return value;
}

export async function initializeObservability() {
  if (!process.env.NEATLOGS_API_KEY && process.env.CUE_TELEMETRY_LOCAL !== "1")
    return false;
  initialization ??= init({
    workflowName: "Cue",
    tags: ["neathack-2026", process.env.NODE_ENV || "development"],
    pii: "redact",
    captureLogs: false,
    mask: (data) => redactTelemetry(data) as Record<string, unknown>,
    ...(process.env.CUE_TELEMETRY_LOCAL === "1"
      ? { disableExport: true, diagnosticCapture: true }
      : {}),
  })
    .then(() => {
      tracingEnabled = true;
      return true;
    })
    .catch(() => {
      console.error(
        "Cue tracing initialization unavailable; workflow will continue",
      );
      return false;
    });
  return initialization;
}

export function instrumentModel<T extends object>(
  client: T,
  vertex: boolean,
): T {
  // Each provider call has one owner: the appropriate official SDK wrapper.
  if (!tracingEnabled) return client;
  return vertex ? wrapVertexAI(client) : wrapGoogleGenAI(client);
}

export function observed<Args extends unknown[], Result>(
  name: string,
  operation: (...args: Args) => Promise<Result>,
  options: { kind?: TraceSpanKind; input?: (...args: Args) => unknown } = {},
) {
  return async (...args: Args): Promise<Result> => {
    if (!(await initializeObservability())) return operation(...args);
    const nested = active.getStore();
    return trace(
      {
        name,
        kind: options.kind || (nested ? "AGENT" : "WORKFLOW"),
        input: redactTelemetry(options.input ? options.input(...args) : args),
        attributes: { "neatlogs.workflow.name": name },
      },
      (span) => {
        const state = {
          traceId: span.spanContext().traceId,
          failure: undefined as string | undefined,
          annotate: (attributes: Record<string, string | number>) =>
            span.setAttributes(attributes),
        };
        return active.run(state, async () => {
          const result = await operation(...args);
          span.setStatus(
            state.failure ? { code: 2, message: state.failure } : { code: 1 },
          );
          span.setAttribute(
            "output.value",
            JSON.stringify(
              redactTelemetry(
                state.failure
                  ? { status: "failed", error: state.failure }
                  : (result ?? { completed: true }),
              ),
            ),
          );
          return result;
        });
      },
    );
  };
}

export function recordWorkflowFailure(error: unknown) {
  const state = active.getStore();
  if (state)
    state.failure = String(
      redactTelemetry(error instanceof Error ? error.message : String(error)),
    );
}

export function annotateTelemetry(attributes: Record<string, string | number>) {
  active.getStore()?.annotate(attributes);
}

export function currentTraceId() {
  return active.getStore()?.traceId;
}

export async function flushObservability() {
  return initialization ? flush() : true;
}

export async function shutdownObservability() {
  if (initialization) await shutdown();
  initialization = undefined;
  tracingEnabled = false;
}
