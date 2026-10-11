import { expect, test } from "vitest";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { GET } from "../app/route";

function elements(
  node: DefaultTreeAdapterTypes.Node,
): DefaultTreeAdapterTypes.Element[] {
  return [
    ...("tagName" in node ? [node] : []),
    ...("childNodes" in node ? node.childNodes.flatMap(elements) : []),
  ];
}

test("anonymous root renders only the public portion of the supplied design", async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  const html = await response.text();
  const nodes = elements(parse(html));
  const scripts = nodes.filter((n) => n.tagName === "script");
  expect(scripts).toHaveLength(1);
  expect(scripts[0].attrs.find((a) => a.name === "src")?.value).toBe(
    "/cue-landing.js",
  );
  expect(scripts[0].childNodes).toHaveLength(0);
  const heading = nodes.find((n) => n.tagName === "h1");
  expect(
    heading?.childNodes.map((n) => ("value" in n ? n.value : "")).join(" "),
  ).toContain("Your customers already told you.");
  expect(
    nodes.some((n) =>
      n.attrs.some(
        (a) => a.name === "aria-label" && a.value === "Illustrative reports",
      ),
    ),
  ).toBe(true);
  expect(
    nodes.some((n) =>
      n.attrs.some((a) => a.name === "id" && a.value === "app"),
    ),
  ).toBe(false);
  expect(html).not.toContain("loadCue");
  expect(html).not.toContain("data-ic=");
  expect(nodes.filter((n) => n.tagName === "svg").length).toBeGreaterThan(6);
  expect(
    nodes.filter(
      (n) =>
        n.tagName === "a" &&
        n.attrs.some((a) => a.name === "href" && a.value === "/cue#/home"),
    ),
  ).toHaveLength(4);
  expect(
    nodes.some((n) =>
      n.attrs.some((a) => a.name === "href" && a.value.startsWith("#/")),
    ),
  ).toBe(false);
  for (const id of [
    "how",
    "principles",
    "workspace",
    "faq",
    "act-grow",
    "act-agents",
  ])
    expect(
      nodes.some((n) => n.attrs.some((a) => a.name === "id" && a.value === id)),
    ).toBe(true);
});
