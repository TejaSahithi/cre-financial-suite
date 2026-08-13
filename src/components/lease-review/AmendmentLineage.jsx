import React from "react";
import { Badge } from "@/components/ui/badge";
import { GitBranch } from "lucide-react";

function formatLayer(layer) {
  return String(layer || "none").replace(/_/g, " ");
}

export default function AmendmentLineage({ lineage }) {
  if (!lineage) return null;
  const trace = lineage.amendmentPrecedence || {};
  return (
    <div className="rounded border border-slate-100 bg-slate-50 p-2.5">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-800">
        <GitBranch className="h-3.5 w-3.5 text-blue-600" /> Amendment Lineage
        <Badge variant="outline" className="text-[10px] capitalize">{formatLayer(lineage.selectedLayer)}</Badge>
      </div>
      <div className="grid gap-2 text-[11px] sm:grid-cols-3">
        <div><span className="text-slate-500">Local</span><div className="truncate font-medium text-slate-800">{lineage.documentLocalValue ?? "-"}</div></div>
        <div><span className="text-slate-500">Family effective</span><div className="truncate font-medium text-slate-800">{lineage.familyEffectiveValue ?? "-"}</div></div>
        <div><span className="text-slate-500">Reviewer</span><div className="truncate font-medium text-slate-800">{lineage.reviewerEffectiveValue ?? "-"}</div></div>
      </div>
      {trace.reasonCodes?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {trace.reasonCodes.map((code) => <span key={code} className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500">{code}</span>)}
        </div>
      )}
    </div>
  );
}