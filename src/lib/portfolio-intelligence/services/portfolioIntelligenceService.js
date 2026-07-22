import { invokeEdgeFunction } from "@/services/edgeFunctions";

export async function fetchPortfolioIntelligence(params = {}) {
  return invokeEdgeFunction("portfolio-intelligence-v8-summary", params);
}

export async function fetchPortfolioCriticalDates(params) {
  return invokeEdgeFunction("portfolio-intelligence-v8-critical-dates", params);
}

export async function searchPortfolioIntelligence(params) {
  return invokeEdgeFunction("portfolio-intelligence-v8-search", params);
}

export async function reconcilePortfolioRentRoll(params) {
  return invokeEdgeFunction("portfolio-intelligence-v8-rent-roll-reconciliation", params);
}

export async function exportPortfolioIntelligence(params) {
  return invokeEdgeFunction("portfolio-intelligence-v8-export", params);
}
