import assert from "node:assert/strict";
import { parse, type DefaultTreeAdapterTypes } from "parse5";

const origin = process.env.CUE_VERIFY_ORIGIN || "https://cue.latchgrid.in";
const get = (path: string) =>
  fetch(new URL(path, origin), { redirect: "manual" });
const root = await get("/");
assert.equal(
  root.status,
  200,
  "Root must show the public landing, not redirect to sign-in",
);
assert.match(root.headers.get("content-type") || "", /text\/html/);
const html = await root.text();
assert.match(html, /Customer problems in\./);
assert.match(html, /Verified fixes/);
console.log("PASS · Anonymous root serves the supplied Cue landing");

function elements(
  node: DefaultTreeAdapterTypes.Node,
): DefaultTreeAdapterTypes.Element[] {
  return [
    ...("tagName" in node ? [node] : []),
    ...("childNodes" in node ? node.childNodes.flatMap(elements) : []),
  ];
}
const nodes = elements(parse(html));
const attr = (node: DefaultTreeAdapterTypes.Element, name: string) =>
  node.attrs.find((a) => a.name === name)?.value;
const links = nodes.filter((n) => n.tagName === "a");
assert.equal(links.filter((n) => attr(n, "href") === "/cue#/home").length, 3);
for (const id of ["how", "principles", "integrations-l"]) {
  assert(nodes.some((n) => attr(n, "id") === id));
  assert(links.some((n) => attr(n, "href") === "#" + id));
}
assert(!nodes.some((n) => attr(n, "id") === "app"));
assert(!html.includes("loadCue") && !html.includes("S.cases"));
assert.match(html, /Illustrative reports/);
console.log(
  "PASS · Workspace actions, section links and labeled examples are present; private app omitted",
);

const workspace = await get("/cue");
assert.equal(workspace.status, 302);
assert.equal(workspace.headers.get("location"), origin + "/auth/login");
for (const path of [
  "/api/demo",
  "/api/agents",
  "/api/growth",
  "/api/integrations",
])
  assert.equal(
    (await get(path)).status,
    401,
    `${path} must remain authenticated`,
  );
console.log("PASS · Workspace and operator APIs remain protected");

const login = await get("/auth/login");
assert.equal(login.status, 307);
const destination = new URL(login.headers.get("location")!);
assert.equal(
  destination.searchParams.get("redirect_uri"),
  origin + "/auth/callback",
);
assert(destination.searchParams.has("code_challenge"));
console.log(
  "PASS · Existing WorkOS login still initiates PKCE with the public callback",
);

const health = await (await get("/api/bloom")).json();
assert.match(health.health.release, /^[a-f0-9]{40}$/);
if (process.env.CUE_VERIFY_RELEASE)
  assert.equal(health.health.release, process.env.CUE_VERIFY_RELEASE);
console.log(`PASS · Public application release ${health.health.release}`);
