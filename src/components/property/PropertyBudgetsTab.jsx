import React from "react";
import { budgetService } from "@/services/budgetService";
import { leaseService } from "@/services/leaseService";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Plus, TrendingUp, TrendingDown } from "lucide-react";

export default function PropertyBudgetsTab({ propertyId }) {
  const currentYear = new Date().getFullYear();

  const { data: budgets = [] } = useQuery({
    queryKey: ['budgets-prop-tab', propertyId],
    queryFn: () => budgetService.filter({ property_id: propertyId }),
    enabled: !!propertyId,
  });

  const { data: leases = [] } = useQuery({
    queryKey: ['leases-budget-prop', propertyId],
    queryFn: () => leaseService.filter({ property_id: propertyId }),
    enabled: !!propertyId,
  });

  const statusColors = {
    draft: "bg-slate-100 text-slate-600", ai_generated: "bg-blue-100 text-blue-700",
    under_review: "bg-red-100 text-red-700", reviewed: "bg-amber-100 text-amber-700",
    approved: "bg-emerald-100 text-emerald-700", signed: "bg-green-100 text-green-700",
    locked: "bg-slate-800 text-white"
  };

  const sortedBudgets = [...budgets].sort((a, b) => (b.budget_year || 0) - (a.budget_year || 0));
  const currentBudget = sortedBudgets.find(b => b.budget_year === currentYear);
  const prevBudget = sortedBudgets.find(b => b.budget_year === currentYear - 1);

  const totalLeaseRevenue = leases.reduce((s, l) => s + (l.annual_rent || 0), 0);

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Current Budget ({currentYear})</p>
            <p className="text-xl font-bold text-slate-900">${(currentBudget?.total_revenue || 0).toLocaleString()}</p>
            <p className="text-[10px] text-slate-400">Total Revenue</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Prior Budget ({currentYear - 1})</p>
            <p className="text-xl font-bold text-slate-500">${(prevBudget?.total_revenue || 0).toLocaleString()}</p>
            <p className="text-[10px] text-slate-400">Historical baseline</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Lease-Driven Revenue</p>
            <p className="text-xl font-bold text-blue-600">${totalLeaseRevenue.toLocaleString()}</p>
            <p className="text-[10px] text-slate-400">From {leases.length} active leases</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">NOI ({currentYear})</p>
            <p className="text-xl font-bold text-emerald-600">${(currentBudget?.noi || 0).toLocaleString()}</p>
            {prevBudget?.noi > 0 && (
              <div className="flex items-center gap-1 mt-1">
                {(currentBudget?.noi || 0) >= (prevBudget?.noi || 0) ? <TrendingUp className="w-3 h-3 text-emerald-500" /> : <TrendingDown className="w-3 h-3 text-red-500" />}
                <span className="text-[10px]">{(((currentBudget?.noi || 0) - prevBudget.noi) / prevBudget.noi * 100).toFixed(1)}% vs prior</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Budget comparison table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Budget History — Year over Year Comparison</CardTitle>
          <Link to={createPageUrl("CreateBudget") + `?property=${propertyId}`}>
            <Button size="sm" className="bg-blue-600 hover:bg-blue-700"><Plus className="w-3 h-3 mr-1" />Create Budget</Button>
          </Link>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[11px]">BUDGET NAME</TableHead>
                <TableHead className="text-[11px]">YEAR</TableHead>
                <TableHead className="text-[11px]">METHOD</TableHead>
                <TableHead className="text-[11px] text-right">REVENUE</TableHead>
                <TableHead className="text-[11px] text-right">EXPENSES</TableHead>
                <TableHead className="text-[11px] text-right">CAM TOTAL</TableHead>
                <TableHead className="text-[11px] text-right">NOI</TableHead>
                <TableHead className="text-[11px]">STATUS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedBudgets.length > 0 ? sortedBudgets.map(b => (
                <TableRow key={b.id}>
                  <TableCell className="text-sm font-medium">{b.name}</TableCell>
                  <TableCell className="text-sm">{b.budget_year}</TableCell>
                  <TableCell className="text-xs capitalize">{b.generation_method?.replace('_', ' ')}</TableCell>
                  <TableCell className="text-sm font-mono text-right text-emerald-600">${(b.total_revenue || 0).toLocaleString()}</TableCell>
                  <TableCell className="text-sm font-mono text-right text-red-500">${(b.total_expenses || 0).toLocaleString()}</TableCell>
                  <TableCell className="text-sm font-mono text-right">${(b.cam_total || 0).toLocaleString()}</TableCell>
                  <TableCell className="text-sm font-mono text-right font-bold">${(b.noi || 0).toLocaleString()}</TableCell>
                  <TableCell><Badge className={`${statusColors[b.status]} text-[10px] uppercase`}>{b.status?.replace('_', ' ')}</Badge></TableCell>
                </TableRow>
              )) : (
                <TableRow><TableCell colSpan={8} className="text-center py-8 text-sm text-slate-400">No budgets created yet</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}