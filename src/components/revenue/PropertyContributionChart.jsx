import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

const COLORS = ["#1a2744", "#2563eb", "#3b82f6", "#60a5fa", "#93c5fd", "#bfdbfe", "#dbeafe", "#eff6ff"];

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-lg p-3 text-xs">
      <p className="font-semibold text-slate-800 mb-1">{d.name}</p>
      <div className="space-y-1">
        <div className="flex justify-between gap-4"><span className="text-slate-500">Total:</span><span className="font-mono font-semibold">${d.total?.toLocaleString()}</span></div>
        <div className="flex justify-between gap-4"><span className="text-slate-500">Rent:</span><span className="font-mono">${d.rent?.toLocaleString()}</span></div>
        <div className="flex justify-between gap-4"><span className="text-slate-500">CAM:</span><span className="font-mono">${d.cam?.toLocaleString()}</span></div>
      </div>
    </div>
  );
}

export default function PropertyContributionChart({ propertyData, onSelectProperty }) {
  const data = [...propertyData]
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, 8)
    .map(p => ({ name: p.name?.length > 18 ? p.name.substring(0, 16) + '…' : p.name, total: p.totalRevenue, rent: p.baseRent, cam: p.camRevenue, id: p.id, raw: p }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Revenue by Property</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length > 0 ? (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={data} layout="vertical" margin={{ left: 10 }}>
              <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={120} />
              <Tooltip content={<CustomTooltip />} />
              <Bar
                dataKey="total"
                radius={[0, 4, 4, 0]}
                barSize={18}
                cursor="pointer"
                onClick={(d) => onSelectProperty(d.raw)}
              >
                {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-slate-400 text-center py-12">No property data</p>
        )}
      </CardContent>
    </Card>
  );
}