// @ts-nocheck

import { annualizeAmount } from "./portfolio-normalization-policy.ts";
import { buildMetricLineage } from "./portfolio-fact-lineage.ts";

export async function sourceGenerationDigest(facts: any[]) {
  const source = facts.map((fact) => `${fact.documentFamilyId}:${fact.generationId ?? fact.source_generation_id ?? "none"}`).sort().join("|");
  const bytes = new TextEncoder().encode(source);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildPortfolioAnalyticsSnapshot(args: { organizationId: string; portfolioId?: string | null; facts: any[]; risks?: any[]; obligations?: any[]; snapshotDate: string }) {
  const activeFacts = args.facts.filter((fact) => (fact.lease_status ?? fact.fields?.lease_status?.normalizedValue ?? "active") !== "expired" && !fact.superseded_at);
  const areaFacts = activeFacts.filter((fact) => Number.isFinite(Number(fact.fields?.leased_area?.normalizedValue ?? fact.leased_area)));
  const rentIncluded: any[] = [];
  const rentExcluded: any[] = [];
  let annualizedBaseRent = 0;
  for (const fact of activeFacts) {
    const amount = Number(fact.fields?.base_rent_current?.normalizedValue ?? fact.base_rent_current);
    const frequency = fact.fields?.base_rent_frequency?.normalizedValue ?? fact.base_rent_frequency ?? "monthly";
    const annualized = annualizeAmount(Number.isFinite(amount) ? amount : null, frequency);
    if (annualized === null || fact.fields?.base_rent_current?.status === "currency_mismatch") {
      rentExcluded.push(fact);
      continue;
    }
    rentIncluded.push(fact);
    annualizedBaseRent += annualized;
  }
  const expirationsByYear: Record<string, number> = {};
  for (const fact of activeFacts) {
    const expiration = fact.fields?.expiration_date?.normalizedValue ?? fact.expiration_date;
    if (!expiration) continue;
    const year = String(expiration).slice(0, 4);
    expirationsByYear[year] = (expirationsByYear[year] ?? 0) + 1;
  }
  const riskByDomain: Record<string, number> = {};
  for (const risk of args.risks ?? []) riskByDomain[risk.riskDomain] = (riskByDomain[risk.riskDomain] ?? 0) + Number(risk.scoreContribution ?? 0);
  const coverageSummary = {
    totalLeaseFamilies: args.facts.length,
    approvedLeaseFamilies: args.facts.filter((fact) => ["approved", "published", "canonical_ready"].includes(fact.status ?? fact.publication_status)).length,
    canonicalReady: args.facts.filter((fact) => ["canonical_ready", "approved", "published"].includes(fact.status ?? fact.publication_status)).length,
    semanticReady: args.facts.filter((fact) => (fact.semantic_status ?? "ready") === "ready").length,
    incomplete: args.facts.filter((fact) => (fact.coverage_status ?? "complete") !== "complete").length,
    blocked: args.facts.filter((fact) => (fact.status ?? fact.publication_status) === "blocked").length,
    approvalCriticalCoverageRate: args.facts.length ? args.facts.filter((fact) => !(fact.lineage?.missingFieldKeys ?? []).includes("expiration_date")).length / args.facts.length : 1,
    financialCoverageRate: args.facts.length ? rentIncluded.length / args.facts.length : 1,
    evidenceCoverageRate: args.facts.length ? args.facts.filter((fact) => (fact.lineage?.sourceEvidenceIds ?? []).length > 0).length / args.facts.length : 1,
    legacyFallbackLeaseCount: args.facts.filter((fact) => (fact.lineage?.legacyFallbackFieldKeys ?? []).length > 0).length,
    staleLeaseCount: args.facts.filter((fact) => fact.stale === true || fact.publication_status === "stale").length,
    unresolvedAmendmentCount: (args.risks ?? []).filter((risk) => risk.ruleKey === "unresolved_amendment_precedence").length,
  };
  return {
    organizationId: args.organizationId,
    portfolioId: args.portfolioId ?? null,
    snapshotDate: args.snapshotDate,
    leaseCount: args.facts.length,
    activeLeaseCount: activeFacts.length,
    totalLeasedArea: areaFacts.length ? areaFacts.reduce((sum, fact) => sum + Number(fact.fields?.leased_area?.normalizedValue ?? fact.leased_area), 0) : null,
    annualizedBaseRent: rentIncluded.length ? annualizedBaseRent : null,
    expirationsByYear,
    rentByProperty: Object.fromEntries(Object.entries(activeFacts.reduce((acc: any, fact: any) => {
      const property = fact.propertyId ?? fact.property_id ?? "unassigned";
      const amount = annualizeAmount(Number(fact.fields?.base_rent_current?.normalizedValue ?? fact.base_rent_current), fact.fields?.base_rent_frequency?.normalizedValue ?? fact.base_rent_frequency ?? "monthly") ?? 0;
      acc[property] = (acc[property] ?? 0) + amount;
      return acc;
    }, {})).sort()),
    riskByDomain,
    coverageSummary,
    reviewSummary: { reviewRequired: args.facts.filter((fact) => (fact.status ?? fact.publication_status) === "review_required").length, blocked: coverageSummary.blocked },
    obligationSummary: { total: (args.obligations ?? []).length, unresolved: (args.obligations ?? []).filter((item) => item.status !== "resolved").length },
    sourceGenerationDigest: await sourceGenerationDigest(args.facts),
    schemaVersion: "portfolio-analytics-snapshot-v1",
    metricLineage: [buildMetricLineage({ metricKey: "annualized_base_rent", facts: rentIncluded, excludedFacts: rentExcluded, sourceFieldKeys: ["base_rent_current", "base_rent_frequency"], aggregationMethod: "sum", normalizationRules: ["annualize_frequency"], warnings: rentExcluded.length ? ["excluded_unannualizable_or_currency_mismatch"] : [] })],
  };
}
