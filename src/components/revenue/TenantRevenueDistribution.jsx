import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import RevenueSourcePopover from "./RevenueSourcePopover";

const COLORS = ["#1a2744", "#2563eb", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#06b6d4", "#ec4899"];

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-lg p-3 text-xs">
      <p className="font-semibold text-slate-800">{d.name}</p>
      <p className="font-mono mt-1">${d.value?.toLocaleString()} <span className="text-slate-400">({d.pct?.toFixed(1)}%)</span></p>
    </div>
  );
}

export default function TenantRevenueDistribution({ tenantData, onSelectTenant }) {
  const total = tenantData.reduce((s, t) => s + t.totalRevenue, 0);
  const pieData = tenantData
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, 8)
    .map(t => ({ name: t.name, value: t.totalRevenue, pct: total > 0 ? (t.totalRevenue / total) * 100 : 0, raw: t }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Revenue by Tenant</CardTitle>
      </CardHeader>
      <CardContent>
        {pieData.length > 0 ? (
          <div className="flex flex-col items-center">
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} dataKey="value" onClick={(_, i) => onSelectTenant(pieData[i]?.raw)}>
                  {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} cursor="pointer" />)}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="w-full space-y-1.5 mt-2">
              {pieData.map((d, i) => (
                <div key={d.name} className="flex items-center justify-between text-xs group cursor-pointer hover:bg-slate-50 rounded px-1 py-0.5" onClick={() => onSelectTenant(d.raw)}>
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                    <span className="text-slate-600 truncate max-w-[140px] group-hover:text-blue-700">{d.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <RevenueSourcePopover sourceType="lease" sourceName={d.name} amount={d.value}>
                      <span className="font-mono text-slate-700">${(d.value / 1000).toFixed(1)}K</span>
                    </RevenueSourcePopover>
                    <span className="text-slate-400 w-10 text-right">{d.pct.toFixed(1)}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-400 text-center py-12">No tenant data</p>
        )}
      </CardContent>
    </Card>
  );
}