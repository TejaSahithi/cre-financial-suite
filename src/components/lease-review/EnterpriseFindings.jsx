import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShieldAlert, AlertTriangle, Info, CheckCircle2, ArrowRight, Ban } from "lucide-react";
import { LEASE_REVIEW_FIELDS } from "@/lib/leaseReviewSchema";

export function EnterpriseFindings({ findings = [], onNavigateToField }) {
  const fieldToTabMap = React.useMemo(() => {
    const map = {};
    for (const field of LEASE_REVIEW_FIELDS) {
      if (field.key && field.tab) map[field.key] = { tab: field.tab, label: field.label || field.key };
    }
    return map;
  }, []);

  if (!findings || findings.length === 0) return null;

  const getSeverityBadge = (severity, isBlocking) => {
    const normalized = isBlocking ? "blocking" : severity;
    switch (normalized) {
      case "blocking":
        return <Badge className="flex items-center gap-1 bg-red-600 text-white"><ShieldAlert className="h-3 w-3" /> Blocking</Badge>;
      case "material":
      case "critical":
        return <Badge className="flex items-center gap-1 bg-red-500 text-white"><AlertTriangle className="h-3 w-3" /> Critical</Badge>;
      case "warning":
        return <Badge className="flex items-center gap-1 bg-amber-500 text-white"><AlertTriangle className="h-3 w-3" /> Warning</Badge>;
      case "informational":
        return <Badge className="flex items-center gap-1 bg-blue-500 text-white"><Info className="h-3 w-3" /> Info</Badge>;
      default:
        return <Badge variant="outline" className="text-slate-600">{normalized || "Info"}</Badge>;
    }
  };

  return (
    <Card className="mb-6 border-slate-200 bg-white shadow-sm">
      <CardHeader className="border-b border-slate-100 bg-slate-50/50 pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-slate-800">
            <ShieldAlert className="h-4 w-4 text-amber-600" />
            Enterprise Pipeline Findings ({findings.length})
          </CardTitle>
          <span className="text-xs text-slate-500">Validation & Reconciliation Audit</span>
        </div>
      </CardHeader>

      <CardContent className="divide-y divide-slate-100 pt-4">
        {findings.map((finding) => {
          const fieldKey = finding.fieldKey || null;
          const mappedField = fieldKey ? fieldToTabMap[fieldKey] : null;
          const canNavigate = Boolean(mappedField && onNavigateToField);

          return (
            <div key={finding.id || finding.title} className="flex flex-col justify-between gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
              <div className="max-w-3xl space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  {getSeverityBadge(finding.severity, finding.reviewerActionRequired)}

                  <span className="text-sm font-semibold text-slate-900">{finding.title}</span>

                  {fieldKey && (
                    <span className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
                      {fieldKey}
                    </span>
                  )}

                  {finding.resolutionStatus === "resolved" && (
                    <Badge variant="outline" className="flex items-center gap-1 border-emerald-200 bg-emerald-50 text-[11px] text-emerald-700">
                      <CheckCircle2 className="h-3 w-3" /> Resolved
                    </Badge>
                  )}
                </div>

                {finding.summary && <p className="text-xs leading-relaxed text-slate-600">{finding.summary}</p>}

                {finding.reasonCodes?.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 pt-0.5">
                    <span className="text-[11px] font-medium text-slate-400">Reasons:</span>
                    {finding.reasonCodes.map((code) => (
                      <span key={code} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                        {code}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {canNavigate ? (
                  <Button size="sm" variant="outline" className="h-8 border-indigo-200 text-xs font-medium text-indigo-600 hover:bg-indigo-50 hover:text-indigo-700" onClick={() => onNavigateToField(mappedField.tab, fieldKey)}>
                    View Field <ArrowRight className="ml-1 h-3 w-3" />
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" disabled className="h-8 cursor-not-allowed text-xs text-slate-400" title={fieldKey ? "Field not in standard table view" : "Unmapped finding"}>
                    <Ban className="mr-1 h-3 w-3" /> No Direct Field
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}