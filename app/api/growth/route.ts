import { z } from "zod";
import { ConvexError } from "convex/values";
import { operator, sameOrigin } from "@/lib/access";
import { api, db, secret } from "@/lib/server-store";
import { workspaceApp } from "@/lib/workspace";
import { observedRelease, prepareGrowthLink } from "@/lib/growth";
import { hash } from "@/lib/growth-links";
import { growthX } from "@/lib/growth-x";
import { createXApi } from "@/lib/x-api";
import { sendGrowthReview } from "@/lib/growth-slack";
export const runtime = "nodejs";
const input = z
  .object({
    appId: z.string().max(100),
    action: z.enum([
      "discover",
      "qualify",
      "draft",
      "edit",
      "requestReview",
      "approve",
      "reject",
      "record",
      "dismiss",
      "restore",
      "pause",
      "feature",
      "capture",
      "query",
    ]),
    campaignId: z.string().max(100).optional(),
    opportunityId: z.string().max(100).optional(),
    draftId: z.string().max(100).optional(),
    hash: z.string().max(64).optional(),
    text: z.string().max(280).optional(),
    url: z.string().max(500).optional(),
    paused: z.boolean().optional(),
    query: z.string().min(1).max(500).optional(),
    source: z
      .object({
        url: z.url().max(500),
        text: z.string().max(1200).optional(),
        author: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const publicError = (e: unknown) =>
  e instanceof ConvexError && typeof e.data === "string"
    ? e.data
    : e instanceof z.ZodError
      ? "Invalid Growth action or context"
      : "Growth request unavailable; saved work preserved. Inspect Activity or review provider access.";
export async function GET(request: Request) {
  try {
    await operator(request);
    const { app } = await workspaceApp(
      new URL(request.url).searchParams.get("app") || undefined,
    );
    let releaseHealth = "";
    try {
      await observedRelease(app.id);
    } catch {
      releaseHealth =
        "Deployed evidence could not be refreshed. New actions require a successful release check.";
    }
    const saved = await db().query(api.growth.snapshot, {
      secret: secret(),
      appId: app.id,
    });
    return Response.json(
      { ...saved, appId: app.id, releaseHealth },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Growth sign-in or app unavailable" },
      { status: 401 },
    );
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const user = await operator(request),
      actor = { id: user.email, name: user.name, role: user.role };
    const raw = await request.text();
    if (raw.length > 3000) throw new Error("Invalid request");
    const a = input.parse(JSON.parse(raw));
    const { config } = await workspaceApp(a.appId);
    const { release } = await observedRelease(a.appId);
    const saved = await db().query(api.growth.snapshot, {
      secret: secret(),
      appId: a.appId,
    });
    const o = a.opportunityId
      ? saved.opportunities.find((o) => o._id === a.opportunityId)
      : undefined;
    const d = a.draftId
      ? saved.drafts.find((d) => d._id === a.draftId)
      : o &&
        saved.drafts
          .filter((d) => d.opportunityId === o._id)
          .sort((a, b) => b.version - a.version)[0];
    const c = a.campaignId
      ? saved.campaigns.find((c) => c._id === a.campaignId)
      : o
        ? saved.campaigns.find((c) => c._id === o.campaignId)
        : saved.campaigns[0];
    switch (a.action) {
      case "query":
        if (!c || !a.query)
          throw new ConvexError("Campaign and query required");
        await db().mutation(api.growth.updateQuery, {
          secret: secret(),
          actor,
          appId: a.appId,
          campaignId: c._id,
          release,
          query: a.query,
        });
        break;
      case "capture": {
        if (!["owner", "product"].includes(actor.role) || !c || !a.source)
          throw new ConvexError("Product source capture required");
        const url = new URL(a.source.url);
        if (["x.com", "twitter.com"].includes(url.hostname)) {
          if (!config.x)
            throw new Error("Official X source access unavailable");
          await createXApi(config.x).credits();
          const source = await growthX(config.x).source(a.source.url);
          await db().mutation(api.growth.capture, {
            secret: secret(),
            appId: a.appId,
            campaignId: c._id,
            ...source,
            channel: "x",
            provenance:
              "Operator-assisted official X read. Discovery checkpoint unchanged.",
            controlled: source.author.toLowerCase() === "@confusedaf2205",
          });
        } else if (
          ["reddit.com", "www.reddit.com"].includes(url.hostname) &&
          /^\/r\/[^/]+\/comments\/[^/]+/.test(url.pathname) &&
          a.source.text &&
          a.source.author
        ) {
          url.search = "";
          url.hash = "";
          await db().mutation(api.growth.capture, {
            secret: secret(),
            appId: a.appId,
            campaignId: c._id,
            sourceKey: "reddit:" + url.pathname,
            sourceUrl: url.toString(),
            channel: "reddit",
            author: a.source.author,
            text: a.source.text,
            sourceAt: Date.now(),
            provenance:
              "Operator supplied Reddit text and source. General API discovery unavailable; original content not independently fetched.",
            controlled: /bloomwithcue|controlled/i.test(a.source.author),
          });
        } else
          throw new ConvexError(
            "Supported source URL and explicit Reddit text required",
          );
        break;
      }
      case "feature":
        if (!o) throw new Error("Opportunity missing");
        await db().mutation(api.growthExecution.feature, {
          secret: secret(),
          actor,
          appId: a.appId,
          opportunityId: o._id,
        });
        break;
      case "discover":
      case "qualify":
      case "draft": {
        if (!c) throw new Error("Verified campaign required");
        if (a.action === "draft" && o)
          await prepareGrowthLink(a.appId, o._id, actor);
        const taskId = await db().mutation(api.growth.request, {
          secret: secret(),
          actor,
          appId: a.appId,
          action: a.action,
          campaignId: c._id,
          ...(o ? { opportunityId: o._id } : {}),
          release,
          automatic: true,
        });
        return Response.json({ ok: true, taskId });
      }
      case "edit":
        if (!o || !a.text) throw new Error("Draft context missing");
        await db().mutation(api.growth.saveDraft, {
          secret: secret(),
          actor,
          appId: a.appId,
          opportunityId: o._id,
          release,
          text: a.text.trim(),
          hash: hash(a.text.trim()),
        });
        break;
      case "requestReview":
        if (!d || !a.hash) throw new Error("Exact draft required");
        await db().mutation(api.growth.requestReview, {
          secret: secret(),
          actor,
          appId: a.appId,
          draftId: d._id,
          hash: a.hash,
          release,
        });
        return Response.json({
          ok: true,
          delivery: await sendGrowthReview(a.appId, d._id),
        });
      case "approve":
      case "reject":
        if (!d || !a.hash) throw new Error("Exact draft required");
        await db().mutation(api.growth.decide, {
          secret: secret(),
          actor,
          appId: a.appId,
          draftId: d._id,
          hash: a.hash,
          release,
          approve: a.action === "approve",
        });
        break;
      case "record": {
        if (!d || !a.hash || !a.url || !config.x)
          throw new Error("Exact approved draft and publication URL required");
        const touch = await db().mutation(api.growthAttribution.report, {
          secret: secret(),
          actor,
          appId: a.appId,
          draftId: d._id,
          hash: a.hash,
          release,
          publicationUrl: a.url,
        });
        const opp = saved.opportunities.find((o) => o._id === d.opportunityId);
        try {
          if (!opp || opp.channel !== "x")
            throw new Error("Publication requires official X verification");
          await createXApi(config.x).credits();
          const method = await growthX(config.x).verify(
            a.url,
            opp.sourceKey.replace(/^x:/, ""),
            d.text,
            touch.link,
            opp.author,
          );
          await db().mutation(api.growthAttribution.verify, {
            secret: secret(),
            touchId: touch._id,
            hash: d.hash,
            publicationUrl: a.url,
            ok: true,
            method,
          });
        } catch (e) {
          await db().mutation(api.growthAttribution.verify, {
            secret: secret(),
            touchId: touch._id,
            hash: d.hash,
            publicationUrl: a.url,
            ok: false,
            method:
              e instanceof Error
                ? e.message
                : "Independent publication unavailable",
          });
          throw new Error(
            "Publication check failed. Reported URL retained; review source, author, content and provider access.",
          );
        }
        break;
      }
      case "dismiss":
      case "restore":
        if (!o) throw new Error("Opportunity missing");
        await db().mutation(api.growthExecution.dismiss, {
          secret: secret(),
          actor,
          appId: a.appId,
          opportunityId: o._id,
          restore: a.action === "restore",
        });
        break;
      case "pause":
        if (!c || a.paused === undefined) throw new Error("Campaign required");
        if (!a.paused) {
          if (!["owner", "product"].includes(actor.role))
            throw new ConvexError("Product role required");
          if (!config.x?.enabled)
            throw new ConvexError(
              "Connect official X discovery before starting Growth",
            );
          const credits = await createXApi(config.x).credits();
          if (credits.freeBalance < 1.1)
            throw new ConvexError(
              "Free credits below conservative search reserve",
            );
        }
        await db().mutation(api.growthExecution.pause, {
          secret: secret(),
          actor,
          appId: a.appId,
          campaignId: c._id,
          paused: a.paused,
          release,
        });
        break;
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: publicError(e) }, { status: 400 });
  }
}
