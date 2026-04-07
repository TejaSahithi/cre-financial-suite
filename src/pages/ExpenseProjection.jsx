import React, { useState, useMemo } from "react";
import { budgetService } from "@/services/budgetService";
import { expenseService } from "@/services/expenseService";
import { propertyService } from "@/services/propertyService";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function ExpenseProjection() {
  const location = useLocation();
  const urlParams = new URLSearchParams(location.search);
  const initProperty = urlParams.get("property") || "";
  const [selectedProperty, setSelectedProperty] = useState(initProperty);
  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;

  const { data: properties = [] } = useQuery({
    queryKey: ['properties-exp-proj'],
    queryFn: () => propertyService.list(),
  });

  const { data: expenses = [], isLoading } = useQuery({
    queryKey: ['expenses-proj', selectedProperty],
    queryFn: () => selectedProperty
      ? expenseService.filter({ property_id: selectedProperty })
      : expenseService.list(),
  });

  const { data: budgets = [] } = useQuery({
    queryKey: ['budgets-proj', selectedProperty],
    queryFn: () => selectedProperty
      ? budgetService.filter({ property_id: selectedProperty })
      : budgetService.list(),
  });

  const currentBudget = budgets.find(b => b.budget_year === currentYear);
  const prevBudget = budgets.find(b => b.budget_year === prevYear);

  const currentExpenses = expenses.filter(e => e.fiscal_year === currentYear);
  const prevExpenses = expenses.filter(e => e.fiscal_year === prevYear);

  // Category breakdown: current actual, prev actual, current budgeted, projected
  const categoryData = useMemo(() => {
    const cats = {};
    currentExpenses.forEach(e => {
      const c = e.category || 'other';
      if (!cats[c]) cats[c] = { current: 0, prev: 0, budgeted: 0, classification: e.classification };
      cats[c].current += e.amount || 0;
    });
    prevExpenses.forEach(e => {
      const c = e.category || 'other';
      if (!cats[c]) cats[c] = { current: 0, prev: 0, budgeted: 0, classification: e.classification };
      cats[c].prev += e.amount || 0;
    });
    if (currentBudget?.expense_items) {
      currentBudget.expense_items.forEach(item => {
        const c = item.category || 'other';
        if (!cats[c]) cats[c] = { current: 0, prev: 0, budgeted: 0 };
        cats[c].budgeted += item.amount || 0;
      });
    }
    return Object.entries(cats).sort(([, a], [, b]) => b.current - a.current).map(([cat, vals]) => {
      // Projected = if we have budget, use budget; otherwise estimate from trend
      const projected = vals.budgeted > 0 ? vals.budgeted : (vals.prev > 0 ? vals.prev * 1.03 : vals.current);
      return { category: cat, ...vals, projected };
    });
  }, [currentExpenses, prevExpenses, currentBudget]);

  const totalCurrent = categoryData.reduce((s, c) => s + c.current, 0);
  const totalPrev = categoryData.reduce((s, c) => s + c.prev, 0);
  const totalBudgeted = currentBudget?.total_expenses || categoryData.reduce((s, c) => s + c.budgeted, 0);
  const totalProjected = categoryData.reduce((s, c) => s + c.projected, 0);

  // Monthly chart
  const monthlyChart = useMemo(() => {
    return MONTHS.map((month, i) => {
      const curMonth = currentExpenses.filter(e => e.month === i + 1).reduce((s, e) => s + (e.amount || 0), 0);
      const prevMonth = prevExpenses.filter(e => e.month === i + 1).reduce((s, e) => s + (e.amount || 0), 0);
      const budgetMonth = totalBudgeted > 0 ? totalBudgeted / 12 : 0;
      return { month, current: Math.round(curMonth), previous: Math.round(prevMonth), budget: Math.round(budgetMonth) };
    });
  }, [currentExpenses, prevExpenses, totalBudgeted]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Expense Projection</h1>
          <p className="text-sm text-slate-500 mt-1">Projected expenses vs previous year actuals and budget</p>
        </div>
        <Select value={selectedProperty} onValueChange={setSelectedProperty}>
          <SelectTrigger className="w-64"><SelectValue placeholder="All Properties" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={null}>All Properties</SelectItem>
            {properties.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-l-4 border-l-blue-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Actual YTD ({currentYear})</p>
            <p className="text-2xl font-bold text-slate-900">${totalCurrent.toLocaleString()}</p>
            {totalPrev > 0 && <p className="text-[10px] text-slate-400">{((totalCurrent - totalPrev) / totalPrev * 100).toFixed(1)}% vs prior</p>}
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-slate-400">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Prior Year ({prevYear})</p>
            <p className="text-2xl font-bold text-slate-500">${totalPrev.toLocaleString()}</p>
            <p className="text-[10px] text-slate-400">Historical baseline</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-emerald-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Budgeted ({currentYear})</p>
            <p className="text-2xl font-bold text-blue-600">${totalBudgeted.toLocaleString()}</p>
            <p className="text-[10px] text-slate-400">From approved budget</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Projected (Next Year)</p>
            <p className="text-2xl font-bold text-amber-600">${Math.round(totalProjected).toLocaleString()}</p>
            <p className="text-[10px] text-slate-400">Based on trend + budget</p>
          </CardContent>
        </Card>
      </div>

      {/* Chart */}
      <Card>
        <CardHeader><CardTitle className="text-base">Monthly — Actual vs Previous Year vs Budget</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={monthlyChart}>
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} />
              <Tooltip formatter={v => `$${v.toLocaleString()}`} />
              <Legend />
              <Bar dataKey="current" name={`Actual ${currentYear}`} fill="#1a2744" radius={[2, 2, 0, 0]} barSize={20} />
              <Bar dataKey="previous" name={`Actual ${prevYear}`} fill="#94a3b8" radius={[2, 2, 0, 0]} barSize={20} />
              <Bar dataKey="budget" name={`Budget ${currentYear}`} fill="#3b82f6" radius={[2, 2, 0, 0]} barSize={20} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Category detail */}
      <Card>
        <CardHeader><CardTitle className="text-base">Category Comparison — Actual vs Budget vs Prior Year vs Projected</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="text-[11px]">CATEGORY</TableHead>
                  <TableHead className="text-[11px] text-right">ACTUAL {currentYear}</TableHead>
                  <TableHead className="text-[11px] text-right">ACTUAL {prevYear}</TableHead>
                  <TableHead className="text-[11px] text-right">BUDGET {currentYear}</TableHead>
                  <TableHead className="text-[11px] text-right">PROJECTED</TableHead>
                  <TableHead className="text-[11px] text-right">YOY CHANGE</TableHead>
                  <TableHead className="text-[11px] text-right">BUDGET VAR.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categoryData.map(c => {
                  const yoy = c.prev > 0 ? ((c.current - c.prev) / c.prev * 100).toFixed(1) : null;
                  const bv = c.budgeted > 0 ? ((c.current - c.budgeted) / c.budgeted * 100).toFixed(1) : null;
                  return (
                    <TableRow key={c.category}>
                      <TableCell className="text-sm capitalize">{c.category.replace(/_/g, ' ')}</TableCell>
                      <TableCell className="text-sm font-mono text-right">${c.current.toLocaleString()}</TableCell>
                      <TableCell className="text-sm font-mono text-right text-slate-400">${c.prev.toLocaleString()}</TableCell>
                      <TableCell className="text-sm font-mono text-right text-blue-600">${c.budgeted.toLocaleString()}</TableCell>
                      <TableCell className="text-sm font-mono text-right text-amber-600">${Math.round(c.projected).toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        {yoy !== null ? <span className={`text-xs ${parseFloat(yoy) > 0 ? 'text-red-500' : 'text-emerald-600'}`}>{yoy}%</span> : <span className="text-xs text-slate-300">—</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        {bv !== null ? <span className={`text-xs ${parseFloat(bv) > 0 ? 'text-red-500' : 'text-emerald-600'}`}>{bv}%</span> : <span className="text-xs text-slate-300">—</span>}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {categoryData.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-sm text-slate-400">No expense data</TableCell></TableRow>
                )}
                {categoryData.length > 0 && (
                  <TableRow className="bg-slate-50 font-bold">
                    <TableCell className="text-sm">TOTAL</TableCell>
                    <TableCell className="text-sm font-mono text-right">${totalCurrent.toLocaleString()}</TableCell>
                    <TableCell className="text-sm font-mono text-right text-slate-400">${totalPrev.toLocaleString()}</TableCell>
                    <TableCell className="text-sm font-mono text-right text-blue-600">${totalBudgeted.toLocaleString()}</TableCell>
                    <TableCell className="text-sm font-mono text-right text-amber-600">${Math.round(totalProjected).toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      {totalPrev > 0 && <span className={`text-xs ${totalCurrent > totalPrev ? 'text-red-500' : 'text-emerald-600'}`}>{((totalCurrent - totalPrev) / totalPrev * 100).toFixed(1)}%</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      {totalBudgeted > 0 && <span className={`text-xs ${totalCurrent > totalBudgeted ? 'text-red-500' : 'text-emerald-600'}`}>{((totalCurrent - totalBudgeted) / totalBudgeted * 100).toFixed(1)}%</span>}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}