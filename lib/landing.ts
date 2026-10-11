import {
  parse,
  serialize,
  serializeOuter,
  type DefaultTreeAdapterTypes,
} from "parse5";

type Element = DefaultTreeAdapterTypes.Element;
function elements(node: DefaultTreeAdapterTypes.Node): Element[] {
  return [
    ...("tagName" in node ? [node] : []),
    ...("childNodes" in node ? node.childNodes.flatMap(elements) : []),
  ];
}
const attr = (node: Element, name: string) =>
  node.attrs.find((a) => a.name === name);

// Reuse the supplied visual design without serving its workspace, fixtures,
// simulated actions or authenticated browser bridge to anonymous visitors.
export function renderCueLanding(source: string) {
  const nodes = elements(parse(source));
  const head = nodes.find((n) => n.tagName === "head");
  const landing = nodes.find((n) => attr(n, "id")?.value === "landing");
  if (!head || !landing)
    throw new Error("Cue design is missing its landing page");
  head.childNodes = head.childNodes.filter(
    (n) => !("tagName" in n && n.tagName === "script"),
  );
  const publicNodes = elements(landing);
  for (const node of publicNodes) {
    const href = attr(node, "href");
    if (href?.value === "#/inbox") href.value = "/cue#/home";
    if (href?.value === "#/") href.value = "/";
  }

  let content = serializeOuter(landing);
  const ticker = publicNodes.find((n) => attr(n, "id")?.value === "ticker");
  const marquee = publicNodes.find((n) => attr(n, "id")?.value === "marquee");
  if (!ticker || !marquee)
    throw new Error("Cue design is missing its landing illustrations");
  const reports = [
    ["X", "Maya Chen", "Every photo from my phone gets rejected.", "#3563C9"],
    [
      "In-app chat",
      "Oliver Park",
      "My 3 MB photo won’t upload, but your app says up to 5 MB.",
      "#1E7A53",
    ],
    ["Email", "Aisha Patel", "Upload returns HTTP 413.", "#8A5A2B"],
  ];
  const examples = reports
    .map(
      ([channel, name, text, color]) =>
        `<div class="t-item"><span class="av sm" style="background:${color}" aria-hidden="true">${name
          .split(" ")
          .map((w) => w[0])
          .join(
            "",
          )}</span><div class="t-body"><div class="t-top"><b>${name}</b>${channel}<span class="t-tag">Example</span></div><div class="t-text">${text}</div></div></div>`,
    )
    .join("");
  content = content
    .replace(
      serializeOuter(ticker),
      `<div class="ticker-list" id="ticker">${examples}</div>`,
    )
    .replace(
      'aria-label="Incoming reports, live"',
      'aria-label="Illustrative reports"',
    )
    .replace("Incoming · Bloom", "Example · Bloom")
    .replace(
      '<span class="live"><i class="pulse"></i>Live</span>',
      "<span>Illustrative reports</span>",
    );
  const integrations = [
    ["widget", "In-app widget"],
    ["github", "GitHub"],
    ["bot", "Codex"],
    ["slack", "Slack"],
    ["mail", "Email"],
    ["xlogo", "X"],
  ];
  const strip = integrations
    .map(
      ([icon, name]) =>
        `<span><i data-ic="${icon}" data-s="18"></i>${name}</span>`,
    )
    .join("");
  content = content.replace(
    serializeOuter(marquee),
    `<div class="marquee-track" id="marquee">${strip}<span aria-hidden="true">${strip}</span></div>`,
  );

  // SVG path literals only: no evaluation of the design's application script.
  const iconBlock = source.split("const P = {")[1]?.split("\n};")[0] || "";
  const icons = Object.fromEntries(
    [...iconBlock.matchAll(/(\w+): '([^']*)'/g)].map((m) => [m[1], m[2]]),
  );
  content = content.replace(
    /<i\s+([^>]*data-ic="[^>]+)><\/i>/g,
    (placeholder, attributes: string) => {
      const name = attributes.match(/data-ic="([^"]+)"/)?.[1];
      if (!name || !icons[name])
        throw new Error(`Unknown Cue landing icon: ${name}`);
      const size = attributes.match(/data-s="(\d+)"/)?.[1] || "16";
      const color = attributes.match(/data-c="([^"]+)"/)?.[1] || "currentColor";
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${name === "cue" ? 3.2 : 1.8}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
    },
  );
  const publicHead = serialize(head).replace(
    "Cue — Bloom workspace",
    "Cue — customer problems to verified fixes",
  );
  return `<!doctype html><html lang="en"><head>${publicHead}<link rel="icon" href="/cue-icon.svg"><style>html{scroll-behavior:smooth;scroll-padding-top:80px} .ticker-list{height:auto;min-height:270px} .ticker-list::after{display:none} .t-item .t-text{white-space:normal} .t-tag{white-space:nowrap} .lnav{border-bottom-color:var(--line)} #marquee>span[aria-hidden]{display:contents} @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}</style></head><body>${content}</body></html>`;
}
