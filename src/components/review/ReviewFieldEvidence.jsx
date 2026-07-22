import React from "react";
import { FileText } from "lucide-react";

export default function ReviewFieldEvidence({ evidence = [] }) {
  if (!evidence.length) return <p className="text-xs text-slate-500">No source evidence attached.</p>;
  return (
    <div className="space-y-2">
      {evidence.map((item) => (
        <div key={item.id} className="rounded border border-slate-100 bg-slate-50 p-2 text-xs text-slate-600">
          <div className="mb-1 flex items-center gap-2 font-medium text-slate-700">
            <FileText className="h-3.5 w-3.5" />
            <span>{item.pageNumber != null ? `Page ${item.pageNumber}` : "Page unavailable"}</span>
            {item.polygonAvailable && <span className="text-emerald-700">Geometry</span>}
          </div>
          {item.text && <p className="line-clamp-2 italic">{item.text}</p>}
        </div>
      ))}
    </div>
  );
}
