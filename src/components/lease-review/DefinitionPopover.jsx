import React from "react";
import { Badge } from "@/components/ui/badge";

export default function DefinitionPopover({ definitions = [] }) {
  if (!definitions.length) return null;
  return (
    <div className="rounded border border-slate-100 bg-slate-50 p-2.5">
      <div className="mb-2 text-xs font-semibold text-slate-800">Definition Dependencies</div>
      <div className="space-y-1.5">
        {definitions.map((item, index) => (
          <div key={`${item.term}-${index}`} className="flex flex-wrap items-center gap-2 text-[11px]">
            <Badge variant="outline" className="text-[10px]">{item.status}</Badge>
            <span className="font-semibold text-slate-700">{item.term}</span>
            {item.scope && <span className="font-mono text-slate-500">{item.scope}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}