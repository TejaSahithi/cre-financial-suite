import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TrendingUp, TrendingDown, AlertTriangle, ChevronDown, ChevronUp, Minus } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";

function getIncreaseReasons(vendor, currentExpenses, priorExpenses) {
  const reasons = [];

  // Category shifts
  const currCats = {};
  const priorCats = {};
  currentExpenses.forEach(e => { currCats[e.category] = (currCats[e.category] || 0) + (e.amount || 0); });
  priorExpenses.forEach(e => { priorCats[e.category] = (priorCats[e.category] || 0) + (e.amount || 0); });

  Object.keys(currCats).forEach(cat => {
    const curr = currCats[cat] || 0;
    const prior = priorCats[cat] || 0;
    if (curr > prior && prior > 0) {
      const pct = ((curr - prior) / prior * 100).toFixed(0);
      if (pct > 15) reasons.push({ text: `${cat.replace(/_/g, ' ')} up ${pct}%`, type: "category_increase" });
    } else if (curr > 0 && prior === 0) {
      reasons.push({ text: `New: ${cat.replace(/_/g, ' ')} ($${curr.toLocaleString()})`, type: "new_category" });
    }
  });

  // Volume increase
  if (currentExpenses.length > priorExpenses.length * 1.2 && priorExpenses.length > 0) {
    reasons.push({ text: `${currentExpenses.length - priorExpenses.length} more transactions`, type: "volume" });
  }

  // Avg amount increase
  const avgCurr = currentExpenses.length > 0 ? currentExpenses.reduce((s, e) => s + (e.amount || 0), 0) / currentExpenses.length : 0;
  const avgPrior = priorExpenses.length > 0 ? priorExpenses.reduce((s, e) => s + (e.amount || 0), 0) / priorExpenses.length : 0;
  if (avgPrior > 0 && avgCurr > avgPrior * 1.15) {
    reasons.push({ text: `Avg transaction up ${((avgCurr - avgPrior) / avgPrior * 100).toFixed(0)}%`, type: "avg_increase" });
  }

  return reasons;
}

export default function VendorSpendAnalysis({ expenses, vendors, budgets }) {
  const [expanded, setExpanded] = useState(null);
  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;

  // Build vendor spend data
  const vendorData = vendors.map(v => {
    const vExpenses = expenses.filter(e => e.vendor?.toLowerCase() === v.name?.toLowerCase() || e.vendor_id === v.id);
    const currYearExp = vExpenses.filter(e => e.fiscal_year === currentYear);
    const prevYearExp = vExpenses.filter(e => e.fiscal_year === prevYear);
    const currTotal = currYearExp.reduce((s, e) => s + (e.amount || 0), 0);
    const prevTotal = prevYearExp.reduce((s, e) => s + (e.amount || 0), 0);
    const yoyChange = prevTotal > 0 ? ((currTotal - prevTotal) / prevTotal * 100) : null;

    // Monthly comparison (current month vs prior month)
    const now = new Date();
    const currMonth = now.getMonth() + 1;
    const currMonthExp = currYearExp.filter(e => e.month === currMonth);
    const prevMonthExp = currYearExp.filter(e => e.month === currMonth - 1);
    const momCurr = currMonthExp.reduce((s, e) => s + (e.amount || 0), 0);
    const momPrev = prevMonthExp.reduce((s, e) => s + (e.amount || 0), 0);
    const momChange = momPrev > 0 ? ((momCurr - momPrev) / momPrev * 100) : null;

    // Budget comparison
    const budgetMatch = budgets.find(b => b.budget_year === currentYear);
    const budgetedVendorAmount = budgetMatch?.expense_items?.find(
      ei => ei.vendor?.toLowerCase() === v.name?.toLowerCase()
    )?.amount || null;
    const overBudget = budgetedVendorAmount ? currTotal > budgetedVendorAmount : false;

    const reasons = currTotal > prevTotal && prevTotal > 0 ? getIncreaseReasons(v.name, currYearExp, prevYearExp) : [];

    return {
      ...v, currTotal, prevTotal, yoyChange, momCurr, momPrev, momChange,
      budgetedVendorAmount, overBudget, reasons, currYearExp, prevYearExp
    };
  }).filter(v => v.currTotal > 0 || v.prevTotal > 0).sort((a, b) => b.currTotal - a.currTotal);

  // Top 8 vendors for chart
  const chartData = vendorData.slice(0, 8).map(v => ({
    name: v.name?.substring(0, 12) || "Unknown",
    [currentYear]: v.currTotal,
    [prevYear]: v.prevTotal,
  }));

  const alertVendors = vendorData.filter(v => (v.yoyChange && v.yoyChange > 20) || v.overBudget);

  return (
    <div className="space-y-4">
      {/* Alerts */}
      {alertVendors.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/50">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              <span className="text-sm font-semibold text-amber-800">{alertVendors.length} Vendor Alert{alertVendors.length > 1 ? 's' : ''}</span>
            </div>
            <div className="space-y-1.5">
              {alertVendors.slice(0, 4).map(v => (
                <div key={v.id} className="flex items-center justify-between text-xs">
                  <span className="font-medium text-amber-900">{v.name}</span>
                  <div className="flex gap-2">
                    {v.yoyChange > 20 && <Badge className="bg-amber-200 text-amber-800 text-[9px]">YoY +{v.yoyChange.toFixed(0)}%</Badge>}
                    {v.overBudget && <Badge className="bg-red-200 text-red-800 text-[9px]">Over Budget</Badge>}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* YoY Chart */}
      {chartData.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Vendor Spend: {prevYear} vs {currentYear}</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} margin={{ left: 10 }}>
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} />
                <Tooltip formatter={v => `$${v.toLocaleString()}`} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey={prevYear} fill="#94a3b8" radius={[4, 4, 0, 0]} barSize={18} />
                <Bar dataKey={currentYear} fill="#1a2744" radius={[4, 4, 0, 0]} barSize={18} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Detail Table */}
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[10px] font-bold">VENDOR</TableHead>
                <TableHead className="text-[10px] font-bold text-right">FY {prevYear}</TableHead>
                <TableHead className="text-[10px] font-bold text-right">FY {currentYear}</TableHead>
                <TableHead className="text-[10px] font-bold text-right">YoY Δ</TableHead>
                <TableHead className="text-[10px] font-bold text-right">MoM Δ</TableHead>
                <TableHead className="text-[10px] font-bold">FLAGS</TableHead>
                <TableHead className="text-[10px] font-bold w-8"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendorData.map(v => (
                <React.Fragment key={v.id}>
                  <TableRow className="hover:bg-slate-50 cursor-pointer" onClick={() => setExpanded(expanded === v.id ? null : v.id)}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg bg-violet-100 flex items-center justify-center text-violet-600 font-bold text-[10px]">{v.name?.charAt(0)}</div>
                        <span className="text-sm font-medium">{v.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-slate-500">${v.prevTotal.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums font-semibold">${v.currTotal.toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      {v.yoyChange !== null ? (
                        <span className={`text-xs font-semibold flex items-center justify-end gap-0.5 ${v.yoyChange > 0 ? 'text-red-600' : v.yoyChange < 0 ? 'text-emerald-600' : 'text-slate-400'}`}>
                          {v.yoyChange > 0 ? <TrendingUp className="w-3 h-3" /> : v.yoyChange < 0 ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                          {v.yoyChange > 0 ? '+' : ''}{v.yoyChange.toFixed(1)}%
                        </span>
                      ) : <span className="text-xs text-slate-300">—</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      {v.momChange !== null ? (
                        <span className={`text-xs font-medium ${v.momChange > 0 ? 'text-red-500' : v.momChange < 0 ? 'text-emerald-500' : 'text-slate-400'}`}>
                          {v.momChange > 0 ? '+' : ''}{v.momChange.toFixed(0)}%
                        </span>
                      ) : <span className="text-xs text-slate-300">—</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1 flex-wrap">
                        {v.overBudget && <Badge className="bg-red-100 text-red-700 text-[8px]">OVER BUDGET</Badge>}
                        {v.yoyChange > 20 && <Badge className="bg-amber-100 text-amber-700 text-[8px]">SPIKE</Badge>}
                      </div>
                    </TableCell>
                    <TableCell>{expanded === v.id ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}</TableCell>
                  </TableRow>
                  {expanded === v.id && (
                    <TableRow>
                      <TableCell colSpan={7} className="bg-slate-50/80 p-4">
                        <div className="space-y-3">
                          {v.reasons.length > 0 && (
                            <div>
                              <p className="text-[10px] font-bold text-slate-500 uppercase mb-1">Increase Drivers</p>
                              <div className="flex flex-wrap gap-1.5">
                                {v.reasons.map((r, i) => (
                                  <Badge key={i} variant="outline" className="text-[10px] font-normal">{r.text}</Badge>
                                ))}
                              </div>
                            </div>
                          )}
                          {v.budgetedVendorAmount && (
                            <div className="flex items-center gap-2 text-xs">
                              <span className="text-slate-500">Budgeted:</span>
                              <span className="font-mono font-medium">${v.budgetedVendorAmount.toLocaleString()}</span>
                              <span className="text-slate-500">|</span>
                              <span className="text-slate-500">Actual:</span>
                              <span className="font-mono font-medium">${v.currTotal.toLocaleString()}</span>
                              <span className={`font-semibold ${v.overBudget ? 'text-red-600' : 'text-emerald-600'}`}>
                                ({v.overBudget ? 'Over' : 'Under'} by ${Math.abs(v.currTotal - v.budgetedVendorAmount).toLocaleString()})
                              </span>
                            </div>
                          )}
                          <div>
                            <p className="text-[10px] font-bold text-slate-500 uppercase mb-1">Recent Transactions ({currentYear})</p>
                            <div className="grid gap-1 max-h-28 overflow-y-auto">
                              {v.currYearExp.slice(0, 6).map(e => (
                                <div key={e.id} className="flex items-center justify-between text-xs bg-white rounded px-3 py-1.5 border border-slate-100">
                                  <span className="text-slate-500">{e.date || `M${e.month || '?'}`}</span>
                                  <span className="capitalize text-slate-600">{e.category?.replace(/_/g, ' ')}</span>
                                  <span className="font-mono font-semibold">${(e.amount || 0).toLocaleString()}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}