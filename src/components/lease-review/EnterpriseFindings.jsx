import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShieldAlert, AlertTriangle, Info, CheckCircle2, ArrowRight, Ban } from "lucide-react";
import { LEASE_REVIEW_FIELDS } from "@/lib/leaseReviewSchema";

export function EnterpriseFindings({ findings = [], onNavigateToField }) {
  // Build key to tab lookup
  const fieldToTabMap = React.useMemo(() => {
    const map = {};
    for (const f of LEASE_REVIEW_FIELDS) {
      if (f.key && f.tab) {
        map[f.key] = { tab: f.tab, label: f.label || f.key };
      }
    }
    return map;
  }, []);

  if (!findings || findings.length === 0) return null;

  const getSeverityBadge = (severity, isBlocking) => {
    switch (severity) {
      case "blocking":
        return (
          <Badge className="bg-red-600 text-white flex items-center gap-1">
            <ShieldAlert className="w-3 h-3" /> Blocking
          </Badge>
        );
      case "material":
      case "critical":
        return (
          <Badge className="bg-red-500 text-white flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> Critical
          </Badge>
        );
      case "warning":
        return (
          <Badge className="bg-amber-500 text-white flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> Warning
          </Badge>
        );
      case "informational":
        return (
          <Badge className="bg-blue-500 text-white flex items-center gap-1">
            <Info className="w-3 h-3" /> Info
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="text-slate-600">
            {severity}
          </Badge>
        );
    }
  };

  return (
    <Card className="mb-6 border-slate-200 shadow-sm bg-white">
      <CardHeader className="pb-3 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2 text-slate-800">
            <ShieldAlert className="w-4 h-4 text-amber-600" />
            Enterprise Pipeline Findings ({findings.length})
          </CardTitle>
          <span className="text-xs text-slate-500">Validation & Reconciliation Audit</span>
        </div>
      </CardHeader>

      <CardContent className="pt-4 divide-y divide-slate-100">
        {findings.map((finding) => {
          const mappedField = finding.canonicalFieldKey ? fieldToTabMap[finding.canonicalFieldKey] : null;
          const canNavigate = Boolean(mappedField && onNavigateToField);

          return (
            <div key={finding.findingId || finding.title} className="py-3 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-1 max-w-3xl">
                <div className="flex items-center gap-2 flex-wrap">
                  {getSeverityBadge(finding.severity, finding.reviewerActionRequired)}
                  
                  <span className="font-semibold text-sm text-slate-900">{finding.title}</span>
                  
                  {finding.canonicalFieldKey && (
                    <span className="font-mono text-xs bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded border border-slate-200">
                      {finding.canonicalFieldKey}
                    </span>
                  )}

                  {finding.resolutionStatus === "resolved" && (
                    <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 flex items-center gap-1 text-[11px]">
                      <CheckCircle2 className="w-3 h-3" /> Resolved
                    </Badge>
                  )}
                </div>

                <p className="text-xs text-slate-600 leading-relaxed">{finding.summary}</p>

                {finding.reasonCodes && finding.reasonCodes.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap pt-0.5">
                    <span className="text-[11px] text-slate-400 font-medium">Reasons:</span>
                    {finding.reasonCodes.map((code) => (
                      <span key={code} className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.2 rounded font-mono">
                        {code}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="shrink-0 flex items-center gap-2">
                {canNavigate ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs font-medium text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 border-indigo-200"
                    onClick={() => onNavigateToField(mappedField.tab, finding.canonicalFieldKey)}
                  >
                    View Field <ArrowRight className="w-3 h-3 ml-1" />
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled
                    className="h-8 text-xs text-slate-400 cursor-not-allowed"
                    title={finding.canonicalFieldKey ? "Field not in standard table view" : "Unmapped finding"}
                  >
                    <Ban className="w-3 h-3 mr-1" /> No Direct Field
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

