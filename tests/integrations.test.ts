import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { issueWidgetSession, verifyWidgetSession } from "../lib/widget-session";
import {
  appInput,
  readIntegrations,
  updateIntegrations,
  type WidgetApp,
} from "../lib/integration-config";

beforeEach(() => vi.stubEnv("CUE_DEMO_SECRET", "isolated-widget-secret"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const app: WidgetApp = {
  id: "cue_app_test",
  name: "Test app",
  origins: ["https://app.example.com"],
  createdAt: 1,
};
describe("Connected app security", () => {
  test("widget sessions bind to the app and exact origin, reject forgery and expiration", () => {
    const token = issueWidgetSession(app, app.origins[0]);
    const owner = verifyWidgetSession(token, app, app.origins[0]);
    expect(owner).toMatch(/^widget:cue_app_test:/);
    expect(verifyWidgetSession(token, app, app.origins[0])).toBe(owner);
    expect(() =>
      verifyWidgetSession(token, { ...app, id: "another_app" }, app.origins[0]),
    ).toThrow();
    expect(() =>
      verifyWidgetSession(token, app, "https://other.example.com"),
    ).toThrow();
    expect(() =>
      verifyWidgetSession(token.slice(0, -5) + "wrong", app, app.origins[0]),
    ).toThrow();
    expect(() => issueWidgetSession(app, "https://evil.example.com")).toThrow();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 86400000);
    expect(() => verifyWidgetSession(token, app, app.origins[0])).toThrow(
      "expired",
    );
  });
  test("each visitor receives a separate conversation owner", () => {
    expect(
      verifyWidgetSession(
        issueWidgetSession(app, app.origins[0]),
        app,
        app.origins[0],
      ),
    ).not.toBe(
      verifyWidgetSession(
        issueWidgetSession(app, app.origins[0]),
        app,
        app.origins[0],
      ),
    );
  });
  test("app origins reject insecure hosts, paths and embedded credentials", () => {
    for (const origin of [
      "http://example.com",
      "https://example.com/path",
      "https://user:pass@example.com",
      "https://example.com?token=x",
      "file:///tmp/a",
    ])
      expect(
        appInput.safeParse({ name: "Test", origins: [origin] }).success,
      ).toBe(false);
    expect(
      appInput.parse({
        name: "Test",
        origins: ["http://localhost:4400/", "https://example.com/"],
      }).origins,
    ).toEqual(["http://localhost:4400", "https://example.com"]);
  });
  test("integration credentials survive concurrent updates, remain encrypted and private", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cue-integration-test-"),
    );
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    try {
      await Promise.all([
        updateIntegrations((c) => ({ ...c, apps: [...c.apps, app] })),
        updateIntegrations((c) => ({
          ...c,
          email: { apiKey: "re_private_test_key", from: "support@example.com" },
        })),
      ]);
      const read = await readIntegrations();
      expect(read.apps[0].id).toBe(app.id);
      expect(read.email?.apiKey).toBe("re_private_test_key");
      const file = path.join(directory, ".cue", "integrations.enc"),
        content = await fs.readFile(file, "utf8");
      expect(content).not.toContain("re_private_test_key");
      expect(content).not.toContain("support@example.com");
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      vi.stubEnv("CUE_DEMO_SECRET", "wrong-key");
      await expect(readIntegrations()).rejects.toThrow();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
