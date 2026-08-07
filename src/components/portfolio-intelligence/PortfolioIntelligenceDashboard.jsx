import React from "react";
import { Activity, Building2, DollarSign, FileCheck2 } from "lucide-react";
import PortfolioCoveragePanel from "./PortfolioCoveragePanel";
import PortfolioCriticalDatesPanel from "./PortfolioCriticalDatesPanel";
import PortfolioRiskDashboard from "./PortfolioRiskDashboard";
import PortfolioSearchCommand from "./PortfolioSearchCommand";
import RentRollReconciliationPanel from "./RentRollReconciliationPanel";
import { Card, CardContent } from "@/components/ui/card";
import { formatPortfolioMoney } from "@/lib/portfolio-intelligence/statusPresentation";

function Metric({ icon: Icon, label, value, subtext }) {
  return <Card className="border-slate-200 shadow-sm rounded-lg"><CardContent className="p-4"><div className="flex items-start justify-between"><div><div className="text-xs text-slate-500">{label}</div><div className="text-2xl font-semibold text-slate-900 tabular-nums">{value}</div><div className="text-[11px] text-slate-400">{subtext}</div></div><Icon className="w-4 h-4 text-slate-500" /></div></CardContent></Card>;
}

export default function PortfolioIntelligenceDashboard({ viewModel, criticalDateEvents = [], reconciliationFindings = [], isLoading = false, error = null }) {
  const summary = viewModel.summary;
  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[28px] font-bold text-slate-900">Portfolio Intelligence</h1>
          <p className="text-xs text-slate-500">Canonical facts, operational dates, risk, reconciliation, and metric lineage.</p>
        </div>
        <div className="text-xs text-slate-500">{isLoading ? "Refreshing" : error ? "Using last available view" : "Ready"}</div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <Metric icon={FileCheck2} label="Active leases" value={summary.activeLeaseCount || 0} subtext={`${summary.leaseCount || 0} total facts`} />
        <Metric icon={Building2} label="Leased area" value={summary.totalLeasedArea ? summary.totalLeasedArea.toLocaleString() : "Excluded"} subtext="Coverage-aware total" />
        <Metric icon={DollarSign} label="Annualized base rent" value={formatPortfolioMoney(summary.annualizedBaseRent)} subtext="No silent currency mixing" />
        <Metric icon={Activity} label="Lineage" value={summary.exclusionsDisclosed ? "On" : "Missing"} subtext="Metrics disclose exclusions" />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <PortfolioCoveragePanel coverage={viewModel.coverage} />
        <PortfolioRiskDashboard risks={viewModel.risks} findings={viewModel.findings} />
        <PortfolioCriticalDatesPanel summary={viewModel.criticalDates} events={criticalDateEvents} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <PortfolioSearchCommand />
        <RentRollReconciliationPanel findings={reconciliationFindings} />
      </div>
    </div>
  );
}
