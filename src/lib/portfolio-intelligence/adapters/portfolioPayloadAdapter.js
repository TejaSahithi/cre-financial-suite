import { EMPTY_PORTFOLIO_VIEW_MODEL } from "../types.js";

export function adaptPortfolioPayload(payload) {
  if (!payload || payload.schemaVersion !== "portfolio-intelligence-payload-v1") return EMPTY_PORTFOLIO_VIEW_MODEL;
  return {
    summary: { ...EMPTY_PORTFOLIO_VIEW_MODEL.summary, ...(payload.summary || {}) },
    coverage: { ...EMPTY_PORTFOLIO_VIEW_MODEL.coverage, ...(payload.coverage || {}) },
    risks: { ...EMPTY_PORTFOLIO_VIEW_MODEL.risks, ...(payload.risks || {}) },
    criticalDates: { ...EMPTY_PORTFOLIO_VIEW_MODEL.criticalDates, ...(payload.criticalDates || {}) },
    obligations: { ...EMPTY_PORTFOLIO_VIEW_MODEL.obligations, ...(payload.obligations || {}) },
    financials: { ...EMPTY_PORTFOLIO_VIEW_MODEL.financials, ...(payload.financials || {}) },
    findings: Array.isArray(payload.findings) ? payload.findings : [],
    diagnostics: payload.diagnostics || {},
    sourceGenerationDigest: payload.sourceGenerationDigest || null,
  };
}

export function adaptCriticalDatesResponse(payload) {
  return Array.isArray(payload?.events) ? payload.events : [];
}

export function adaptSearchResponse(payload) {
  return { plan: payload?.plan || null, results: Array.isArray(payload?.results) ? payload.results : [], diagnostics: payload?.diagnostics || {} };
}
