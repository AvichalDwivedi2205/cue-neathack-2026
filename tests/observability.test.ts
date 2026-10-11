import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  flush: vi.fn(async () => true),
  shutdown: vi.fn(async () => true),
  trace: vi.fn(),
  google: vi.fn((client) => client),
  vertex: vi.fn((client) => client),
}));
vi.mock("neatlogs", () => ({
  init: sdk.init,
  trace: sdk.trace,
  flush: sdk.flush,
  shutdown: sdk.shutdown,
  wrapGoogleGenAI: sdk.google,
  wrapVertexAI: sdk.vertex,
}));
import {
  observed,
  redactTelemetry,
  recordWorkflowFailure,
  shutdownObservability,
} from "../lib/observability";

describe("Cue telemetry preserves workflow behavior and export privacy", () => {
  const spans: Array<{
    name: string;
    kind: string;
    attributes: Record<string, unknown>;
    status?: unknown;
  }> = [];
  beforeEach(() => {
    vi.stubEnv("NEATLOGS_API_KEY", "test-credential-never-exported");
    vi.clearAllMocks();
    spans.length = 0;
    sdk.trace.mockImplementation(async (options, fn) => {
      const record = {
        name: options.name,
        kind: options.kind,
        attributes: { ...options.attributes },
      } as (typeof spans)[number];
      spans.push(record);
      return fn({
        spanContext: () => ({ traceId: "test-trace" }),
        setAttribute: (key: string, value: unknown) => {
          record.attributes[key] = value;
        },
        setAttributes: (values: Record<string, unknown>) =>
          Object.assign(record.attributes, values),
        setStatus: (status: unknown) => {
          record.status = status;
        },
      });
    });
  });
  afterEach(async () => {
    await shutdownObservability();
    vi.unstubAllEnvs();
  });

  it("redacts nested credentials, JSON attributes, email, and recordings while keeping numeric usage", () => {
    const envelope = redactTelemetry({
      attributes: {
        "input.value": JSON.stringify({
          email: "customer@example.com",
          secret: "hidden",
          inlineData: { data: "raw recording" },
        }),
        "output.value": JSON.stringify({
          audioContent: "raw audio",
          answer: "Bearer private-token test-credential-never-exported",
        }),
        "gen_ai.usage.input_tokens": 42,
        "gen_ai.usage.output_tokens": 7,
      },
    });
    const serialized = JSON.stringify(envelope);
    for (const privateText of [
      "customer@example.com",
      "hidden",
      "raw recording",
      "raw audio",
      "private-token",
      "test-credential-never-exported",
    ])
      expect(serialized).not.toContain(privateText);
    expect(envelope).toMatchObject({
      attributes: {
        "gen_ai.usage.input_tokens": 42,
        "gen_ai.usage.output_tokens": 7,
      },
    });
  });

  it("runs concurrent requests once with separate roots and one initialization", async () => {
    const operation = vi.fn(async (id: number) => id * 2);
    const run = observed("Support", operation);
    expect(await Promise.all([run(1), run(2)])).toEqual([2, 4]);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(spans.map((span) => span.kind)).toEqual(["WORKFLOW", "WORKFLOW"]);
  });

  it("keeps nested agent work under the workflow boundary", async () => {
    const child = observed("Classification", async () => "bug");
    const root = observed("Triage", async () => child());
    expect(await root()).toBe("bug");
    expect(spans.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "Triage", kind: "WORKFLOW" },
      { name: "Classification", kind: "AGENT" },
    ]);
    expect(spans[0].attributes["neatlogs.workflow.name"]).toBe("Triage");
  });

  it("returns the original object and rethrows the original error without retrying effects", async () => {
    const value = { saved: true };
    expect(await observed("Save", async () => value)()).toBe(value);
    const failure = new Error("original failure");
    const operation = vi.fn(async () => {
      throw failure;
    });
    await expect(observed("Failed save", operation)()).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("records supervisor failures even when the existing job API returns normally", async () => {
    await observed("Investigation", async () => {
      recordWorkflowFailure(new Error("independent tests failed"));
    })();
    expect(spans[0].status).toEqual({
      code: 2,
      message: "independent tests failed",
    });
    expect(spans[0].attributes["output.value"]).toContain('"status":"failed"');
  });

  it("works without a tracing credential", async () => {
    vi.stubEnv("NEATLOGS_API_KEY", "");
    vi.stubEnv("CUE_TELEMETRY_LOCAL", "");
    expect(await observed("Local", async () => 9)()).toBe(9);
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.trace).not.toHaveBeenCalled();
  });
});
