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
  expect(html).toContain("Customer problems in.");
  expect(html).toContain("Verified fixes");
  expect(html).toContain("Illustrative reports");
  const nodes = elements(parse(html));
  expect(nodes.filter((n) => n.tagName === "script")).toHaveLength(0);
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
  ).toHaveLength(3);
  for (const id of ["how", "principles", "integrations-l"])
    expect(
      nodes.some((n) => n.attrs.some((a) => a.name === "id" && a.value === id)),
    ).toBe(true);
});
