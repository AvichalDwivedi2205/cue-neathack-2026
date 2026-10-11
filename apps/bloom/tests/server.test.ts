// @vitest-environment node
import { test, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { validGuest, sameOrigin, cue, boundedJSON } from "../lib/server";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
test("signed guest identities reject forged, truncated and cross-project cookies", () => {
  const secret = "only-bloom-knows-this-secret",
    id = "8fdb7b26-d1e4-4ec9-92f8-3b948dd187fb";
  const sig = createHmac("sha256", secret)
    .update("bloom:" + id)
    .digest("hex");
  expect(validGuest(id + "." + sig, secret)).toBe(id);
  expect(validGuest(id + "." + sig, "cue-has-a-different-secret")).toBeNull();
  expect(validGuest(id + "." + sig.slice(0, -1), secret)).toBeNull();
  expect(validGuest(id + "." + sig + ".extra", secret)).toBeNull();
});
test("mutations require the configured host and origin, including on preview domains", () => {
  vi.stubEnv("BLOOM_PUBLIC_URL", "https://bloom.test");
  const request = (host: string, origin: string) =>
    new Request("https://bloom.test/api/bloom", { headers: { host, origin } });
  expect(() =>
    sameOrigin(request("bloom.test", "https://bloom.test")),
  ).not.toThrow();
  expect(() =>
    sameOrigin(request("preview.test", "https://preview.test")),
  ).toThrow("Origin not allowed");
  expect(() => sameOrigin(request("bloom.test", "https://evil.test"))).toThrow(
    "Origin not allowed",
  );
});
test("support proxy fixes Cue destination and app identity; never forwards Bloom's server secret", async () => {
  vi.stubEnv("BLOOM_PUBLIC_URL", "https://bloom.test");
  vi.stubEnv("CUE_PUBLIC_URL", "https://cue.test");
  vi.stubEnv("CUE_WIDGET_APP_ID", "registered-bloom");
  vi.stubEnv("BLOOM_SERVER_SECRET", "secret-never-forwarded");
  const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "case-one" }));
  vi.stubGlobal("fetch", fetcher);
  await cue("/api/widget", {
    action: "message",
    app: "evil-app",
    origin: "https://evil.test",
    text: "Help",
    token: "visitor-cue-token",
  });
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toBe("https://cue.test/api/widget");
  expect(options.headers.origin).toBe("https://cue.test");
  expect(JSON.parse(options.body)).toEqual({
    action: "message",
    app: "registered-bloom",
    origin: "https://bloom.test",
    text: "Help",
    token: "visitor-cue-token",
  });
  expect(JSON.stringify(options)).not.toContain("secret-never-forwarded");
});
test("JSON limits are enforced against bytes even without a content-length header", async () => {
  const body = JSON.stringify({ x: "é".repeat(12) });
  await expect(
    boundedJSON(
      new Request("https://bloom.test", { method: "POST", body }),
      20,
    ),
  ).rejects.toThrow("too large");
  expect(
    await boundedJSON(
      new Request("https://bloom.test", { method: "POST", body }),
      100,
    ),
  ).toEqual({ x: "é".repeat(12) });
});
