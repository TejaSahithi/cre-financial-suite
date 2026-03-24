import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { AlertTriangle, TrendingUp, TrendingDown, Target } from "lucide-react";

export default function VarianceTab({ expenses, budgets }) {
  const totalBudgetedExpenses = budgets.reduce((s, b) => s + (b.total_expenses || 0), 0);
  const totalActualExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const variance = totalBudgetedExpenses - totalActualExpenses;

  const budgetByCategory = {};
  budgets.forEach(b => {
    (b.expense_items || []).forEach(item => {
      const cat = item.category || 'Other';
      budgetByCategory[cat] = (budgetByCategory[cat] || 0) + (item.amount || 0);
    });
  });

  const actualByCategory = {};
  expenses.forEach(e => {
    const cat = e.category || 'other';
    actualByCategory[cat] = (actualByCategory[cat] || 0) + (e.amount || 0);
  });

  const allCategories = [...new Set([...Object.keys(budgetByCategory), ...Object.keys(actualByCategory)])];
  const categoryData = allCategories.map(cat => {
    const budget = budgetByCategory[cat] || 0;
    const actual = actualByCategory[cat] || 0;
    const v = budget - actual;
    return { category: cat.replace(/_/g, ' '), budget, actual, variance: v, pct: budget ? ((v / budget) * 100).toFixed(1) : '0' };
  }).sort((a, b) => a.variance - b.variance);

  const alerts = categoryData.filter(c => c.variance < 0).slice(0, 5);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Budgeted Expenses", value: `$${(totalBudgetedExpenses/1000).toFixed(0)}K`, icon: Target, color: "bg-blue-50 text-blue-600" },
          { label: "Actual Expenses", value: `$${(totalActualExpenses/1000).toFixed(0)}K`, icon: TrendingUp, color: "bg-slate-50 text-slate-600" },
          { label: "Total Variance", value: `$${(Math.abs(variance)/1000).toFixed(0)}K`, icon: variance >= 0 ? TrendingDown : TrendingUp, color: variance >= 0 ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-600" },
          { label: "Over-Budget Items", value: alerts.length, icon: AlertTriangle, color: "bg-amber-50 text-amber-600" },
        ].map((s, i) => (
          <Card key={i}><CardContent className="p-4 flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${s.color}`}><s.icon className="w-5 h-5" /></div>
            <div><p className="text-[10px] font-semibold text-slate-500 uppercase">{s.label}</p><p className="text-xl font-bold">{s.value}</p></div>
          </CardContent></Card>
        ))}
      </div>

      {alerts.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/50">
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-500" />Over-Budget Alerts</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {alerts.map(a => (
                <div key={a.category} className="flex items-center justify-between bg-white rounded-lg p-3 border border-amber-200">
                  <span className="text-sm font-medium capitalize">{a.category}</span>
                  <div className="flex items-center gap-4">
                    <span className="text-xs text-slate-500">Budget: ${a.budget.toLocaleString()}</span>
                    <span className="text-xs text-slate-500">Actual: ${a.actual.toLocaleString()}</span>
                    <Badge className="bg-red-100 text-red-700">{a.pct}% over</Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Budget vs Actual by Category</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={categoryData.slice(0, 10)} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}K`} />
              <YAxis type="category" dataKey="category" width={120} tick={{ fontSize: 10 }} />
              <Tooltip formatter={v => `$${v.toLocaleString()}`} />
              <Legend />
              <Bar dataKey="budget" fill="#1a2744" name="Budget" />
              <Bar dataKey="actual" fill="#3b82f6" name="Actual" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Detailed Variance</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[11px]">CATEGORY</TableHead>
                <TableHead className="text-[11px] text-right">BUDGET</TableHead>
                <TableHead className="text-[11px] text-right">ACTUAL</TableHead>
                <TableHead className="text-[11px] text-right">VARIANCE</TableHead>
                <TableHead className="text-[11px] text-right">% DIFF</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categoryData.map(row => (
                <TableRow key={row.category}>
                  <TableCell className="font-medium capitalize">{row.category}</TableCell>
                  <TableCell className="text-right font-mono">${row.budget.toLocaleString()}</TableCell>
                  <TableCell className="text-right font-mono">${row.actual.toLocaleString()}</TableCell>
                  <TableCell className={`text-right font-mono ${row.variance >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {row.variance >= 0 ? '+' : '-'}${Math.abs(row.variance).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge className={row.variance >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}>
                      {row.pct}%
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}