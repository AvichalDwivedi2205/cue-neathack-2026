import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import nextEnv from "@next/env";
import { photo } from "../demo/bloom/fixture.mjs";
nextEnv.loadEnvConfig(process.cwd());
const origin =
  process.env.BLOOM_VERIFY_ORIGIN || "https://bloom-with-cue.vercel.app";
const release = process.env.BLOOM_VERIFY_RELEASE;
assert(
  release && /^[a-f0-9]{40}$/.test(release),
  "Exact deployed Bloom release required",
);
const health = await (await fetch(origin + "/api/health")).json();
assert.equal(health.release, release);
assert.equal(health.captionSearch, "owned-caption-all-terms");
const checks: string[] = [];
const pass = (s: string) => {
  checks.push(s);
  console.log("PASS · " + s);
};
const guest = async () => {
  const r = await fetch(origin + "/api/bloom");
  assert.equal(r.status, 200);
  return (r.headers.get("set-cookie") || "").split(";")[0];
};
const cookie = await guest();
assert(cookie);
const post = async (body: object, c = cookie, o = origin) => {
  const r = await fetch(origin + "/api/bloom", {
    method: "POST",
    headers: { cookie: c, origin: o, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { r, data: await r.json() };
};
const { data: ticket } = await post({ action: "uploadTicket" });
const uploaded = await fetch(ticket.url, {
  method: "POST",
  headers: {
    origin,
    authorization: "Bearer " + ticket.token,
    "content-type": "image/png",
  },
  body: photo(1024),
});
assert.equal(uploaded.status, 201);
const { fileId } = await uploaded.json();
assert.equal((await post({ action: "finishUpload", fileId })).r.status, 200);
const ids: string[] = [];
try {
  for (const [title, caption] of [
    ["TitleOnlyZebra", "Saffron lantern beside quiet river"],
    ["Second controlled entry", "Blue lantern on distant mountain"],
  ]) {
    const s = await post({
      action: "save",
      memory: { fileId, title, caption, date: "2026-10-11", w: 16, h: 16 },
    });
    assert.equal(s.r.status, 200);
    ids.push(s.data.id);
  }
  const search = async (query: string, c = cookie) => {
    const s = await post({ action: "search", query }, c);
    assert.equal(s.r.status, 200);
    return s.data.ids;
  };
  assert.deepEqual(await search("  RIVER  saffron "), [ids[0]]);
  pass(
    "Owned caption search ignores case, trims spaces, and requires every query term",
  );
  assert.deepEqual((await search("lantern")).sort(), [...ids].sort());
  pass("Caption search returns both saved matching memories");
  assert.deepEqual(await search("saffron mountain"), []);
  assert.deepEqual(await search("TitleOnlyZebra"), []);
  pass(
    "Terms split across entries and title-only matches cannot satisfy caption search",
  );
  assert.deepEqual(await search("river", await guest()), []);
  pass("Different signed guest cannot search another journal");
  const restored = await (
    await fetch(origin + "/api/bloom", { headers: { cookie } })
  ).json();
  assert.equal(restored.memories.length, 2);
  assert(restored.memories.every((m: { id: string }) => ids.includes(m.id)));
  pass("Saved memories survive public-host reload");
  assert.equal(
    (
      await post(
        { action: "search", query: "river" },
        cookie,
        "https://foreign.example",
      )
    ).r.status,
    403,
  );
  pass("Foreign-origin search mutation rejected");
  assert.equal(
    (await (await fetch(origin + "/api/health")).json()).release,
    release,
  );
  const evidence = {
    appId: health.appId,
    origin,
    release,
    checkedAt: new Date().toISOString(),
    passed: true,
    checks,
  };
  await fs.mkdir(".cue", { recursive: true });
  await fs.writeFile(
    ".cue/growth-capability-verification.json",
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
  if (process.env.CUE_REGISTER_CAPABILITY === "true") {
    const { api, db, secret } = await import("../lib/server-store");
    assert(process.env.CUE_OPERATOR_EMAIL, "Configured Owner required");
    const id = await db().mutation(api.growth.verifyCapability, {
      secret: secret(),
      actor: {
        id: process.env.CUE_OPERATOR_EMAIL,
        name: "Avichal",
        role: "owner",
      },
      appId: health.appId,
      release,
      name: "Find saved memories by caption",
      need: "Find an older photo-journal memory by words written in its caption",
      claims: [
        "Save a photo memory with a caption in the browser",
        "Find saved memories using all words in a caption query",
      ],
      evidence: JSON.stringify(evidence),
    });
    console.log("Verified capability saved · " + id);
  }
} finally {
  for (const id of ids) await post({ action: "delete", id });
}
