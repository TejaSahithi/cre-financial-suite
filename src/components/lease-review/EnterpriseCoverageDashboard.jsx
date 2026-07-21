import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertTriangle, HelpCircle, Layers, FileCheck } from "lucide-react";

export function EnterpriseCoverageDashboard({ enterprisePayload }) {
  if (!enterprisePayload || !enterprisePayload.coverage) return null;

  const { coverage, validationSummary } = enterprisePayload;
  const totals = coverage.totals;

  if (!totals) return null;

  const isApprovalReady = validationSummary?.approvalEligible ?? coverage?.approvalReady;
  const isComputationReady = coverage?.computationReady;

  const renderMetric = (label, value, variant = "default", helpText = null) => {
    if (value === undefined || value === null) {
      return (
        <div className="flex flex-col p-3 rounded-lg bg-slate-50 border border-slate-100">
          <span className="text-xs text-slate-500 font-medium">{label}</span>
          <span className="text-sm font-semibold text-slate-400 mt-1">â€” (Unavailable)</span>
        </div>
      );
    }

    let colorClass = "text-slate-800";
    if (variant === "success" && value > 0) colorClass = "text-emerald-600";
    if (variant === "warning" && value > 0) colorClass = "text-amber-600";
    if (variant === "danger" && value > 0) colorClass = "text-red-600";

    return (
      <div className="flex flex-col p-3 rounded-lg bg-slate-50 border border-slate-100">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500 font-medium">{label}</span>
          {helpText && <HelpCircle className="w-3.5 h-3.5 text-slate-400" title={helpText} />}
        </div>
        <span className={`text-xl font-bold mt-1 ${colorClass}`}>{value}</span>
      </div>
    );
  };

  return (
    <Card className="mb-6 border-indigo-100 shadow-sm bg-white">
      <CardHeader className="pb-3 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2 text-slate-800">
            <Layers className="w-4 h-4 text-indigo-600" />
            Enterprise Canonical Field Coverage & Ledger
          </CardTitle>

          <div className="flex items-center gap-2">
            {isApprovalReady !== undefined && (
              <Badge variant="outline" className={isApprovalReady ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-amber-50 text-amber-700 border-amber-200"}>
                {isApprovalReady ? <CheckCircle2 className="w-3 h-3 mr-1 text-emerald-600" /> : <AlertTriangle className="w-3 h-3 mr-1 text-amber-600" />}
                {isApprovalReady ? "Approval Eligible" : "Approval Blocked"}
              </Badge>
            )}

            {isComputationReady !== undefined && (
              <Badge variant="outline" className={isComputationReady ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-slate-50 text-slate-600 border-slate-200"}>
                <FileCheck className="w-3 h-3 mr-1 text-blue-600" />
                {isComputationReady ? "Compute Engine Ready" : "Compute Incomplete"}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {renderMetric("Configured Fields", totals.configured)}
          {renderMetric("Resolved", totals.resolved, "success")}
          {renderMetric("Needs Review", totals.needsReview, totals.needsReview > 0 ? "warning" : "default")}
          {renderMetric("Conflicts", totals.conflicts, totals.conflicts > 0 ? "danger" : "default")}
          {renderMetric("Missing Required", totals.missing, totals.missing > 0 ? "danger" : "default")}
          {renderMetric("Missing Evidence", totals.missingSourceEvidence, totals.missingSourceEvidence > 0 ? "warning" : "default")}
          {renderMetric("Invalid Projections", totals.invalid, totals.invalid > 0 ? "danger" : "default")}
          {renderMetric("Legacy Fallbacks", totals.legacyFallbacks, totals.legacyFallbacks > 0 ? "warning" : "default")}
          {renderMetric("Blocking Total", totals.blocking, totals.blocking > 0 ? "danger" : "success")}
        </div>
      </CardContent>
    </Card>
  );
}

