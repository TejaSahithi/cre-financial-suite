export const PORTFOLIO_PAYLOAD_SCHEMA_VERSION = "portfolio-intelligence-payload-v1";

export const EMPTY_PORTFOLIO_VIEW_MODEL = {
  summary: { leaseCount: 0, activeLeaseCount: 0, totalLeasedArea: null, annualizedBaseRent: null, expirationsByYear: {}, exclusionsDisclosed: true },
  coverage: { totalLeaseFamilies: 0, canonicalReady: 0, semanticReady: 0, incomplete: 0, blocked: 0, financialCoverageRate: 0, evidenceCoverageRate: 0 },
  risks: { totalScore: 0, bySeverity: { low: 0, medium: 0, high: 0, critical: 0 }, byDomain: {}, findingCount: 0 },
  criticalDates: { total: 0, blocking: 0, unresolved: 0 },
  obligations: { total: 0, unresolved: 0 },
  financials: { termCount: 0, currencies: [], annualizedBaseRent: null },
  findings: [],
  diagnostics: {},
};
