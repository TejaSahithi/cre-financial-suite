import React from "react";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertTriangle, ShieldAlert, Cpu } from "lucide-react";

export function EnterpriseHeaderIntelligenceBar({ enterprisePayload }) {
  if (!enterprisePayload || !enterprisePayload.schemaVersion) return null;

  const { sourceMode, schemaVersion, coverage, validationSummary, canonicalDocument } = enterprisePayload;

  const isApprovalReady = validationSummary?.approvalEligible ?? coverage?.approvalReady ?? false;
  const blockingCount = validationSummary?.blockingIssueCount ?? coverage?.totals?.blocking ?? 0;
  const warningCount = validationSummary?.warningCount ?? 0;

  const modeLabel = sourceMode === "canonical_strict" 
    ? "Canonical Strict" 
    : sourceMode === "canonical_hybrid" 
    ? "Canonical Hybrid" 
    : sourceMode === "legacy" 
    ? "Legacy Mode" 
    : sourceMode || "Standard";

  return (
    <div className="bg-slate-900 text-slate-100 rounded-lg p-3 px-4 shadow-sm mb-4 border border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 font-medium text-slate-200">
          <Cpu className="w-4 h-4 text-indigo-400" />
          <span>Lease Intelligence Engine</span>
          <span className="text-slate-400 font-mono text-[11px]">({schemaVersion})</span>
        </div>

        <Badge variant="outline" className="bg-slate-800/80 text-indigo-300 border-slate-700 font-normal">
          Source: {modeLabel}
        </Badge>

        {canonicalDocument?.geometryAvailable && (
          <Badge variant="outline" className="bg-slate-800/80 text-emerald-300 border-slate-700 font-normal">
            Geometry Indexed
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-slate-400">Readiness:</span>
          {isApprovalReady ? (
            <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30 flex items-center gap-1 font-medium">
              <CheckCircle2 className="w-3 h-3" /> Approval Ready
            </Badge>
          ) : (
            <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30 flex items-center gap-1 font-medium">
              <AlertTriangle className="w-3 h-3" /> Review Required
            </Badge>
          )}
        </div>

        {blockingCount > 0 && (
          <Badge className="bg-red-500/20 text-red-300 border-red-500/30 flex items-center gap-1 font-medium">
            <ShieldAlert className="w-3 h-3" /> {blockingCount} Blocking Issue{blockingCount > 1 ? "s" : ""}
          </Badge>
        )}

        {warningCount > 0 && (
          <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30 font-normal">
            {warningCount} Warning{warningCount > 1 ? "s" : ""}
          </Badge>
        )}
      </div>
    </div>
  );
}
