import { useQuery } from "@tanstack/react-query";
import { adaptCriticalDatesResponse, adaptPortfolioPayload, adaptSearchResponse } from "../adapters/portfolioPayloadAdapter.js";
import { EMPTY_PORTFOLIO_VIEW_MODEL } from "../types.js";
import { fetchPortfolioCriticalDates, fetchPortfolioIntelligence, reconcilePortfolioRentRoll, searchPortfolioIntelligence } from "../services/portfolioIntelligenceService.js";

export function usePortfolioIntelligence(params = {}) {
  return useQuery({
    queryKey: ["portfolio-intelligence-v8", params],
    queryFn: () => fetchPortfolioIntelligence(params),
    select: adaptPortfolioPayload,
    retry: false,
    placeholderData: EMPTY_PORTFOLIO_VIEW_MODEL,
  });
}

export function usePortfolioCriticalDates(params) {
  return useQuery({ queryKey: ["portfolio-critical-dates-v8", params], queryFn: () => fetchPortfolioCriticalDates(params), select: adaptCriticalDatesResponse, enabled: Boolean(params?.dateFrom && params?.dateTo), retry: false, placeholderData: [] });
}

export function usePortfolioSearch(params) {
  return useQuery({ queryKey: ["portfolio-search-v8", params], queryFn: () => searchPortfolioIntelligence(params), select: adaptSearchResponse, enabled: Boolean(params?.query || params?.plan), retry: false, placeholderData: { plan: null, results: [], diagnostics: {} } });
}

export function usePortfolioRiskFindings(params = {}) {
  const query = usePortfolioIntelligence(params);
  return { ...query, data: query.data?.findings || [] };
}

export function useRentRollReconciliation(params) {
  return useQuery({ queryKey: ["rent-roll-reconciliation-v8", params], queryFn: () => reconcilePortfolioRentRoll(params), enabled: Boolean(params?.rentRoll || params?.portfolioId), retry: false, placeholderData: { findings: [] } });
}

export function usePortfolioExport() {
  return { status: "idle" };
}
