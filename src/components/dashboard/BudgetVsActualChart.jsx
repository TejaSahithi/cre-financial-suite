import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { BarChart3, ChevronRight } from "lucide-react";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const budget = payload.find(p => p.dataKey === 'Budget')?.value || 0;
  const actual = payload.find(p => p.dataKey === 'Actual')?.value || 0;
  const variance = actual - budget;
  const variancePct = budget > 0 ? (variance / budget * 100) : 0;
  return (
    <div className="bg-slate-900 rounded-lg px-3.5 py-2.5 shadow-xl border border-slate-700 text-xs">
      <p className="font-semibold text-slate-300 mb-1.5">{label}</p>
      <div className="space-y-1">
        <div className="flex justify-between gap-4"><span className="text-slate-400">Budget</span><span className="text-white font-bold tabular-nums">${budget.toLocaleString()}</span></div>
        <div className="flex justify-between gap-4"><span className="text-slate-400">Actual</span><span className="text-white font-bold tabular-nums">${actual.toLocaleString()}</span></div>
        <div className="border-t border-slate-700 pt-1 flex justify-between gap-4">
          <span className="text-slate-400">Variance</span>
          <span className={`font-bold tabular-nums ${variance <= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {variance <= 0 ? '−' : '+'}${Math.abs(variance).toLocaleString()} ({variancePct.toFixed(1)}%)
          </span>
        </div>
      </div>
    </div>
  );
};

export default function BudgetVsActualChart({ budgets = [], expenses = [] }) {
  const expByMonth = {};
  expenses.forEach(e => {
    const m = e.month || (e.date ? new Date(e.date).getMonth() + 1 : null);
    if (m) expByMonth[m] = (expByMonth[m] || 0) + (e.amount || 0);
  });

  const totalBudget = budgets.reduce((s, b) => s + (b.total_expenses || 0), 0);
  const monthlyBudget = totalBudget / 12;
  const totalActual = Object.values(expByMonth).reduce((s, v) => s + v, 0);
  const variance = totalBudget > 0 ? ((totalActual - totalBudget) / totalBudget * 100) : 0;
  const ytdMonths = Object.keys(expByMonth).length;
  const runRate = ytdMonths > 0 ? (totalActual / ytdMonths) * 12 : 0;
  const hasData = expenses.length > 0 || budgets.length > 0;

  const chartData = MONTHS.map((month, i) => ({
    month,
    Budget: Math.round(monthlyBudget),
    Actual: expByMonth[i + 1] || 0,
  }));

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-1 pt-3 px-4 flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-sm font-bold text-slate-900">Budget vs Actuals</CardTitle>
          <p className="text-[10px] text-slate-500">
            {hasData ? (
              <>YTD: ${(totalActual / 1000).toFixed(0)}K of ${(totalBudget / 1000).toFixed(0)}K budget · Run rate: ${(runRate / 1000).toFixed(0)}K/yr</>
            ) : 'No data'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasData && totalBudget > 0 && (
            <Badge className={`${variance <= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'} text-[10px] font-bold`}>
              {variance <= 0 ? '↓' : '↑'}{Math.abs(variance).toFixed(1)}%
            </Badge>
          )}
          <Link to={createPageUrl("BudgetDashboard")} className="text-[10px] text-blue-600 font-semibold flex items-center gap-0.5 hover:underline">
            Budget <ChevronRight className="w-3 h-3" />
          </Link>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-1">
        {hasData ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} axisLine={false} tickLine={false} width={45} />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
              <Legend iconType="circle" iconSize={6} wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
              <Bar dataKey="Budget" fill="#1e293b" radius={[3, 3, 0, 0]} barSize={12} />
              <Bar dataKey="Actual" fill="#3b82f6" radius={[3, 3, 0, 0]} barSize={12} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex flex-col items-center justify-center h-[220px]">
            <BarChart3 className="w-8 h-8 text-slate-200 mb-2" />
            <p className="text-xs text-slate-400">No financial data yet</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}