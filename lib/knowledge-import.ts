import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import { inflateRawSync } from "node:zlib";
import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import {
  chunkKnowledge,
  MAX_KNOWLEDGE_TEXT,
  type Passage,
} from "./knowledge-policy";
export const MAX_KNOWLEDGE_FILE = 10 * 1024 * 1024;
export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18, 19].includes(b))
    );
  }
  if (isIP(address) !== 6) return false;
  const normalized = new URL("https://[" + address + "]/").hostname.replace(
    /[\[\]]/g,
    "",
  );
  return (
    /^[23][0-9a-f]{3}:/i.test(normalized) &&
    !/^(2001:(:|0:|db8)|2002:)/i.test(normalized)
  );
}
export function githubDocumentUrl(value: string) {
  const u = new URL(value);
  if (u.hostname === "github.com") {
    const [owner, repo, blob, ...path] = u.pathname.split("/").filter(Boolean);
    if (!owner || !repo || blob !== "blob" || path.length < 2)
      throw new Error("Use a GitHub document’s file URL");
    return (
      "https://raw.githubusercontent.com/" + [owner, repo, ...path].join("/")
    );
  }
  return value;
}
export async function fetchKnowledgePage(
  value: string,
  redirects = 0,
): Promise<{ bytes: Buffer; type: string; url: string }> {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    redirects > 3
  )
    throw new Error("Use a public HTTPS document URL");
  const addresses = await lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error("Private and local addresses are not allowed");
  // Pin the validated address while TLS checks the original hostname.
  const result = await new Promise<{
    bytes: Buffer;
    type: string;
    status: number;
    location?: string;
  }>((resolve, reject) => {
    const req = https.request(
      {
        hostname: addresses[0].address,
        family: addresses[0].family,
        servername: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          host: u.host,
          "user-agent": "Cue-Knowledge/1.0",
          "accept-encoding": "identity",
        },
        timeout: 20000,
      },
      (response) => {
        const parts: Buffer[] = [];
        let size = 0;
        response.on("data", (part: Buffer) => {
          size += part.length;
          if (size > MAX_KNOWLEDGE_FILE) {
            req.destroy(new Error("Document exceeds 10 MB"));
          } else parts.push(part);
        });
        response.on("end", () =>
          resolve({
            bytes: Buffer.concat(parts),
            type: String(response.headers["content-type"] || ""),
            status: response.statusCode || 0,
            location: response.headers.location,
          }),
        );
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () =>
      req.destroy(new Error("Document request timed out")),
    );
    req.end();
  });
  if (result.status >= 300 && result.status < 400 && result.location)
    return fetchKnowledgePage(new URL(result.location, u).href, redirects + 1);
  if (result.status !== 200)
    throw new Error(
      "Document could not be fetched; upload or paste its contents instead",
    );
  return { bytes: result.bytes, type: result.type, url: u.href };
}
function htmlText(html: string) {
  const root = parse(html);
  const skip = new Set([
    "script",
    "style",
    "nav",
    "footer",
    "header",
    "noscript",
    "svg",
  ]);
  const blocks = new Set([
    "p",
    "div",
    "article",
    "section",
    "li",
    "br",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "tr",
  ]);
  function walk(node: DefaultTreeAdapterMap["node"]): string {
    if (node.nodeName === "#text" && "value" in node) return node.value;
    const tag = "tagName" in node ? node.tagName : "";
    if (skip.has(tag)) return "";
    const content =
      "childNodes" in node ? node.childNodes.map(walk).join(" ") : "";
    return blocks.has(tag)
      ? "\n\n" +
          (/^h[1-6]$/.test(tag) ? "#".repeat(Number(tag[1])) + " " : "") +
          content +
          "\n\n"
      : content;
  }
  return walk(root)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();
}
function validateDocxArchive(bytes: Buffer) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length)
    throw new Error("Document is not a valid DOCX archive");
  const entries = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16),
    expanded = 0;
  if (entries > 1000 || !entries)
    throw new Error("Document DOCX archive is too large");
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("Document DOCX archive is invalid");
    const compressed = bytes.readUInt32LE(cursor + 20),
      size = bytes.readUInt32LE(cursor + 24),
      nameLength = bytes.readUInt16LE(cursor + 28),
      extraLength = bytes.readUInt16LE(cursor + 30),
      commentLength = bytes.readUInt16LE(cursor + 32),
      local = bytes.readUInt32LE(cursor + 42);
    expanded += size;
    if (expanded > 40 * 1024 * 1024)
      throw new Error("Document DOCX contents are too large");
    const name = bytes
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    if (/\.xml$|\.rels$/i.test(name)) {
      if (local + 30 > bytes.length)
        throw new Error("Document DOCX archive is invalid");
      const offset =
          local +
          30 +
          bytes.readUInt16LE(local + 26) +
          bytes.readUInt16LE(local + 28),
        method = bytes.readUInt16LE(cursor + 10);
      if (
        offset + compressed > bytes.length ||
        size > 10 * 1024 * 1024 ||
        ![0, 8].includes(method)
      )
        throw new Error("Document DOCX contents are too large");
      if (method === 8)
        inflateRawSync(bytes.subarray(offset, offset + compressed), {
          maxOutputLength: 10 * 1024 * 1024,
        });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
}
export async function extractKnowledge(bytes: Buffer, name: string, type = "") {
  if (!bytes.length || bytes.length > MAX_KNOWLEDGE_FILE)
    throw new Error("Document must be under 10 MB");
  const extension = name.toLowerCase().split(".").pop();
  let pages: Passage[];
  if (extension === "pdf" || type.includes("application/pdf")) {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: false,
      disableFontFace: true,
    });
    const document = await task.promise;
    if (document.numPages > 100) {
      await task.destroy();
      throw new Error("PDF must have at most 100 pages");
    }
    pages = [];
    try {
      for (let i = 1; i <= document.numPages; i++) {
        const page = await document.getPage(i),
          content = await page.getTextContent();
        const text = content.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
          )
          .join("")
          .trim();
        if (text) pages.push({ text, heading: "Page " + i, page: i });
      }
    } finally {
      await task.destroy();
    }
    if (!pages.length)
      throw new Error(
        "This PDF has no extractable text. Use OCR first, then upload or paste the text",
      );
  } else if (extension === "docx") {
    validateDocxArchive(bytes);
    const mammoth = await import("mammoth");
    pages = [
      {
        text: (await mammoth.extractRawText({ buffer: bytes })).value.trim(),
        heading: name,
      },
    ];
  } else if (
    type.includes("text/html") ||
    ["html", "htm"].includes(extension || "")
  ) {
    pages = [{ text: htmlText(bytes.toString("utf8")), heading: name }];
  } else if (
    ["txt", "md", "markdown", "rst"].includes(extension || "") ||
    /^text\/(plain|markdown)/.test(type)
  ) {
    const text = bytes.toString("utf8");
    if (text.includes("\0")) throw new Error("Document is not a text file");
    pages = [{ text: text.trim(), heading: name }];
  } else throw new Error("Supported files: TXT, Markdown, PDF and DOCX");
  const text = pages.map((p) => p.text).join("\n\n");
  if (!text.trim()) throw new Error("Document is empty");
  if (text.length > MAX_KNOWLEDGE_TEXT)
    throw new Error(
      "Document exceeds 200,000 characters; split it into smaller files",
    );
  return { text, passages: chunkKnowledge(pages) };
}
