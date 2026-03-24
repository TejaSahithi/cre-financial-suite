import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { Building2, ChevronRight } from "lucide-react";

const COLORS = ["#3b82f6", "#e2e8f0"];

export default function OccupancyChart({ properties = [] }) {
  const totalSF = properties.reduce((s, p) => s + (p.total_sf || 0), 0);
  const leasedSF = properties.reduce((s, p) => s + (p.leased_sf || 0), 0);
  const vacantSF = totalSF - leasedSF;
  const occupancyPct = totalSF > 0 ? (leasedSF / totalSF * 100) : 0;
  const vacantRevLoss = vacantSF * 20; // Estimated annual revenue loss at $20/SF

  const data = [
    { name: "Leased", value: leasedSF },
    { name: "Vacant", value: vacantSF },
  ].filter(d => d.value > 0);

  const propertyData = properties.map(p => ({
    id: p.id,
    name: p.name,
    occ: p.total_sf > 0 ? (p.leased_sf || 0) / p.total_sf * 100 : 0,
    vacant: (p.total_sf || 0) - (p.leased_sf || 0),
    sf: p.total_sf || 0,
  })).sort((a, b) => a.occ - b.occ); // Worst first

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-1 pt-3 px-4 flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-sm font-bold text-slate-900">Occupancy</CardTitle>
          <p className="text-[10px] text-slate-500">
            {totalSF > 0 ? <>{(leasedSF / 1000).toFixed(0)}K of {(totalSF / 1000).toFixed(0)}K SF leased · Est. vacancy loss: ${(vacantRevLoss / 1000).toFixed(0)}K/yr</> : 'No data'}
          </p>
        </div>
        <Link to={createPageUrl("Properties")} className="text-[10px] text-blue-600 font-semibold flex items-center gap-0.5 hover:underline">
          Properties <ChevronRight className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-1">
        {totalSF > 0 ? (
          <div className="flex gap-4 items-start">
            <div className="relative w-28 h-28 flex-shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data} cx="50%" cy="50%" innerRadius={34} outerRadius={50} dataKey="value" startAngle={90} endAngle={-270} stroke="none">
                    {data.map((_, i) => <Cell key={i} fill={COLORS[i]} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-lg font-extrabold text-slate-900">{occupancyPct.toFixed(0)}%</span>
                <span className="text-[8px] text-slate-400">Occupied</span>
              </div>
            </div>
            <div className="flex-1 space-y-1.5 min-w-0">
              {propertyData.slice(0, 6).map((p, i) => (
                <Link key={i} to={`${createPageUrl("PropertyDetail")}?id=${p.id}`} className="flex items-center gap-2 group">
                  <span className="text-[10px] text-slate-600 w-24 truncate group-hover:text-blue-600">{p.name}</span>
                  <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${p.occ >= 90 ? 'bg-emerald-500' : p.occ >= 70 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${Math.min(p.occ, 100)}%` }} />
                  </div>
                  <span className="text-[10px] font-bold text-slate-700 w-8 text-right tabular-nums">{p.occ.toFixed(0)}%</span>
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-[120px]">
            <Building2 className="w-6 h-6 text-slate-200 mr-2" />
            <p className="text-xs text-slate-400">No property data</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}