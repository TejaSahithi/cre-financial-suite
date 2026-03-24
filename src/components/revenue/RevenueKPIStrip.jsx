import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { DollarSign, TrendingUp, TrendingDown, Building2 } from "lucide-react";

function fmt(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toLocaleString()}`;
}

export default function RevenueKPIStrip({ totalRevenue, baseRent, camRecovery, otherIncome, yoyGrowth }) {
  const kpis = [
    { label: "Total Revenue", value: fmt(totalRevenue), sub: "Annual portfolio revenue", icon: DollarSign, color: "bg-slate-900 text-white" },
    { label: "Base Rent", value: fmt(baseRent), sub: `${totalRevenue > 0 ? ((baseRent / totalRevenue) * 100).toFixed(1) : 0}% of total`, icon: Building2, color: "bg-blue-50 text-blue-700" },
    { label: "CAM Recovery", value: fmt(camRecovery), sub: `${totalRevenue > 0 ? ((camRecovery / totalRevenue) * 100).toFixed(1) : 0}% of total`, icon: DollarSign, color: "bg-emerald-50 text-emerald-700" },
    { label: "Other Income", value: fmt(otherIncome), sub: `${totalRevenue > 0 ? ((otherIncome / totalRevenue) * 100).toFixed(1) : 0}% of total`, icon: DollarSign, color: "bg-purple-50 text-purple-700" },
    { label: "YoY Growth", value: `${yoyGrowth >= 0 ? '+' : ''}${yoyGrowth.toFixed(1)}%`, sub: "vs prior year", icon: yoyGrowth >= 0 ? TrendingUp : TrendingDown, color: yoyGrowth >= 0 ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {kpis.map((k, i) => (
        <Card key={i} className={i === 0 ? "bg-slate-900 border-slate-800" : ""}>
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className={`text-[10px] font-semibold uppercase tracking-wider ${i === 0 ? 'text-slate-400' : 'text-slate-500'}`}>{k.label}</p>
                <p className={`text-2xl font-bold mt-1 ${i === 0 ? 'text-white' : 'text-slate-900'}`}>{k.value}</p>
                <p className={`text-[10px] mt-0.5 ${i === 0 ? 'text-slate-500' : 'text-slate-400'}`}>{k.sub}</p>
              </div>
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${k.color}`}>
                <k.icon className="w-4 h-4" />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}