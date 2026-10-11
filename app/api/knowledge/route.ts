import { createHash } from "node:crypto";
import { z } from "zod";
import { operator, sameOrigin } from "@/lib/access";
import { readIntegrations } from "@/lib/integration-config";
import { api, db, secret } from "@/lib/server-store";
import {
  chunkKnowledge,
  KNOWLEDGE_WORKSPACE,
  MAX_KNOWLEDGE_TEXT,
  type Passage,
} from "@/lib/knowledge-policy";
import {
  extractKnowledge,
  fetchKnowledgePage,
  githubDocumentUrl,
  MAX_KNOWLEDGE_FILE,
} from "@/lib/knowledge-import";
import { answerKnowledge, SUPPORT_MODELS } from "@/lib/knowledge-answer";
import type { Id } from "@/convex/_generated/dataModel";
export const runtime = "nodejs";
const input = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("save"),
      appId: z.string().max(100),
      sourceId: z.string().max(100).optional(),
      expectedRevision: z.number().int().optional(),
      kind: z.enum(["faq", "text", "file", "url", "github"]),
      title: z.string().trim().min(1).max(160),
      visibility: z.enum(["customer", "internal"]),
      text: z.string().max(MAX_KNOWLEDGE_TEXT).optional(),
      question: z.string().trim().max(500).optional(),
      answer: z.string().trim().max(5000).optional(),
      alternatives: z
        .array(z.string().trim().min(1).max(500))
        .max(10)
        .optional(),
      url: z.string().url().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.enum(["publish", "withdraw"]),
      appId: z.string().max(100),
      sourceId: z.string().max(100),
      expectedRevision: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("test"),
      appId: z.string().max(100),
      question: z.string().trim().min(1).max(2000),
      model: z.enum(SUPPORT_MODELS).optional(),
      mode: z.enum(["hybrid", "keyword"]).optional(),
    })
    .strict(),
]);
async function scope(appId: string) {
  const app = (await readIntegrations()).apps.find((a) => a.id === appId);
  if (!app) throw new Error("Register the application in Setup first");
  return {
    app,
    args: { secret: secret(), workspaceId: KNOWLEDGE_WORKSPACE, appId },
  };
}
export async function GET(request: Request) {
  try {
    const user = await operator(request),
      u = new URL(request.url),
      apps = (await readIntegrations()).apps;
    const appId = u.searchParams.get("app") || apps[0]?.id;
    const permissions = {
      canEdit: ["owner", "product", "support"].includes(user.role),
      canPublish: ["owner", "product"].includes(user.role),
    };
    const model = process.env.CUE_SUPPORT_MODEL || "gemini-2.5-flash";
    if (!appId)
      return Response.json(
        {
          apps: [],
          sources: [],
          ...permissions,
          model,
          litellm: !!process.env.LITELLM_API_KEY,
        },
        { headers: { "cache-control": "no-store" } },
      );
    const { args } = await scope(appId),
      sourceId = u.searchParams.get("source");
    if (sourceId) {
      if (u.searchParams.get("download") === "1") {
        const file = await db().query(api.knowledge.fileUrl, {
          ...args,
          sourceId: sourceId as Id<"knowledgeSources">,
        });
        if (!file)
          return Response.json(
            { error: "No original file on this revision" },
            { status: 404 },
          );
        const content = await fetch(file.url);
        if (!content.ok) throw new Error("Document storage failed");
        return new Response(await content.arrayBuffer(), {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition":
              "attachment; filename*=UTF-8''" + encodeURIComponent(file.name),
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }
      const detail = await db().query(api.knowledge.detail, {
        ...args,
        sourceId: sourceId as Id<"knowledgeSources">,
      });
      // Original storage IDs stay on the server. Only extracted content is edited here.
      const version = detail.version && {
        ...detail.version,
        fileId: undefined,
      };
      return Response.json(
        { ...detail, version },
        { headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(
      {
        apps: apps.map((a) => ({ id: a.id, name: a.name })),
        sources: await db().query(api.knowledge.snapshot, args),
        ...permissions,
        model,
        litellm: !!process.env.LITELLM_API_KEY,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Sign in to Cue and select an authorised application" },
      { status: 401 },
    );
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const user = await operator(request);
    if (!["owner", "product", "support"].includes(user.role))
      return Response.json(
        { error: "Owner, Product or Support role required" },
        { status: 403 },
      );
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      if (
        Number(request.headers.get("content-length") || 0) >
        MAX_KNOWLEDGE_FILE + 10000
      )
        throw new Error("Document must be under 10 MB");
      const form = await request.formData(),
        file = form.get("file"),
        appId = String(form.get("appId") || "");
      const visibility = z
        .enum(["customer", "internal"])
        .parse(form.get("visibility"));
      if (
        !(file instanceof File) ||
        !file.size ||
        file.size > MAX_KNOWLEDGE_FILE
      )
        throw new Error("Document must be under 10 MB");
      const { args } = await scope(appId),
        bytes = Buffer.from(await file.arrayBuffer());
      const extracted = await extractKnowledge(bytes, file.name, file.type);
      const url = await db().mutation(api.knowledge.uploadUrl, {
        secret: secret(),
      });
      const upload = await fetch(url, {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: bytes,
      });
      if (!upload.ok) throw new Error("Document storage failed");
      const { storageId } = await upload.json();
      const sourceId = await db().mutation(api.knowledge.save, {
        ...args,
        ...extracted,
        hash: createHash("sha256").update(extracted.text).digest("hex"),
        title: String(form.get("title") || file.name).slice(0, 160),
        kind: "file",
        visibility,
        actor: user.email,
        fileId: storageId,
        fileName: file.name.slice(0, 200),
      });
      return Response.json({ sourceId });
    }
    const raw = await request.text();
    if (raw.length > MAX_KNOWLEDGE_TEXT + 15000)
      throw new Error("Document exceeds 200,000 characters");
    const a = input.parse(JSON.parse(raw)),
      { app, args } = await scope(a.appId);
    if (a.action === "test") {
      const answer = await answerKnowledge(
        app.id,
        { appName: app.name, message: a.question, channel: "chat" },
        { model: a.model, mode: a.mode },
      );
      return Response.json({
        text: answer.text,
        status: answer.status,
        provider: answer.provider,
        model: answer.model,
        inputTokens: answer.inputTokens,
        outputTokens: answer.outputTokens,
        retrieval: answer.retrieval,
        citations: answer.hits
          .filter((h) => answer.citedIds.includes(h._id))
          .map((h) => ({
            id: h._id,
            title: h.title,
            heading: h.heading,
            page: h.page,
            excerpt: h.text,
          })),
        passages: answer.hits.map((h) => ({
          title: h.title,
          heading: h.heading,
          page: h.page,
          excerpt: h.text,
        })),
      });
    }
    if (a.action === "publish" || a.action === "withdraw") {
      if (!["owner", "product"].includes(user.role))
        return Response.json(
          { error: "Owner or Product role required to publish or withdraw" },
          { status: 403 },
        );
      const sourceId = a.sourceId as Id<"knowledgeSources">;
      if (a.action === "publish") {
        if (a.expectedRevision === undefined)
          throw new Error("Source changed; reload before publishing");
        await db().mutation(api.knowledge.publish, {
          ...args,
          sourceId,
          expectedRevision: a.expectedRevision,
        });
      } else await db().mutation(api.knowledge.withdraw, { ...args, sourceId });
      return Response.json({ ok: true });
    }
    if (a.action !== "save") throw new Error("Invalid knowledge action");
    let text = a.text || "",
      passages: Passage[] = [],
      sourceUrl: string | undefined;
    if (a.kind === "faq") {
      if (!a.question || !a.answer)
        throw new Error("FAQ needs a question and answer");
      text = [a.question, ...(a.alternatives || []), a.answer].join("\n\n");
      passages = [{ text, heading: a.question }];
    } else if (a.url && ["url", "github"].includes(a.kind)) {
      const fetched = await fetchKnowledgePage(
        a.kind === "github" ? githubDocumentUrl(a.url) : a.url,
      );
      const extracted = await extractKnowledge(
        fetched.bytes,
        new URL(fetched.url).pathname.split("/").pop() || "page.html",
        fetched.type,
      );
      text = extracted.text;
      passages = extracted.passages;
      sourceUrl = a.url;
    } else passages = chunkKnowledge([{ text, heading: a.title }]);
    const sourceId = await db().mutation(api.knowledge.save, {
      ...args,
      sourceId: a.sourceId as Id<"knowledgeSources"> | undefined,
      expectedRevision: a.expectedRevision,
      kind: a.kind,
      title: a.title,
      visibility: a.visibility,
      text,
      passages,
      hash: createHash("sha256").update(text).digest("hex"),
      actor: user.email,
      ...(a.kind === "faq"
        ? {
            question: a.question,
            answer: a.answer,
            alternatives: a.alternatives || [],
          }
        : {}),
      ...(sourceUrl ? { url: sourceUrl } : {}),
    });
    return Response.json({ sourceId });
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    const safe =
      /^(Document |Supported files:|This PDF |PDF must |Use a |Use OCR |Private and local|FAQ needs|Register the application|Source changed)/.test(
        message,
      )
        ? message.slice(0, 250)
        : "Could not complete this knowledge action. Check the input and permissions, then retry.";
    return Response.json({ error: safe }, { status: 400 });
  }
}
