import { api, db, secret } from "./server-store";
import { client } from "./gemini";
import type { Id } from "../convex/_generated/dataModel";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "./knowledge-policy";
import { observed } from "./observability";
export async function embedKnowledge(
  text: string,
  task: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
) {
  const response = await client(false).models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
    config: {
      taskType: task,
      outputDimensionality: EMBEDDING_DIMENSIONS,
      autoTruncate: false,
    },
  });
  const vector = response.embeddings?.[0]?.values;
  if (
    !vector ||
    vector.length !== EMBEDDING_DIMENSIONS ||
    vector.some((n) => !Number.isFinite(n))
  )
    throw new Error("Embedding unavailable");
  return vector;
}
async function indexImpl(
  sourceId: Id<"knowledgeSources">,
  versionId: Id<"knowledgeVersions">,
) {
  const job = await db().mutation(api.knowledge.beginIndex, {
    secret: secret(),
    sourceId,
    versionId,
  });
  if (!job) return;
  try {
    const missing = job.chunks.filter(
      (c) =>
        c.embeddingModel !== EMBEDDING_MODEL ||
        c.embedding?.length !== EMBEDDING_DIMENSIONS,
    );
    for (let i = 0; i < missing.length; i += 4) {
      const batch = await Promise.all(
        missing
          .slice(i, i + 4)
          .map(async (c) => ({
            id: c._id,
            embedding: await embedKnowledge(
              job.version.title + "\n" + c.heading + "\n" + c.text,
              "RETRIEVAL_DOCUMENT",
            ),
          })),
      );
      await db().mutation(api.knowledge.vectors, {
        secret: secret(),
        sourceId,
        versionId,
        vectors: batch,
      });
    }
    await db().mutation(api.knowledge.commit, {
      secret: secret(),
      sourceId,
      versionId,
    });
  } catch {
    await db().mutation(api.knowledge.commit, {
      secret: secret(),
      sourceId,
      versionId,
      error:
        "Indexing could not finish. Check embedding access, then retry Publish. Completed passages are retained.",
    });
    throw new Error("Knowledge indexing failed");
  }
}
export const indexKnowledge = observed("Cue knowledge indexing", indexImpl, {
  input: (sourceId, versionId) => ({ sourceId, versionId }),
  output: () => ({ completed: true }),
});
