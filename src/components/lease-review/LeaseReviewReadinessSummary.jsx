import React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const STATUS_CLASS = {
  ready: "bg-emerald-50 text-emerald-700 border-emerald-100",
  blocked: "bg-red-50 text-red-700 border-red-100",
  needs_review: "bg-amber-50 text-amber-800 border-amber-100",
  no_rules_found: "bg-slate-100 text-slate-600 border-slate-200",
};

function labelStatus(value) {
  return String(value || "unknown").replace(/_/g, " ");
}

function SummaryPill({ label, value, status }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <p className="text-[10px] font-semibold uppercase text-slate-500">{label}</p>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-900">{value}</span>
        {status && <Badge variant="outline" className={STATUS_CLASS[status] || STATUS_CLASS.needs_review}>{labelStatus(status)}</Badge>}
      </div>
    </div>
  );
}

function getBudgetSummaryValue(summary) {
  const missingCount = summary?.budgetMissingInputsCount || 0;
  if (missingCount > 0) return `${missingCount} missing inputs`;
  if (summary?.budgetReadiness === "needs_review") return "Needs Review";
  if (summary?.budgetReadiness === "blocked") return "Needs Review";
  return "Ready";
}

export default function LeaseReviewReadinessSummary({ summary, activeTab, onSelectTab }) {
  const tabSummaries = summary?.tabSummaries || [];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Readiness Summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryPill label="Approval" value={`${summary?.missingRequiredFields?.length || 0} missing`} status={summary?.approvalReadiness} />
          <SummaryPill label="Budget" value={getBudgetSummaryValue(summary)} status={summary?.budgetReadiness} />
          <SummaryPill label="CAM" value={`${summary?.camRulesCount || 0} rule rows`} status={summary?.camReadiness} />
          <SummaryPill label="Expense Rules" value={`${summary?.expenseRulesCount || 0} rule rows`} status={summary?.expenseRulesReadiness} />
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {tabSummaries.filter((tab) => !["summary", "extraction_debug"].includes(tab.key)).map((tab) => (
            <Button
              key={tab.key}
              type="button"
              variant={activeTab === tab.key ? "default" : "outline"}
              className="h-auto min-h-[54px] justify-start px-3 py-2 text-left"
              onClick={() => onSelectTab?.(tab.key)}
            >
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold">{tab.label}</span>
                <span className="mt-0.5 block text-[11px] font-normal opacity-80">
                  {tab.complete}/{tab.totalStandard} complete
                  {tab.needsReview ? ` \u00B7 ${tab.needsReview} review` : ""}
                  {tab.missingRequired ? ` \u00B7 ${tab.missingRequired} missing` : ""}
                </span>
              </span>
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}