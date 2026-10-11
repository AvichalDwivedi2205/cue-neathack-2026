import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), config: vi.fn() }));
vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: mocks.auth }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../lib/server-store", () => ({ secret: () => "test-secret" }));
vi.mock("../lib/integration-config", () => ({ slackConfig: mocks.config }));
import { operator } from "../lib/access";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WORKOS_API_KEY", "test");
  vi.stubEnv("WORKOS_CLIENT_ID", "test");
  vi.stubEnv("WORKOS_COOKIE_PASSWORD", "test");
  vi.stubEnv("CUE_OPERATOR_EMAIL", "owner@example.com");
  mocks.config.mockResolvedValue({
    members: [
      {
        email: "support@example.com",
        name: "Aria",
        role: "support",
        slackId: "USUPPORT",
      },
      {
        email: "owner@example.com",
        name: "Avichal",
        role: "owner",
        slackId: "UOWNER",
      },
    ],
  });
});
afterEach(() => vi.unstubAllEnvs());
const request = new Request("http://localhost:3000/api/demo", {
  headers: { host: "localhost:3000" },
});
test("operator uses verified WorkOS identity and current server membership, ignoring supplied role claims", async () => {
  mocks.auth.mockResolvedValue({
    user: {
      id: "user-aria",
      email: "support@example.com",
      emailVerified: true,
      firstName: "Aria",
    },
    role: "owner",
  });
  expect(await operator(request)).toMatchObject({
    id: "user-aria",
    name: "Aria",
    role: "support",
  });
  mocks.config.mockResolvedValue({ members: [] });
  await expect(operator(request)).rejects.toThrow("access");
});
test.each([
  null,
  { id: "user", email: "support@example.com", emailVerified: false },
  { id: "user", email: "stranger@example.com", emailVerified: true },
])("unknown or unverified identity cannot enter Cue: %j", async (user) => {
  mocks.auth.mockResolvedValue({ user });
  await expect(operator(request)).rejects.toThrow();
});
test("configured owner retains authority and selected display name", async () => {
  mocks.auth.mockResolvedValue({
    user: { id: "owner", email: "owner@example.com", emailVerified: true },
  });
  expect(await operator(request)).toMatchObject({
    name: "Avichal",
    role: "owner",
  });
});
