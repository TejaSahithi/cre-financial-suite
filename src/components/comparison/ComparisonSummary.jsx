import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowUp, ArrowDown, Minus } from "lucide-react";

function ChangeIndicator({ yearA, yearB }) {
  if (!yearA && !yearB) return <Minus className="w-3.5 h-3.5 text-slate-300" />;
  const change = yearA ? ((yearB - yearA) / Math.abs(yearA)) * 100 : 100;
  if (Math.abs(change) < 0.5) return <span className="text-xs text-slate-400">0%</span>;
  const isUp = change > 0;
  return (
    <span className={`flex items-center gap-0.5 text-xs font-semibold ${isUp ? 'text-emerald-600' : 'text-red-600'}`}>
      {isUp ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
      {Math.abs(change).toFixed(1)}%
    </span>
  );
}

export default function ComparisonSummary({ rows, yearA, yearB }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      {rows.map((r, i) => {
        const change = r.yearA ? ((r.yearB - r.yearA) / Math.abs(r.yearA)) * 100 : 0;
        const isPositive = r.label === 'Total Expenses' ? change < 0 : change > 0;
        return (
          <Card key={i} className={`border-l-4 ${isPositive ? 'border-l-emerald-500' : change === 0 ? 'border-l-slate-300' : 'border-l-red-500'}`}>
            <CardContent className="p-4">
              <p className="text-[10px] font-semibold text-slate-500 uppercase mb-1">{r.label}</p>
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-lg font-bold text-slate-900">${(r.yearB / 1000).toFixed(0)}K</p>
                  <p className="text-[10px] text-slate-400">vs ${(r.yearA / 1000).toFixed(0)}K ({yearA})</p>
                </div>
                <ChangeIndicator yearA={r.yearA} yearB={r.yearB} />
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}