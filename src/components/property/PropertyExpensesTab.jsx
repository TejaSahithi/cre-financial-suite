import React from "react";
import { budgetService } from "@/services/budgetService";
import { expenseService } from "@/services/expenseService";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Plus, Upload, TrendingUp, TrendingDown, Minus } from "lucide-react";

export default function PropertyExpensesTab({ propertyId }) {
  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;

  const { data: expenses = [] } = useQuery({
    queryKey: ['expenses-prop', propertyId],
    queryFn: () => expenseService.filter({ property_id: propertyId }),
    enabled: !!propertyId,
  });

  const { data: budgets = [] } = useQuery({
    queryKey: ['budgets-prop', propertyId],
    queryFn: () => budgetService.filter({ property_id: propertyId }),
    enabled: !!propertyId,
  });

  const currentExpenses = expenses.filter(e => e.fiscal_year === currentYear);
  const prevExpenses = expenses.filter(e => e.fiscal_year === prevYear);
  const currentTotal = currentExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  const prevTotal = prevExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  const variance = prevTotal > 0 ? ((currentTotal - prevTotal) / prevTotal * 100).toFixed(1) : 0;

  const currentBudget = budgets.find(b => b.budget_year === currentYear);
  const budgetedExpenses = currentBudget?.total_expenses || 0;
  const budgetVariance = budgetedExpenses > 0 ? ((currentTotal - budgetedExpenses) / budgetedExpenses * 100).toFixed(1) : 0;

  // Group by category
  const categoryTotals = {};
  currentExpenses.forEach(e => {
    const cat = e.category || 'other';
    if (!categoryTotals[cat]) categoryTotals[cat] = { current: 0, prev: 0, budgeted: 0 };
    categoryTotals[cat].current += e.amount || 0;
  });
  prevExpenses.forEach(e => {
    const cat = e.category || 'other';
    if (!categoryTotals[cat]) categoryTotals[cat] = { current: 0, prev: 0, budgeted: 0 };
    categoryTotals[cat].prev += e.amount || 0;
  });
  if (currentBudget?.expense_items) {
    currentBudget.expense_items.forEach(item => {
      const cat = item.category || 'other';
      if (!categoryTotals[cat]) categoryTotals[cat] = { current: 0, prev: 0, budgeted: 0 };
      categoryTotals[cat].budgeted += item.amount || 0;
    });
  }

  const recoverable = currentExpenses.filter(e => e.classification === 'recoverable').reduce((s, e) => s + (e.amount || 0), 0);
  const nonRecoverable = currentExpenses.filter(e => e.classification === 'non_recoverable').reduce((s, e) => s + (e.amount || 0), 0);

  const VarianceIcon = ({ val }) => {
    const n = parseFloat(val);
    if (n > 2) return <TrendingUp className="w-3 h-3 text-red-500" />;
    if (n < -2) return <TrendingDown className="w-3 h-3 text-emerald-500" />;
    return <Minus className="w-3 h-3 text-slate-400" />;
  };

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Current Year ({currentYear})</p>
            <p className="text-xl font-bold text-slate-900">${currentTotal.toLocaleString()}</p>
            <div className="flex items-center gap-1 mt-1">
              <VarianceIcon val={variance} />
              <span className={`text-[10px] ${parseFloat(variance) > 0 ? 'text-red-500' : 'text-emerald-600'}`}>{variance}% vs {prevYear}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Previous Year ({prevYear})</p>
            <p className="text-xl font-bold text-slate-500">${prevTotal.toLocaleString()}</p>
            <p className="text-[10px] text-slate-400">Historical baseline</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Budgeted ({currentYear})</p>
            <p className="text-xl font-bold text-blue-600">${budgetedExpenses.toLocaleString()}</p>
            <div className="flex items-center gap-1 mt-1">
              <VarianceIcon val={budgetVariance} />
              <span className={`text-[10px] ${parseFloat(budgetVariance) > 0 ? 'text-red-500' : 'text-emerald-600'}`}>{budgetVariance}% actual vs budget</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Recoverable</p>
            <p className="text-xl font-bold text-emerald-600">${recoverable.toLocaleString()}</p>
            <p className="text-[10px] text-slate-400">Non-recoverable: ${nonRecoverable.toLocaleString()}</p>
          </CardContent>
        </Card>
      </div>

      {/* Category comparison table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Expense by Category — Actual vs Budget vs Prior Year</CardTitle>
          <div className="flex gap-2">
            <Link to={createPageUrl("BulkImport") + `?property=${propertyId}`}><Button variant="outline" size="sm"><Upload className="w-3 h-3 mr-1" />Import</Button></Link>
            <Link to={createPageUrl("AddExpense") + `?property=${propertyId}`}><Button size="sm" className="bg-blue-600 hover:bg-blue-700"><Plus className="w-3 h-3 mr-1" />Add</Button></Link>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[11px]">CATEGORY</TableHead>
                <TableHead className="text-[11px] text-right">ACTUAL {currentYear}</TableHead>
                <TableHead className="text-[11px] text-right">BUDGET {currentYear}</TableHead>
                <TableHead className="text-[11px] text-right">ACTUAL {prevYear}</TableHead>
                <TableHead className="text-[11px] text-right">YOY CHANGE</TableHead>
                <TableHead className="text-[11px] text-right">BUDGET VAR.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(categoryTotals).sort(([,a],[,b]) => b.current - a.current).map(([cat, vals]) => {
                const yoy = vals.prev > 0 ? ((vals.current - vals.prev) / vals.prev * 100).toFixed(1) : '—';
                const bv = vals.budgeted > 0 ? ((vals.current - vals.budgeted) / vals.budgeted * 100).toFixed(1) : '—';
                return (
                  <TableRow key={cat}>
                    <TableCell className="text-sm capitalize">{cat.replace(/_/g, ' ')}</TableCell>
                    <TableCell className="text-sm font-mono text-right">${vals.current.toLocaleString()}</TableCell>
                    <TableCell className="text-sm font-mono text-right text-blue-600">${vals.budgeted.toLocaleString()}</TableCell>
                    <TableCell className="text-sm font-mono text-right text-slate-400">${vals.prev.toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      {yoy !== '—' ? <span className={`text-xs ${parseFloat(yoy) > 0 ? 'text-red-500' : 'text-emerald-600'}`}>{yoy}%</span> : <span className="text-xs text-slate-300">—</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      {bv !== '—' ? <span className={`text-xs ${parseFloat(bv) > 0 ? 'text-red-500' : 'text-emerald-600'}`}>{bv}%</span> : <span className="text-xs text-slate-300">—</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
              {Object.keys(categoryTotals).length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-sm text-slate-400">No expenses recorded yet</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}