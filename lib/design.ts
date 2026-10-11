import { promises as fs } from "node:fs";
import path from "node:path";
export async function design(name: "bloom" | "cue") {
  let html = await fs.readFile(
    path.join(process.cwd(), "design", name + ".html"),
    "utf8",
  );
  let bridge = await fs.readFile(
    path.join(process.cwd(), "lib/browser", name + ".js"),
    "utf8",
  );
  if (name === "cue")
    bridge +=
      "\n" +
      (await fs.readFile(
        path.join(process.cwd(), "lib/browser/workspace.js"),
        "utf8",
      )) +
      "\n" +
      (await fs.readFile(
        path.join(process.cwd(), "lib/browser/growth.js"),
        "utf8",
      )) +
      "\n" +
      (await fs.readFile(
        path.join(process.cwd(), "lib/browser/prospects.js"),
        "utf8",
      ));
  html = html.replace(
    name === "cue"
      ? "/* ------------------------------------------------------------------ boot */"
      : "/* ---------- Boot ---------- */",
    bridge +
      "\n" +
      (name === "cue"
        ? "/* ------------------------------------------------------------------ boot */"
        : "/* ---------- Boot ---------- */"),
  );
  if (name === "cue")
    html = html
      .replace(
        'href="#/${k}"',
        "href=\"${k === 'knowledge' ? '/knowledge' : k === 'setup' ? '/setup' : k === 'prospects' ? '#/growth/prospects' : '#/' + k}\"",
      )
      .replace(
        "['integrations', 'Integrations', 'plug', '']",
        "['knowledge', 'Knowledge', 'bulb', ''], ['setup', 'App setup', 'widget', ''], ['prospects', 'Cue customers', 'search', ''], ['integrations', 'Integrations', 'plug', '']",
      )
      .replace("['Grow', ['growth']]", "['Grow', ['growth', 'prospects']]")
      .replace(
        "['knowledge', 'integrations', 'settings']",
        "['knowledge', 'integrations', 'setup', 'settings']",
      )
      .replace(
        "const nav = [['home'",
        "const navActive = k => k === 'prospects' ? S.sec === 'growth' && S.growth?.tab === 'prospects' : S.sec === k && !(k === 'growth' && S.growth?.tab === 'prospects'); const nav = [['home'",
      )
      .replaceAll("S.sec === k ?", "navActive(k) ?")
      .replace("const gLink = o => ", "let gLink = o => ")
      .replace(
        "g.state === 'empty' || (!g.opps.length && !g.campaigns.length)",
        "(g.state === 'empty' || (!g.opps.length && !g.campaigns.length)) && g.tab !== 'results'",
      )
      .replace(
        "const commit = () => S.run.rev ? 'b71e04d' : 'a3f9c2e';",
        "const commit = () => S.liveRun?.commit?.slice(0,8) || 'pending';",
      )
      .replaceAll("@bloomapp", "@bloomwithcue")
      .replace(
        "const frStatus = f => ",
        "const frStatus = f => f.status === 'released' ? '<span class=\"chip ok\">Released · verified</span>' : ",
      )
      .replace(
        "<span>Tagged @bloomwithcue</span>",
        "<span>${/@bloomwithcue\\b/i.test(m.text) ? 'Tagged @bloomwithcue' : 'X post'}</span>",
      )
      .replaceAll(
        "<span>Captured by operator</span>",
        "<span>${esc(c.source.intakeLabel || 'Captured by operator')}</span>",
      )
      .replaceAll("a3f9c2e", "example")
      .replaceAll("bloom/bloom-app#128", "Example pull request");
  if (name === "cue" && process.env.CUE_BLOOM_PUBLIC_URL) {
    const bloomOrigin = new URL(process.env.CUE_BLOOM_PUBLIC_URL).origin;
    html = html.replaceAll('href="/bloom', 'href="' + bloomOrigin + "/");
  }
  html = html
    .replace(
      "</head>",
      '<link rel="stylesheet" href="/cue-voice.css"><script src="/cue-voice.js"></script></head>',
    )
    .replaceAll('href="bloom.html"', 'href="/bloom"')
    .replaceAll('href="cue.html"', 'href="/cue"');
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
