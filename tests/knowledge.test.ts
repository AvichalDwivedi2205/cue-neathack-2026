import { expect, test } from "vitest";
import {
  chunkKnowledge,
  fuseKnowledge,
  knowledgeScope,
  normalizeQuestion,
  searchTerms,
} from "../lib/knowledge-policy";
import {
  extractKnowledge,
  githubDocumentUrl,
  publicAddress,
} from "../lib/knowledge-import";
import { validateKnowledgeAnswer } from "../lib/knowledge-answer";
import { readFile } from "node:fs/promises";
test("document chunks retain page provenance and cover long text without unbounded passages", () => {
  const body = "A customer policy. ".repeat(600),
    chunks = chunkKnowledge([{ text: body, heading: "Policy", page: 3 }]);
  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks.every((c) => c.page === 3 && c.text.length < 2500)).toBe(true);
  expect(() => chunkKnowledge([{ text: "", heading: "Blank" }])).toThrow();
  expect(searchTerms("How can I change my account's email address?")).toBe(
    "change account email address",
  );
  expect(searchTerms("word ".repeat(100))).toBe("word");
  expect(normalizeQuestion("How LARGE can my photo be?!")).toBe(
    "how large can my photo be",
  );
  expect(knowledgeScope("a:b", "c", "customer")).not.toBe(
    knowledgeScope("a", "b:c", "customer"),
  );
});
test("rank fusion rewards shared hits and prevents one source crowding out all evidence", () => {
  const a = { _id: "1", sourceId: "a" },
    b = { _id: "2", sourceId: "b" },
    c = { _id: "3", sourceId: "a" },
    d = { _id: "4", sourceId: "a" };
  expect(fuseKnowledge([a, c, d, b], [b, a])[0]).toBe(a);
  expect(
    fuseKnowledge([a, c, d, b], [b, a]).filter((h) => h.sourceId === "a"),
  ).toHaveLength(2);
});
test("imports reject local, metadata, mapped IPv6 and reserved networks", () => {
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "10.1.2.3",
    "172.31.0.1",
    "192.168.1.2",
    "100.64.0.1",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:ffff:7f00:1",
    "fd00::1",
    "fe80::1",
  ])
    expect(publicAddress(address), address).toBe(false);
  expect(publicAddress("8.8.8.8")).toBe(true);
  expect(publicAddress("2606:4700::1111")).toBe(true);
  expect(
    githubDocumentUrl("https://github.com/acme/product/blob/main/docs/help.md"),
  ).toBe("https://raw.githubusercontent.com/acme/product/main/docs/help.md");
  expect(() => githubDocumentUrl("https://github.com/acme/product")).toThrow();
});
test("TXT, HTML, PDF and DOCX extraction preserves text and PDF page numbers", async () => {
  expect(
    (
      await extractKnowledge(
        Buffer.from("# Support\n\nApproved policy"),
        "help.md",
      )
    ).text,
  ).toContain("Approved policy");
  const html = await extractKnowledge(
    Buffer.from(
      "<nav>Navigation</nav><main><h1>Policy</h1><p>Approved policy</p><script>steal()</script></main>",
    ),
    "page.html",
    "text/html",
  );
  expect(html.text).toContain("Approved policy");
  expect(html.text).not.toContain("steal()");
  expect(html.text).not.toContain("Navigation");
  const pdf = await extractKnowledge(
    await readFile("tests/fixtures/knowledge.pdf"),
    "guide.pdf",
  );
  expect(pdf.passages[0].page).toBe(1);
  expect(pdf.text).toContain("Published upload policy");
  const docx = await extractKnowledge(
    await readFile("tests/fixtures/knowledge.docx"),
    "guide.docx",
  );
  expect(docx.text).toContain("Published upload policy");
  await expect(
    extractKnowledge(Buffer.from("binary"), "file.exe"),
  ).rejects.toThrow("Supported files");
});
test("answers require citations from the retrieved set", () => {
  expect(() =>
    validateKnowledgeAnswer(
      { status: "answered", answer: "Invented", citations: ["made-up"] },
      [],
    ),
  ).toThrow();
  expect(() =>
    validateKnowledgeAnswer(
      { status: "answered", answer: "Invented", citations: [] },
      [],
    ),
  ).toThrow();
  expect(
    validateKnowledgeAnswer(
      { status: "needs_review", answer: "Unknown", citations: [] },
      [],
    ).status,
  ).toBe("needs_review");
});
