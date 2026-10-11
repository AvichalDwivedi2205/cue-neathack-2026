import { expect, test, vi } from "vitest";
import {
  createCrustdata,
  estimatedResearchCredits,
  assessProspect,
  prospectDomain,
} from "../lib/crustdata";
const pricing = {
  endpoints: [
    { path: "/account/endpoints", status: "enabled" },
    {
      path: "/company/search",
      status: "enabled",
      base_credits: 0.03,
      premium_filters: [{ field: "headcount", credits: 0.2 }],
    },
    { path: "/company/enrich", status: "enabled", base_credits: 2 },
  ],
};
const company = (id = 1) => ({
  crustdata_company_id: id,
  basic_info: {
    name: "Habit team",
    primary_domain: "www.habit.example",
    description: "A mobile habit app for consumer wellness",
  },
  headcount: { total: 8 },
  locations: { country: "India" },
  people: [{ email: "private@example.test" }],
});
test("reservation uses actual account pricing, free endpoints may omit prices, and excessive/missing access fails closed", () => {
  expect(estimatedResearchCredits(pricing, 5)).toBe(11.15);
  const expensive = structuredClone(pricing);
  expensive.endpoints[2].base_credits = 20;
  expect(() => estimatedResearchCredits(expensive, 5)).toThrow("ceiling");
  expect(() => estimatedResearchCredits({ endpoints: [] }, 5)).toThrow(
    "access",
  );
  const missing = structuredClone(pricing);
  delete missing.endpoints[2].base_credits;
  expect(() => estimatedResearchCredits(missing, 5)).toThrow("access");
});
test("paid calls request only company fields, cap IDs, preserve exact associations and discard personal fields", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        { companies: [company(1), company(1), company(2), company(3)] },
        { headers: { "x-credits-used": ".46" } },
      ),
    )
    .mockResolvedValueOnce(
      Response.json(
        [
          { matches: [{ company_data: company(2) }] },
          { matches: [{ company_data: company(999) }] },
        ],
        { headers: { "x-credits-used": "4" } },
      ),
    );
  const result = await createCrustdata("secret-key", fetcher).research({
    query: "Small consumer habit apps",
    limit: 2,
  });
  expect(result.usedCredits).toBe(4.46);
  expect(result.companies.map((c) => [c.companyId, c.enriched])).toEqual([
    [1, false],
    [2, true],
  ]);
  expect(JSON.stringify(result)).not.toContain("private@example");
  const options = fetcher.mock.calls[0][1]!;
  expect(options.redirect).toBe("error");
  expect(options.headers).toMatchObject({
    authorization: "Bearer secret-key",
    "x-api-version": "2025-11-01",
  });
  const body = JSON.parse(options.body as string);
  expect(body.limit).toBe(2);
  // Crustdata deliberately uses these inclusive operators, unlike JS/SQL.
  expect(body.filters.conditions).toEqual([
    { field: "headcount.total", type: "=>", value: 1 },
    { field: "headcount.total", type: "=<", value: 50 },
  ]);
  expect(body.fields).toEqual([
    "basic_info.name",
    "basic_info.primary_domain",
    "basic_info.description",
  ]);
  expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toEqual({
    crustdata_company_ids: [1, 2],
    fields: ["basic_info", "headcount", "locations"],
  });
});
test("enrichment failure retains search evidence with unknown spend and no retry", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ companies: [company()] }))
    .mockResolvedValueOnce(
      new Response("sensitive account details", { status: 429 }),
    );
  const result = await createCrustdata("secret", fetcher).research({
    query: "Small consumer habit apps",
    limit: 1,
  });
  expect(result.companies[0]).toMatchObject({ enriched: false, fit: "review" });
  expect(result.usedCredits).toBeNull();
  expect(result.warning).toContain("Enrichment failed");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain("sensitive");
});
test("fit requires product evidence, target size and exact enrichment; a company profile never establishes buying intent", () => {
  expect(assessProspect(company(), true).fit).toBe("potential");
  const missingWebsite = assessProspect(
    {
      ...company(),
      basic_info: { ...company().basic_info, primary_domain: null },
    },
    true,
  );
  expect(missingWebsite.fit).toBe("review");
  expect(missingWebsite.gaps.join()).toContain("verify the company");
  expect(
    assessProspect({ ...company(), headcount: { total: 200 } }, true).fit,
  ).toBe("low");
  expect(assessProspect({ ...company(), headcount: null }, true).fit).toBe(
    "review",
  );
  expect(assessProspect(company(), true).gaps.join()).toContain(
    "willingness to pay are unverified",
  );
  for (const unsafe of [
    "javascript:alert(1)",
    "evil.test/a",
    "a@evil.test",
    "127.0.0.1",
    "<script>",
  ])
    expect(prospectDomain(unsafe)).toBe("");
});
test("oversized search and provider error payloads cannot trigger paid requests or leak credentials", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("secret-key", { status: 401 }));
  const client = createCrustdata("secret-key", fetcher);
  await expect(
    client.research({ query: "Valid company query", limit: 6 }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await expect(
    client.research({ query: "Valid company query", limit: 1 }),
  ).rejects.toThrow("Crustdata request failed (401)");
});
