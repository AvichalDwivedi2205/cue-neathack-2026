import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("../../../", import.meta.url);
const app = new URL("../", import.meta.url);
await mkdir(new URL("generated/", app), { recursive: true });
await mkdir(new URL("public/", app), { recursive: true });
const shell = await readFile(new URL("design/bloom.html", root), "utf8");
const bridge = await readFile(new URL("lib/browser/bloom.js", root), "utf8");
const upload = await readFile(new URL("browser/direct-upload.js", app), "utf8");
const growth = await readFile(new URL("browser/growth.js", app), "utf8");
const marker = "/* ---------- Boot ---------- */";
if (!shell.includes(marker) || !bridge.includes("loadBloom();"))
  throw new Error("Bloom design boot marker is missing");
const html = shell
  .replace(
    marker,
    bridge.replace(
      "\nloadBloom();\n",
      "\nconst bloomInitialLoad = loadBloom();\n",
    ) +
      "\n" +
      upload +
      "\n" +
      growth +
      "\n" +
      marker,
  )
  .replace(
    "</head>",
    '<link rel="stylesheet" href="/cue-voice.css"><script src="/cue-voice.js"></script></head>',
  )
  .replaceAll('href="bloom.html"', 'href="/"')
  .replaceAll('href="cue.html"', 'href="https://cue.latchgrid.in/cue"');
await writeFile(
  new URL("generated/design.ts", app),
  "export const bloomHTML = " + JSON.stringify(html) + ";\n",
);
for (const name of ["cue-voice.js", "cue-voice.css", "memory-search.js"]) {
  await copyFile(
    new URL("public/" + name, root),
    new URL("public/" + name, app),
  );
}
console.log(
  "Prepared Bloom design and shared support assets for " + fileURLToPath(app),
);
