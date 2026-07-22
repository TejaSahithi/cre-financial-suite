import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCoverageRate } from "@/lib/portfolio-intelligence/statusPresentation";

export default function PortfolioCoveragePanel({ coverage }) {
  const rows = [
    ["Canonical", coverage.canonicalReady, coverage.totalLeaseFamilies],
    ["Semantic", coverage.semanticReady, coverage.totalLeaseFamilies],
    ["Incomplete", coverage.incomplete, coverage.totalLeaseFamilies],
    ["Blocked", coverage.blocked, coverage.totalLeaseFamilies],
  ];
  return (
    <Card className="border-slate-200 shadow-sm rounded-lg">
      <CardHeader className="px-4 py-3"><CardTitle className="text-sm">Coverage</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {rows.map(([label, value, total]) => (
          <div key={label} className="flex items-center gap-3">
            <div className="w-24 text-xs text-slate-600">{label}</div>
            <div className="h-2 flex-1 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-slate-800" style={{ width: `${total ? Math.min(100, (value / total) * 100) : 0}%` }} /></div>
            <div className="w-12 text-right text-xs font-semibold text-slate-700">{value}</div>
          </div>
        ))}
        <div className="grid grid-cols-2 gap-2 pt-2 text-xs">
          <div className="rounded-md border border-slate-200 p-2"><div className="text-slate-500">Financial coverage</div><div className="font-semibold">{formatCoverageRate(coverage.financialCoverageRate)}</div></div>
          <div className="rounded-md border border-slate-200 p-2"><div className="text-slate-500">Evidence coverage</div><div className="font-semibold">{formatCoverageRate(coverage.evidenceCoverageRate)}</div></div>
        </div>
      </CardContent>
    </Card>
  );
}
