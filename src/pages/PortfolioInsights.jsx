import React from "react";
import { usePortfolioCriticalDates, usePortfolioIntelligence, useRentRollReconciliation } from "@/lib/portfolio-intelligence/hooks/usePortfolioIntelligence";
import PortfolioIntelligenceDashboard from "@/components/portfolio-intelligence/PortfolioIntelligenceDashboard";
import GroundedCopilotPanel from "@/components/copilot/GroundedCopilotPanel";

function datePlus(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export default function PortfolioInsights() {
  const today = new Date().toISOString().slice(0, 10);
  const intelligence = usePortfolioIntelligence({});
  const criticalDates = usePortfolioCriticalDates({ dateFrom: today, dateTo: datePlus(180), includeEstimated: false });
  const reconciliation = useRentRollReconciliation({ rentRoll: [] });

  return (
    <div className="space-y-4">
      <GroundedCopilotPanel scope="portfolio" />
      <PortfolioIntelligenceDashboard
        viewModel={intelligence.data}
        criticalDateEvents={criticalDates.data || []}
        reconciliationFindings={reconciliation.data?.findings || []}
        isLoading={intelligence.isLoading || criticalDates.isLoading}
        error={intelligence.error || criticalDates.error}
      />
    </div>
  );
}
