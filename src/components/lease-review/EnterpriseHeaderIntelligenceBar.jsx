import React from "react";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertTriangle, ShieldAlert, Cpu, History } from "lucide-react";

function formatMode(mode) {
  switch (mode) {
    case "canonical_strict":
      return "Canonical Strict";
    case "canonical_hybrid":
      return "Canonical Hybrid";
    case "shadow":
      return "Shadow";
    case "legacy":
      return "Legacy Mode";
    default:
      return mode || "Standard";
  }
}

export function EnterpriseHeaderIntelligenceBar({ document }) {
  if (!document) return null;

  const isApprovalReady = Boolean(document.approval?.eligible);
  const blockingCount = document.approval?.blockingCount ?? document.coverage?.blocking ?? 0;
  const warningCount = document.approval?.warningCount ?? document.coverage?.warning ?? 0;
  const fallbackCount = document.coverage?.legacyFallbacks ?? 0;

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900 p-3 px-4 text-xs text-slate-100 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5 font-medium text-slate-200">
          <Cpu className="h-4 w-4 text-indigo-400" />
          <span>Lease Intelligence Engine</span>
          <span className="font-mono text-[11px] text-slate-400">({document.schemaVersion})</span>
        </div>

        <Badge variant="outline" className="border-slate-700 bg-slate-800/80 font-normal text-indigo-300">
          Source: {formatMode(document.mode)}
        </Badge>

        {document.diagnostics?.backendSchemaVersion && (
          <Badge variant="outline" className="border-slate-700 bg-slate-800/80 font-normal text-slate-300">
            Backend: {document.diagnostics.backendSchemaVersion}
          </Badge>
        )}

        {fallbackCount > 0 && (
          <Badge variant="outline" className="border-amber-500/30 bg-amber-500/20 font-normal text-amber-300">
            <History className="mr-1 h-3 w-3" /> {fallbackCount} Legacy Fallback{fallbackCount > 1 ? "s" : ""}
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-slate-400">Readiness:</span>
          {isApprovalReady ? (
            <Badge className="flex items-center gap-1 border-emerald-500/30 bg-emerald-500/20 font-medium text-emerald-300">
              <CheckCircle2 className="h-3 w-3" /> Approval Ready
            </Badge>
          ) : (
            <Badge className="flex items-center gap-1 border-amber-500/30 bg-amber-500/20 font-medium text-amber-300">
              <AlertTriangle className="h-3 w-3" /> Review Required
            </Badge>
          )}
        </div>

        {blockingCount > 0 && (
          <Badge className="flex items-center gap-1 border-red-500/30 bg-red-500/20 font-medium text-red-300">
            <ShieldAlert className="h-3 w-3" /> {blockingCount} Blocking Issue{blockingCount > 1 ? "s" : ""}
          </Badge>
        )}

        {warningCount > 0 && (
          <Badge className="border-amber-500/30 bg-amber-500/20 font-normal text-amber-300">
            {warningCount} Warning{warningCount > 1 ? "s" : ""}
          </Badge>
        )}
      </div>
    </div>
  );
}