import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { budgetService } from "@/services/budgetService";
import { expenseService } from "@/services/expenseService";
import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { BarChart3 } from "lucide-react";

export default function BudgetChart() {
  const { data: budgets = [] } = useQuery({
    queryKey: ['budgets'],
    queryFn: () => budgetService.list(),
  });

  const { data: expenses = [] } = useQuery({
    queryKey: ['expenses'],
    queryFn: () => expenseService.list(),
  });

  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  
  // Aggregate expenses by month
  const expByMonth = {};
  expenses.forEach(e => {
    const m = e.month || (e.date ? new Date(e.date).getMonth() + 1 : null);
    if (m) expByMonth[m] = (expByMonth[m] || 0) + (e.amount || 0);
  });

  const totalBudget = budgets.reduce((s, b) => s + (b.total_expenses || 0), 0);
  const monthlyBudget = totalBudget / 12;

  const hasData = expenses.length > 0 || budgets.length > 0;

  const chartData = MONTHS.map((month, i) => ({
    month,
    budget: Math.round(monthlyBudget),
    actual: expByMonth[i + 1] || 0,
  }));

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-bold text-slate-900">Budget vs. Actuals</CardTitle>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} axisLine={false} tickLine={false} />
              <Tooltip formatter={v => `$${v.toLocaleString()}`} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="budget" fill="#1a2744" radius={[3, 3, 0, 0]} barSize={14} name="Budget" />
              <Bar dataKey="actual" fill="#3b82f6" radius={[3, 3, 0, 0]} barSize={14} name="Actual" />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex flex-col items-center justify-center h-[280px] text-center">
            <BarChart3 className="w-10 h-10 text-slate-200 mb-3" />
            <p className="text-sm font-medium text-slate-400">No budget or expense data yet</p>
            <p className="text-xs text-slate-300 mt-1">Create a budget or add expenses to see this chart</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}