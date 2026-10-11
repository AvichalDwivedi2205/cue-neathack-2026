import { randomUUID } from "node:crypto";
import { api, db, secret } from "./server-store";
import { workspaceApp, type WorkspaceActor } from "./workspace";
import { createXApi } from "./x-api";
import { growthX } from "./growth-x";
import { qualifyGrowth, draftGrowth } from "./growth-model";
import { hash, issueGrowthToken } from "./growth-links";
import type { Id } from "../convex/_generated/dataModel";
import { observed } from "./observability";
export async function observedRelease(appId: string) {
  const { app } = await workspaceApp(appId);
  const destination = app.origins.find(
    (o) =>
      o ===
      (process.env.CUE_BLOOM_PUBLIC_URL || "https://bloom-with-cue.vercel.app"),
  );
  if (!destination)
    throw new Error("Growth requires registered standalone Bloom origin");
  const response = await fetch(destination + "/api/health", {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("Deployed Bloom acceptance unavailable");
  const data = await response.json();
  const release = data.release;
  if (data.appId !== appId || data.captionSearch !== "owned-caption-all-terms")
    throw new Error("Deployed capability contract unavailable");
  if (typeof release !== "string" || !/^[a-f0-9]{40}$/.test(release))
    throw new Error("Deployed release identity unavailable");
  await db().mutation(api.growth.observeRelease, {
    secret: secret(),
    appId,
    release,
  });
  return { release, destination };
}
export async function prepareGrowthLink(
  appId: string,
  opportunityId: Id<"growthOpportunities">,
  actor: WorkspaceActor,
) {
  const { destination } = await observedRelease(appId);
  const token = issueGrowthToken();
  const origin = new URL(process.env.CUE_PUBLIC_URL || "http://127.0.0.1:3000")
    .origin;
  return db().mutation(api.growthAttribution.prepare, {
    secret: secret(),
    actor,
    appId,
    opportunityId,
    tokenHash: hash(token),
    link: origin + "/g/" + token,
    destination,
    expiresAt: Date.now() + 7 * 86400000,
  });
}
async function processGrowthImpl(receiptId: Id<"growthReceipts">) {
  const token = randomUUID();
  if (
    !(await db().mutation(api.growthExecution.begin, {
      secret: secret(),
      receiptId,
      token,
    }))
  )
    return;
  try {
    const job = await db().query(api.growth.job, {
      secret: secret(),
      receiptId,
    });
    if (!job) return;
    const { release } = await observedRelease(job.receipt.appId);
    if (!job.capability.valid || job.capability.release !== release)
      throw new Error("Capability release evidence stale");
    let detail = "";
    if (job.receipt.action === "discover") {
      const { config } = await workspaceApp(job.receipt.appId);
      const x = config.x;
      if (!x?.enabled)
        throw new Error(
          "Official X discovery connection is unavailable for this app",
        );
      const account = await createXApi(x).credits();
      if (account.freeBalance < 1.1)
        throw new Error("Free credits below conservative search reserve");
      const pageToken = randomUUID();
      const campaign = await db().mutation(api.growthExecution.reservePage, {
        secret: secret(),
        campaignId: job.campaign._id,
        token: pageToken,
      });
      if (!campaign)
        throw new Error("Discovery lease or provider cooldown active");
      try {
        const page = await growthX(x).search(campaign.query, {
          sinceId: campaign.sinceId,
          nextToken: campaign.nextToken,
        });
        for (const p of page.posts)
          await db().mutation(api.growth.capture, {
            secret: secret(),
            appId: campaign.appId,
            campaignId: campaign._id,
            sourceKey: "x:" + p.id,
            channel: "x",
            author: "@" + p.author,
            text: p.text,
            sourceAt: p.sourceAt,
            sourceUrl: p.sourceUrl,
            provenance:
              "Agent discovery · Official X recent search; query: " +
              campaign.query,
            controlled: p.author.toLowerCase() === "confusedaf2205",
          });
        await db().mutation(api.growthExecution.page, {
          secret: secret(),
          campaignId: campaign._id,
          token: pageToken,
          nextToken: page.nextToken,
          newestId: page.newestId,
        });
        detail = `Official recent search returned ${page.posts.length} posts; 10 reads reserved. Sources saved, no public reply sent.`;
      } catch (e) {
        await db().mutation(api.growthExecution.page, {
          secret: secret(),
          campaignId: campaign._id,
          token: pageToken,
          error: e instanceof Error ? e.message : "Search unavailable",
        });
        throw e;
      }
    } else if (job.receipt.action === "qualify") {
      if (!job.opportunity) throw new Error("Opportunity missing");
      const stale =
        job.opportunity.sourceAt < Date.now() - 7 * 86400000 ||
        job.opportunity.sourceAt > Date.now() + 300000;
      const result = stale
        ? {
            need: job.opportunity.text,
            eligible: false,
            matched: false,
            fit: "Low" as const,
            reasons: ["Historical source"],
          }
        : await qualifyGrowth(job.opportunity.text, {
            need: job.capability.need,
            claims: job.capability.claims,
          });
      await db().mutation(api.growth.qualify, {
        secret: secret(),
        receiptId,
        token,
        release,
        ...result,
      });
      detail =
        "Source-qualified result saved against verified deployed capability";
    } else {
      if (!job.opportunity) throw new Error("Opportunity missing");
      const touch = await prepareGrowthLink(
        job.receipt.appId,
        job.opportunity._id,
        job.receipt.actor,
      );
      const text = await draftGrowth(
        job.opportunity.text,
        job.capability.claims,
        touch.link,
        (await workspaceApp(job.receipt.appId)).app.name,
      );
      await db().mutation(api.growthExecution.commitDraft, {
        secret: secret(),
        receiptId,
        token,
        release,
        text,
        hash: hash(text),
      });
      detail =
        "Draft saved for exact-version Product review. No public message sent.";
    }
    await db().mutation(api.growthExecution.finish, {
      secret: secret(),
      receiptId,
      token,
      ok: true,
      detail,
    });
  } catch (e) {
    await db().mutation(api.growthExecution.finish, {
      secret: secret(),
      receiptId,
      token,
      ok: false,
      detail: e instanceof Error ? e.message : "Growth provider unavailable",
    });
    throw new Error("Growth work unavailable; source and attempt retained");
  }
}

export const processGrowth = observed(
  "Cue growth execution",
  processGrowthImpl,
);
