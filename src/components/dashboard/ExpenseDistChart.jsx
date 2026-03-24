import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Receipt, ChevronRight } from "lucide-react";

const COLORS = ["#1e293b", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#06b6d4", "#ec4899"];

export default function ExpenseDistChart({ expenses = [] }) {
  const total = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const recoverable = expenses.filter(e => e.classification === 'recoverable').reduce((s, e) => s + (e.amount || 0), 0);
  const recPct = total > 0 ? (recoverable / total * 100) : 0;

  const catTotals = {};
  expenses.forEach(e => { catTotals[e.category || "other"] = (catTotals[e.category || "other"] || 0) + (e.amount || 0); });
  const chartData = Object.entries(catTotals).sort(([, a], [, b]) => b - a).slice(0, 7).map(([cat, amt]) => ({
    name: cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).substring(0, 14),
    fullName: cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    value: amt,
    pct: total > 0 ? (amt / total * 100).toFixed(1) : 0,
  }));

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="bg-slate-900 rounded-lg px-3 py-2 shadow-xl border border-slate-700 text-xs">
        <p className="text-slate-300 font-semibold">{payload[0]?.payload?.fullName}</p>
        <p className="text-white font-bold">${payload[0]?.value?.toLocaleString()} <span className="text-slate-400">({payload[0]?.payload?.pct}%)</span></p>
      </div>
    );
  };

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-1 pt-3 px-4 flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-sm font-bold text-slate-900">Expense Distribution</CardTitle>
          <p className="text-[10px] text-slate-500">
            {total > 0 ? <>{chartData.length} categories · {recPct.toFixed(0)}% recoverable from tenants</> : 'No data'}
          </p>
        </div>
        <Link to={createPageUrl("Expenses")} className="text-[10px] text-blue-600 font-semibold flex items-center gap-0.5 hover:underline">
          Expenses <ChevronRight className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-1">
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 5 }}>
              <XAxis type="number" tick={{ fontSize: 9, fill: '#94a3b8' }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} width={95} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
              <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={14}>
                {chartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-[200px]">
            <Receipt className="w-6 h-6 text-slate-200 mr-2" />
            <p className="text-xs text-slate-400">No expenses recorded</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}