import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { photo } from "../demo/bloom/fixture.mjs";
nextEnv.loadEnvConfig(process.cwd());
const base = process.env.CUE_VERIFY_ORIGIN;
const expectedRelease = process.env.CUE_VERIFY_RELEASE;
assert(
  base?.startsWith("https:"),
  "Set CUE_VERIFY_ORIGIN to the public HTTPS origin",
);
const checks: string[] = [];
const pass = (name: string) => {
  checks.push(name);
  console.log("PASS · " + name);
};
const fresh = await fetch(base + "/api/bloom");
assert.equal(fresh.status, 200);
const cookieHeader = fresh.headers.get("set-cookie") || "";
assert(
  /HttpOnly/i.test(cookieHeader) &&
    /Secure/i.test(cookieHeader) &&
    /SameSite=strict/i.test(cookieHeader),
);
const cookie = cookieHeader.split(";")[0];
const initial = await fresh.json();
assert.equal(initial.health.hosting, "cloud");
assert.equal(initial.health.maxUploadBytes, 5 * 1024 * 1024);
assert(/^[a-f0-9]{40}$/.test(initial.health.release));
if (expectedRelease) {
  assert.equal(
    initial.health.release,
    expectedRelease,
    "Public deployment must report the expected release before mutation checks",
  );
}
pass(
  "Public HTTPS gateway sets a secure signed customer cookie and identifies its release",
);
async function upload(size: number) {
  const body = new FormData();
  body.append(
    "file",
    new File([photo(size)], "hosting-boundary.png", { type: "image/png" }),
  );
  return fetch(base + "/api/bloom", {
    method: "POST",
    headers: { origin: base!, cookie },
    body,
  });
}
const exact = await upload(5 * 1024 * 1024);
assert.equal(exact.status, 201, await exact.clone().text());
const file = await exact.json();
assert(file.fileId && file.w && file.h);
assert.equal((await upload(5 * 1024 * 1024 + 1)).status, 413);
pass(
  "Public transport accepts exactly 5 MiB and rejects one byte above the contract",
);
const post = (body: unknown, origin = base!) =>
  fetch(base + "/api/bloom", {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie },
    body: JSON.stringify(body),
  });
const save = await post({
  action: "save",
  memory: {
    fileId: file.fileId,
    title: "Public hosting verification",
    caption: "Isolated upload boundary check",
    date: "2026-10-10",
    w: file.w,
    h: file.h,
  },
});
assert.equal(save.status, 200);
const { id } = await save.json();
const saved = await (
  await fetch(base + "/api/bloom", { headers: { cookie } })
).json();
const memory = saved.memories.find((m: { _id: string }) => m._id === id);
assert(memory?.src);
const image = await fetch(memory.src);
assert.equal(image.status, 200);
assert.equal((await image.arrayBuffer()).byteLength, 5 * 1024 * 1024);
assert.equal(
  (await post({ action: "delete", id }, "https://foreign.invalid")).status,
  400,
);
assert.equal((await post({ action: "delete", id })).status, 200);
pass(
  "Real cloud photo storage survives reload; foreign-origin deletion is denied",
);
assert.equal((await fetch(base + "/api/integrations")).status, 401);
assert.equal((await fetch(base + "/api/demo")).status, 401);
pass(
  "Public integration credentials and operator data require WorkOS authentication",
);
const login = await fetch(base + "/auth/login", { redirect: "manual" });
assert.equal(login.status, 307);
const location = new URL(login.headers.get("location")!);
assert.equal(
  location.searchParams.get("redirect_uri"),
  base + "/auth/callback",
);
assert(location.searchParams.get("code_challenge"));
assert(/HttpOnly/i.test(login.headers.get("set-cookie") || ""));
const workspace = await fetch(base + "/cue", { redirect: "manual" });
assert.equal(workspace.status, 302);
assert.equal(workspace.headers.get("location"), base + "/auth/login");
pass("WorkOS initiates PKCE sign-in on the reachable public callback");
await fs.writeFile(
  ".cue/hosting-verification.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      origin: base,
      release: initial.health.release,
      checks,
      limitations: [
        "Native authenticated sign-in, Chrome file chooser, microphone and speakers are verified separately.",
      ],
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(`${checks.length} live public hosting checks passed.`);
