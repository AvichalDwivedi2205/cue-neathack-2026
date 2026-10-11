import { z } from "zod";
import { observed, annotateTelemetry } from "./observability";

export const prospectSearchInput = z
  .object({
    query: z.string().trim().min(10).max(400),
    limit: z.number().int().min(1).max(5),
  })
  .strict();
export const defaultProspectQuery =
  "Small companies building consumer mobile apps for journaling, habits, wellness or personal productivity";
const info = z
  .object({
    name: z.string().nullish(),
    primary_domain: z.string().nullish(),
    description: z.string().nullish(),
    employee_count_range: z.string().nullish(),
  })
  .passthrough();
const company = z
  .object({
    crustdata_company_id: z.number().int().positive(),
    basic_info: info.nullish(),
    headcount: z
      .object({ total: z.number().nonnegative().nullish() })
      .passthrough()
      .nullish(),
    locations: z
      .object({ country: z.string().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type ProspectCompany = {
  companyId: number;
  name: string;
  domain: string;
  description: string;
  employees: number | null;
  country: string | null;
  enriched: boolean;
  fit: "potential" | "review" | "low";
  reasons: string[];
  gaps: string[];
};
const endpoint = z.object({
  path: z.string(),
  status: z.string(),
  base_credits: z.number().nonnegative().optional(),
  premium_filters: z
    .array(z.object({ field: z.string(), credits: z.number().nonnegative() }))
    .optional(),
  premium_fields: z
    .array(z.object({ field: z.string(), credits: z.number().nonnegative() }))
    .optional(),
});
export function prospectDomain(value: string) {
  const domain = value
    .toLowerCase()
    .replace(/^www\./, "")
    .trim();
  return domain.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)
    ? domain
    : "";
}
export function assessProspect(
  c: z.infer<typeof company>,
  enriched: boolean,
): ProspectCompany {
  const description = (c.basic_info?.description || "").slice(0, 1600);
  const domain = prospectDomain(c.basic_info?.primary_domain || "");
  const employees = c.headcount?.total ?? null;
  const relevant =
    /\b(journal\w*|habit\w*|wellness|meditation|personal productivity|consumer|mental health|fitness|self[- ]care)\b/i.test(
      description,
    );
  const product =
    /\b(apps?|mobile|software|platform|digital|subscription)\b/i.test(
      description,
    );
  const small = employees !== null && employees >= 1 && employees <= 50;
  const reasons = [];
  if (relevant)
    reasons.push(
      "Company description mentions a consumer-product category in Cue's target hypothesis.",
    );
  if (product)
    reasons.push("Description mentions an app, software or digital product.");
  if (small)
    reasons.push(
      `Reported team size is ${employees}, within the 1–50 employee target.`,
    );
  const gaps = [
    "Customer-feedback volume, engineering constraints and willingness to pay are unverified.",
  ];
  if (!enriched)
    gaps.push("Exact-ID enrichment unavailable; facts are from search only.");
  if (employees === null) gaps.push("Employee count is unavailable.");
  if (!domain)
    gaps.push(
      "Website unavailable; verify the company and product identity before shortlisting.",
    );
  if (!relevant || !product)
    gaps.push("Read the company website to verify its product and audience.");
  return {
    companyId: c.crustdata_company_id,
    name: (c.basic_info?.name || "Unnamed company").slice(0, 120),
    domain,
    description,
    employees,
    country: c.locations?.country?.slice(0, 80) || null,
    enriched,
    fit:
      employees !== null && employees > 50
        ? "low"
        : relevant && product && small && enriched && domain
          ? "potential"
          : "review",
    reasons,
    gaps,
  };
}

export function estimatedResearchCredits(data: unknown, limit: number) {
  const { endpoints } = z.object({ endpoints: z.array(endpoint) }).parse(data);
  const search = endpoints.find((e) => e.path === "/company/search");
  const enrich = endpoints.find((e) => e.path === "/company/enrich");
  if (
    search?.status !== "enabled" ||
    enrich?.status !== "enabled" ||
    search.base_credits === undefined ||
    enrich.base_credits === undefined
  )
    throw new Error(
      "Crustdata company search and enrichment access are required",
    );
  // Search filters on headcount once; no premium fields are received in search.
  const headcount =
    search.premium_filters?.find((p) => p.field === "headcount")?.credits ?? 0;
  const estimate =
    Math.ceil(
      (search.base_credits + headcount + enrich.base_credits) * limit * 100,
    ) / 100;
  if (!Number.isFinite(estimate) || estimate > 15)
    throw new Error("Crustdata price exceeds the 15-credit per-search ceiling");
  return estimate;
}

export function createCrustdata(key: string, fetcher: typeof fetch = fetch) {
  if (!key.trim()) throw new Error("Crustdata is not configured");
  const request = observed(
    "Crustdata company API",
    async (path: string, body?: unknown) => {
      let response: Response;
      try {
        response = await fetcher("https://api.crustdata.com" + path, {
          method: body ? "POST" : "GET",
          redirect: "error",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            "x-api-version": "2025-11-01",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(20000),
        });
      } catch {
        throw new Error(
          "Crustdata request timed out or could not connect; no automatic retry was made",
        );
      }
      annotateTelemetry({
        "crustdata.endpoint": path,
        "http.status_code": response.status,
      });
      if (!response.ok)
        throw new Error(
          `Crustdata request failed (${response.status}); check access or balance`,
        );
      const raw = await response.text();
      if (raw.length > 1000000)
        throw new Error("Crustdata response exceeded the supported size");
      const creditHeader = response.headers.get("x-credits-used");
      const credits = creditHeader === null ? null : Number(creditHeader);
      return {
        data: JSON.parse(raw) as unknown,
        credits:
          credits !== null && Number.isFinite(credits) && credits >= 0
            ? credits
            : null,
      };
    },
    {
      kind: "TOOL",
      input: (path, body) => ({ path, body }),
      output: (result) => ({ received: true, usedCredits: result.credits }),
    },
  );
  return {
    async pricing(limit: number) {
      return estimatedResearchCredits(
        (await request("/account/endpoints", undefined)).data,
        limit,
      );
    },
    async research(input: z.infer<typeof prospectSearchInput>) {
      const { query, limit } = prospectSearchInput.parse(input);
      const search = await request("/company/search", {
        search: { query, mode: "hybrid" },
        filters: {
          op: "and",
          conditions: [
            { field: "headcount.total", type: "=>", value: 1 },
            { field: "headcount.total", type: "=<", value: 50 },
          ],
        },
        fields: [
          "basic_info.name",
          "basic_info.primary_domain",
          "basic_info.description",
        ],
        limit,
      });
      const found = z
        .object({ companies: z.array(company) })
        .parse(search.data).companies;
      // Never enrich more than the reserved budget, including malformed duplicate records.
      const unique = [
        ...new Map(found.map((c) => [c.crustdata_company_id, c])).values(),
      ].slice(0, limit);
      if (!unique.length)
        return { companies: [], usedCredits: search.credits, warning: null };
      let enrich: Awaited<ReturnType<typeof request>>;
      try {
        enrich = await request("/company/enrich", {
          crustdata_company_ids: unique.map((c) => c.crustdata_company_id),
          fields: ["basic_info", "headcount", "locations"],
        });
      } catch {
        return {
          companies: unique.map((c) => assessProspect(c, false)),
          usedCredits: null,
          warning:
            "Enrichment failed. Search results retained for review; billing may include an attempted enrichment.",
        };
      }
      const entries = z
        .array(
          z.object({ matches: z.array(z.object({ company_data: company })) }),
        )
        .parse(enrich.data);
      const results = unique.map((original) => {
        const matches = entries
          .flatMap((e) => e.matches)
          .filter(
            (m) =>
              m.company_data.crustdata_company_id ===
              original.crustdata_company_id,
          );
        // Exact-ID association is checked; ambiguous responses never silently choose a match.
        return assessProspect(
          matches.length === 1 ? matches[0].company_data : original,
          matches.length === 1,
        );
      });
      return {
        companies: results,
        usedCredits:
          search.credits !== null && enrich.credits !== null
            ? search.credits + enrich.credits
            : null,
        warning: null,
      };
    },
  };
}
