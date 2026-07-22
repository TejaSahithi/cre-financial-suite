// @ts-nocheck

import { PORTFOLIO_PAYLOAD_SCHEMA_VERSION } from "./types.ts";
import { summarizePortfolioRisk } from "./portfolio-risk-summary.ts";

export function buildPortfolioIntelligencePayloadV1(args: { organizationId: string; portfolioId?: string | null; propertyId?: string | null; snapshot: any; risks?: any[]; criticalDates?: any[]; obligations?: any[]; financialTerms?: any[]; diagnostics?: any }) {
  const risks = args.risks ?? [];
  const criticalDates = args.criticalDates ?? [];
  const obligations = args.obligations ?? [];
  const financialTerms = args.financialTerms ?? [];
  return {
    schemaVersion: PORTFOLIO_PAYLOAD_SCHEMA_VERSION,
    scope: { organizationId: args.organizationId, portfolioId: args.portfolioId ?? null, propertyId: args.propertyId ?? null },
    generatedAt: new Date(0).toISOString(),
    sourceGenerationDigest: args.snapshot.sourceGenerationDigest,
    summary: {
      leaseCount: args.snapshot.leaseCount,
      activeLeaseCount: args.snapshot.activeLeaseCount,
      totalLeasedArea: args.snapshot.totalLeasedArea,
      annualizedBaseRent: args.snapshot.annualizedBaseRent,
      expirationsByYear: args.snapshot.expirationsByYear,
      exclusionsDisclosed: true,
    },
    coverage: args.snapshot.coverageSummary,
    risks: summarizePortfolioRisk(risks),
    criticalDates: { total: criticalDates.length, blocking: criticalDates.filter((event) => event.isBlocking).length, unresolved: criticalDates.filter((event) => event.calculationStatus !== "resolved").length },
    obligations: { total: obligations.length, unresolved: obligations.filter((item) => item.status !== "resolved").length },
    financials: { termCount: financialTerms.length, currencies: [...new Set(financialTerms.map((term) => term.currency).filter(Boolean))].sort(), annualizedBaseRent: args.snapshot.annualizedBaseRent },
    findings: risks,
    diagnostics: { ...(args.diagnostics ?? {}), metricLineageCount: args.snapshot.metricLineage?.length ?? 0 },
  };
}
