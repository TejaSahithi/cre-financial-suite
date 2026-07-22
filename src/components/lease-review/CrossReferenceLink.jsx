import React from "react";
import { Badge } from "@/components/ui/badge";

export default function CrossReferenceLink({ references = [] }) {
  if (!references.length) return null;
  return (
    <div className="rounded border border-slate-100 bg-slate-50 p-2.5">
      <div className="mb-2 text-xs font-semibold text-slate-800">Cross References</div>
      <div className="space-y-1.5">
        {references.map((ref, index) => (
          <div key={`${ref.id || ref.sourceText}-${index}`} className="flex flex-wrap items-center gap-2 text-[11px]">
            <Badge variant="outline" className="text-[10px] capitalize">{String(ref.resolutionStatus || "unresolved").replace(/_/g, " ")}</Badge>
            <span className="text-slate-700">{ref.sourceText || ref.targetLabel}</span>
            {ref.targetSectionKey && <span className="font-mono text-slate-500">{ref.targetSectionKey}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}