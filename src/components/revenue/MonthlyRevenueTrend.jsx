import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (p.value || 0), 0);
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-lg p-3 text-xs">
      <p className="font-semibold text-slate-700 mb-1.5">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-6">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
            <span className="text-slate-600">{p.name}</span>
          </div>
          <span className="font-mono font-medium">${p.value?.toLocaleString()}</span>
        </div>
      ))}
      <div className="border-t mt-1.5 pt-1.5 flex justify-between font-semibold">
        <span>Total</span>
        <span className="font-mono">${total.toLocaleString()}</span>
      </div>
    </div>
  );
}

export default function MonthlyRevenueTrend({ leases, camCalcs, title }) {
  const totalMonthlyRent = leases.reduce((s, l) => s + (l.base_rent || 0), 0);
  const totalMonthlyCam = camCalcs.reduce((s, c) => s + (c.monthly_cam || 0), 0);

  const data = MONTHS.map((m) => ({
    month: m,
    "Base Rent": totalMonthlyRent,
    "CAM Recovery": totalMonthlyCam,
    "Other Income": 0,
  }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{title || "Monthly Revenue Trend"}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={data}>
            <defs>
              <linearGradient id="rentGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1a2744" stopOpacity={0.15} />
                <stop offset="100%" stopColor="#1a2744" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="camGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.15} />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="otherGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.15} />
                <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="month" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Area type="monotone" dataKey="Base Rent" stackId="1" stroke="#1a2744" fill="url(#rentGrad)" strokeWidth={2} />
            <Area type="monotone" dataKey="CAM Recovery" stackId="1" stroke="#3b82f6" fill="url(#camGrad)" strokeWidth={2} />
            <Area type="monotone" dataKey="Other Income" stackId="1" stroke="#8b5cf6" fill="url(#otherGrad)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}