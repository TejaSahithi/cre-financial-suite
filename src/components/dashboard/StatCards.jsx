import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Building2, BarChart3, DollarSign, Calculator } from "lucide-react";

export default function StatCards({ propertyCount = 0, leasedSF = 0, totalBudget = 0, camPool = 0 }) {
  const stats = [
    { icon: Building2, label: "Total Properties", value: propertyCount, color: "bg-slate-100 text-slate-600" },
    { icon: BarChart3, label: "Total Leased SF", value: leasedSF ? `${(leasedSF / 1000000).toFixed(1)}M` : "—", color: "bg-blue-50 text-blue-600" },
    { icon: DollarSign, label: "Total Budget", value: totalBudget ? `$${(totalBudget / 1000000).toFixed(1)}M` : "—", color: "bg-emerald-50 text-emerald-600" },
    { icon: Calculator, label: "CAM Pool", value: camPool ? `$${(camPool / 1000).toFixed(0)}K` : "—", color: "bg-violet-50 text-violet-600" },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((s, i) => (
        <Card key={i}>
          <CardContent className="p-4">
            <div className={`w-9 h-9 rounded-lg ${s.color} flex items-center justify-center mb-3`}>
              <s.icon className="w-4 h-4" />
            </div>
            <p className="text-2xl font-bold text-slate-900">{s.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{s.label}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}