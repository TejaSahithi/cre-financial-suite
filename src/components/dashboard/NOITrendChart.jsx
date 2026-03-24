import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { TrendingUp, ChevronRight } from "lucide-react";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-900 rounded-lg px-3.5 py-2.5 shadow-xl border border-slate-700 text-xs">
      <p className="font-semibold text-slate-300 mb-1.5">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex justify-between gap-4">
          <span className="text-slate-400">{p.name}</span>
          <span className="text-white font-bold tabular-nums">${p.value?.toLocaleString()}</span>
        </div>
      ))}
      {payload.length >= 3 && (() => {
        const margin = payload[0]?.value > 0 ? (payload[2]?.value / payload[0]?.value * 100) : 0;
        return <div className="border-t border-slate-700 pt-1 mt-1 text-[10px] text-slate-400">NOI Margin: <span className="text-emerald-400 font-bold">{margin.toFixed(1)}%</span></div>;
      })()}
    </div>
  );
};

export default function NOITrendChart({ leases = [], expenses = [] }) {
  const monthlyRent = leases.filter(l => l.status !== 'expired').reduce((s, l) => s + (l.base_rent || 0), 0);
  const expByMonth = {};
  expenses.forEach(e => {
    const m = e.month || (e.date ? new Date(e.date).getMonth() + 1 : null);
    if (m) expByMonth[m] = (expByMonth[m] || 0) + (e.amount || 0);
  });
  const avgMonthlyExp = expenses.length > 0 ? Object.values(expByMonth).reduce((s, v) => s + v, 0) / Math.max(Object.keys(expByMonth).length, 1) : 0;

  const chartData = MONTHS.map((month, i) => {
    const rev = monthlyRent;
    const exp = expByMonth[i + 1] || avgMonthlyExp;
    return { month, Revenue: Math.round(rev), Expenses: Math.round(exp), NOI: Math.round(rev - exp) };
  });

  const annualNOI = chartData.reduce((s, d) => s + d.NOI, 0);
  const annualRev = chartData.reduce((s, d) => s + d.Revenue, 0);
  const noiMargin = annualRev > 0 ? (annualNOI / annualRev * 100) : 0;
  const hasData = leases.length > 0 || expenses.length > 0;

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-1 pt-3 px-4 flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-sm font-bold text-slate-900">NOI Trend</CardTitle>
          <p className="text-[10px] text-slate-500">
            {hasData ? <>Annual NOI: ${(annualNOI / 1000).toFixed(0)}K · Margin: {noiMargin.toFixed(1)}% · Revenue − OpEx</> : 'No data'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {noiMargin > 0 && <Badge className="bg-emerald-100 text-emerald-700 text-[10px] font-bold">{noiMargin.toFixed(0)}% margin</Badge>}
          <Link to={createPageUrl("Revenue")} className="text-[10px] text-blue-600 font-semibold flex items-center gap-0.5 hover:underline">
            Revenue <ChevronRight className="w-3 h-3" />
          </Link>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-1">
        {hasData ? (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="gNOI" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#10b981" stopOpacity={0.2} /><stop offset="100%" stopColor="#10b981" stopOpacity={0} /></linearGradient>
                <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3b82f6" stopOpacity={0.1} /><stop offset="100%" stopColor="#3b82f6" stopOpacity={0} /></linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} axisLine={false} tickLine={false} width={45} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="Revenue" stroke="#3b82f6" fill="url(#gRev)" strokeWidth={1.5} />
              <Area type="monotone" dataKey="Expenses" stroke="#f59e0b" fill="none" strokeWidth={1.5} strokeDasharray="4 4" />
              <Area type="monotone" dataKey="NOI" stroke="#10b981" fill="url(#gNOI)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex flex-col items-center justify-center h-[220px]">
            <TrendingUp className="w-8 h-8 text-slate-200 mb-2" />
            <p className="text-xs text-slate-400">Add leases and expenses to track NOI</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}