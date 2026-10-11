export const KNOWLEDGE_WORKSPACE = "cue-configured-workspace";
export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;
export const MAX_KNOWLEDGE_TEXT = 200000;
export type Passage = { text: string; heading: string; page?: number };
export function knowledgeScope(
  workspace: string,
  app: string,
  audience: string,
) {
  return JSON.stringify([workspace, app, audience]);
}
export function normalizeQuestion(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function searchTerms(text: string) {
  const stop = new Set(
    "a an the is are was were how what why can could do does did i my me you your please it this that for to of and with in on have has about".split(
      " ",
    ),
  );
  return [
    ...new Set(
      normalizeQuestion(text)
        .split(" ")
        .filter((t) => t.length > 1 && t.length <= 32 && !stop.has(t)),
    ),
  ]
    .slice(0, 16)
    .join(" ");
}
export function chunkKnowledge(pages: Passage[]): Passage[] {
  const result: Passage[] = [];
  for (const page of pages) {
    let heading = page.heading || "Document",
      buffer = "";
    const push = () => {
      if (buffer.trim()) result.push({ ...page, heading, text: buffer.trim() });
    };
    for (const paragraph of page.text.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
      if (/^#{1,6}\s+/.test(paragraph) && buffer) {
        push();
        buffer = "";
      }
      if (/^#{1,6}\s+/.test(paragraph))
        heading = paragraph
          .split("\n")[0]
          .replace(/^#+\s*/, "")
          .slice(0, 160);
      for (let offset = 0; offset < paragraph.length; offset += 1800) {
        const part = paragraph.slice(offset, offset + 1800);
        if (buffer.length + part.length > 2200) {
          push();
          buffer = buffer.slice(-180);
        }
        buffer += (buffer ? "\n\n" : "") + part;
      }
    }
    push();
  }
  if (!result.length || result.length > 160)
    throw new Error("Use a smaller document (up to 160 passages)");
  return result;
}
export function fuseKnowledge<T extends { _id: string; sourceId: string }>(
  keyword: T[],
  semantic: T[],
) {
  const hits = new Map<string, { item: T; score: number }>();
  for (const list of [keyword, semantic])
    list.forEach((item, rank) => {
      const previous = hits.get(item._id);
      hits.set(item._id, {
        item,
        score: (previous?.score || 0) + 1 / (60 + rank + 1),
      });
    });
  const ranked = [...hits.values()].sort((a, b) => b.score - a.score);
  const counts = new Map<string, number>();
  return ranked
    .filter(({ item }) => {
      const n = counts.get(item.sourceId) || 0;
      if (n >= 2) return false;
      counts.set(item.sourceId, n + 1);
      return true;
    })
    .slice(0, 4)
    .map(({ item }) => item);
}
