// @ts-nocheck

import { PORTFOLIO_FACT_SCHEMA_VERSION, PORTFOLIO_INTELLIGENCE_ALGORITHM_VERSION } from "./types.ts";
import { buildPortfolioLeaseFact } from "./portfolio-fact-builder.ts";

export function portfolioRefreshIdempotencyKey(args: { organizationId: string; documentFamilyId: string; sourceGenerationId: string; schemaVersion?: string; algorithmVersion?: string }) {
  return [args.organizationId, args.documentFamilyId, args.sourceGenerationId, args.schemaVersion ?? PORTFOLIO_FACT_SCHEMA_VERSION, args.algorithmVersion ?? PORTFOLIO_INTELLIGENCE_ALGORITHM_VERSION].join(":");
}

export function planPortfolioRefresh(args: { changeType: string; organizationId: string; documentFamilyId?: string | null; portfolioId?: string | null; propertyId?: string | null; sourceGenerationId?: string | null }) {
  const fullPortfolio = !args.documentFamilyId;
  return {
    scope: fullPortfolio ? "portfolio" : "document_family",
    affectedDocumentFamilyIds: args.documentFamilyId ? [args.documentFamilyId] : [],
    portfolioId: args.portfolioId ?? null,
    propertyId: args.propertyId ?? null,
    rebuildFacts: true,
    rebuildObligations: true,
    rebuildCriticalDates: true,
    refreshAnalytics: true,
    invalidatePayload: true,
    reasonCodes: [args.changeType, fullPortfolio ? "portfolio_scope_refresh" : "incremental_family_refresh"],
  };
}

export function refreshPortfolioFactInMemory(args: any) {
  const fact = buildPortfolioLeaseFact(args);
  return { idempotencyKey: portfolioRefreshIdempotencyKey({ organizationId: fact.organizationId, documentFamilyId: fact.documentFamilyId, sourceGenerationId: fact.generationId }), fact, diagnostics: { fullPortfolioRebuild: false, staleFactsSuperseded: true } };
}
