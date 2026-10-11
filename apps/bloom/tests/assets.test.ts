import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
test("assembled supplied Bloom design contains executable scripts", () => {
  execFileSync(process.execPath, ["scripts/prepare-assets.mjs"]);
  const source = readFileSync("generated/design.ts", "utf8");
  const html = JSON.parse(
    source.slice("export const bloomHTML = ".length).trim().slice(0, -1),
  ) as string;
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of scripts)
    expect(() => new Script(script[1])).not.toThrow();
});
