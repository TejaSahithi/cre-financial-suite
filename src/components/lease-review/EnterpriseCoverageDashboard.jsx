import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertTriangle, HelpCircle, Layers, FileCheck } from "lucide-react";

export function EnterpriseCoverageDashboard({ coverage, approval }) {
  if (!coverage) return null;

  const isApprovalReady = approval?.eligible;
  const approvalBlockingCount =
    typeof approval?.blockingIssueCount === "number" ? approval.blockingIssueCount : coverage.blocking;
  const isComputationReady = coverage.configured > 0 && approvalBlockingCount === 0;

  const renderMetric = (label, value, variant = "default", helpText = null) => {
    if (value === undefined || value === null) {
      return (
        <div className="flex flex-col rounded-lg border border-slate-100 bg-slate-50 p-3">
          <span className="text-xs font-medium text-slate-500">{label}</span>
          <span className="mt-1 text-sm font-semibold text-slate-400">- (Unavailable)</span>
        </div>
      );
    }

    let colorClass = "text-slate-800";
    if (variant === "success" && value > 0) colorClass = "text-emerald-600";
    if (variant === "warning" && value > 0) colorClass = "text-amber-600";
    if (variant === "danger" && value > 0) colorClass = "text-red-600";

    return (
      <div className="flex flex-col rounded-lg border border-slate-100 bg-slate-50 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-500">{label}</span>
          {helpText && <HelpCircle className="h-3.5 w-3.5 text-slate-400" title={helpText} />}
        </div>
        <span className={`mt-1 text-xl font-bold ${colorClass}`}>{value}</span>
      </div>
    );
  };

  return (
    <Card className="mb-6 border-indigo-100 bg-white shadow-sm">
      <CardHeader className="border-b border-slate-100 bg-slate-50/50 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-slate-800">
            <Layers className="h-4 w-4 text-indigo-600" />
            Enterprise Canonical Field Coverage & Ledger
          </CardTitle>

          <div className="flex items-center gap-2">
            {isApprovalReady !== undefined && (
              <Badge variant="outline" className={isApprovalReady ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
                {isApprovalReady ? <CheckCircle2 className="mr-1 h-3 w-3 text-emerald-600" /> : <AlertTriangle className="mr-1 h-3 w-3 text-amber-600" />}
                {isApprovalReady ? "Approval Eligible" : "Approval Blocked"}
              </Badge>
            )}

            <Badge variant="outline" className={isComputationReady ? "border-blue-200 bg-blue-50 text-blue-700" : "border-slate-200 bg-slate-50 text-slate-600"}>
              <FileCheck className="mr-1 h-3 w-3 text-blue-600" />
              {isComputationReady ? "Compute Engine Ready" : "Compute Incomplete"}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {renderMetric("Configured Fields", coverage.configured)}
          {renderMetric("Resolved", coverage.resolved, "success")}
          {renderMetric("Needs Review", coverage.needsReview, coverage.needsReview > 0 ? "warning" : "default")}
          {renderMetric("Conflicts", coverage.conflicts, coverage.conflicts > 0 ? "danger" : "default")}
          {renderMetric(
            "Missing / Not Found",
            coverage.missing,
            coverage.missing > 0 ? "warning" : "default",
            "Total configured canonical fields not resolved. This includes optional or non-applicable fields, not only approval-required fields.",
          )}
          {renderMetric("Missing Evidence", coverage.missingSourceEvidence, coverage.missingSourceEvidence > 0 ? "warning" : "default")}
          {renderMetric("Invalid Projections", coverage.invalid, coverage.invalid > 0 ? "danger" : "default")}
          {renderMetric("Legacy Fallbacks", coverage.legacyFallbacks, coverage.legacyFallbacks > 0 ? "warning" : "default")}
          {renderMetric(
            "Approval Blockers",
            approvalBlockingCount,
            approvalBlockingCount > 0 ? "danger" : "success",
            "Hard blockers used by the approval gate for this document/profile.",
          )}
        </div>
      </CardContent>
    </Card>
  );
}