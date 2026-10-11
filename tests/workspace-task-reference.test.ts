import { beforeEach, expect, test, vi } from "vitest";
const store = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn() }));
vi.mock("../lib/server-store", async () => ({
  api: (await import("../convex/_generated/api")).api,
  db: () => store,
  secret: () => "isolated",
}));
vi.mock("../lib/integration-config", () => ({
  readIntegrations: async () => ({
    apps: [{ id: "registered", name: "Bloom", origins: [] }],
  }),
}));
vi.mock("../lib/gemini", () => ({ geminiReady: () => false }));
import { postWorkspace } from "../lib/workspace";
const id = "ms74enwx2wzm87t2qw4x5fkhf58g3fhq";
const other = "ms7dc96jchqsf3wmpfycz865dd8g3vef";
const actor = {
  id: "owner@example.test",
  name: "Owner",
  role: "owner" as const,
};
beforeEach(() => {
  vi.clearAllMocks();
  store.query.mockResolvedValue({ issues: [] });
  store.mutation.mockResolvedValue({
    taskId: id,
    response: "Saved",
    duplicate: false,
  });
});
async function send(
  text: string,
  tasks: { _id: string; agent: string }[],
  taskId?: string,
) {
  store.query.mockResolvedValueOnce({ tasks });
  await postWorkspace(
    {
      agent: "growth",
      appId: "registered",
      text,
      key: "reference-test",
      ...(taskId ? { taskId } : {}),
    },
    actor,
    "Slack",
    "thread",
  );
  return store.mutation.mock.calls[0][1];
}
test("exact saved task reference selects app-scoped context and persists it for Slack thread", async () => {
  const args = await send(`Has ${id} activated? Status only.`, [
    { _id: id, agent: "growth" },
  ]);
  expect(store.query.mock.calls[0][1]).toMatchObject({
    appId: "registered",
    participant: actor.id,
  });
  expect(args).toMatchObject({
    taskId: id,
    threadKey: "thread",
    agent: "growth",
    appId: "registered",
  });
  expect(args).not.toHaveProperty("action");
  expect(args).not.toHaveProperty("growthAction");
});
test("task absent from selected app is never inferred", async () => {
  expect(await send(`Status ${id}`, [])).not.toHaveProperty("taskId");
});
test("task owned by another agent is never inferred", async () => {
  expect(
    await send(`Status ${id}`, [{ _id: id, agent: "engineering" }]),
  ).not.toHaveProperty("taskId");
});
test("ambiguous task references keep agent-level context", async () => {
  expect(
    await send(`Compare ${id} and ${other}`, [
      { _id: id, agent: "growth" },
      { _id: other, agent: "growth" },
    ]),
  ).not.toHaveProperty("taskId");
});
test("explicit selected context takes precedence over task mentioned in text", async () => {
  expect(
    await send(
      `Compare against ${other}`,
      [
        { _id: id, agent: "growth" },
        { _id: other, agent: "growth" },
      ],
      id,
    ),
  ).toHaveProperty("taskId", id);
});
