import React from "react";
import { BudgetService, CAMCalculationService, LeaseService } from "@/services/api";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Calculator, TrendingUp, TrendingDown } from "lucide-react";

export default function PropertyCAMTab({ propertyId }) {
  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;

  const { data: camCalcs = [] } = useQuery({
    queryKey: ['cam-prop', propertyId],
    queryFn: () => CAMCalculationService.filter({ property_id: propertyId }),
    enabled: !!propertyId,
  });

  const { data: leases = [] } = useQuery({
    queryKey: ['leases-cam-prop', propertyId],
    queryFn: () => LeaseService.filter({ property_id: propertyId }),
    enabled: !!propertyId,
  });

  const { data: budgets = [] } = useQuery({
    queryKey: ['budgets-cam-prop', propertyId],
    queryFn: () => BudgetService.filter({ property_id: propertyId }),
    enabled: !!propertyId,
  });

  const currentCAMs = camCalcs.filter(c => c.fiscal_year === currentYear);
  const prevCAMs = camCalcs.filter(c => c.fiscal_year === prevYear);
  const currentTotal = currentCAMs.reduce((s, c) => s + (c.annual_cam || 0), 0);
  const prevTotal = prevCAMs.reduce((s, c) => s + (c.annual_cam || 0), 0);
  const variance = prevTotal > 0 ? ((currentTotal - prevTotal) / prevTotal * 100).toFixed(1) : 0;

  const currentBudget = budgets.find(b => b.budget_year === currentYear);
  const budgetedCAM = currentBudget?.cam_total || 0;

  // Per-tenant breakdown
  const tenantData = leases.map(l => {
    const currentCAM = currentCAMs.find(c => c.lease_id === l.id);
    const prevCAM = prevCAMs.find(c => c.lease_id === l.id);
    return {
      tenant: l.tenant_name,
      leaseType: l.lease_type,
      sf: l.total_sf || 0,
      sharePct: currentCAM?.tenant_share_pct || 0,
      currentMonthly: currentCAM?.monthly_cam || l.cam_per_month || 0,
      prevMonthly: prevCAM?.monthly_cam || 0,
      currentAnnual: currentCAM?.annual_cam || 0,
      prevAnnual: prevCAM?.annual_cam || 0,
      capApplied: currentCAM?.cap_applied || false,
      leaseCAMRate: l.cam_per_month || 0,
    };
  });

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Total CAM Pool ({currentYear})</p>
            <p className="text-xl font-bold text-slate-900">${currentTotal.toLocaleString()}</p>
            <div className="flex items-center gap-1 mt-1">
              {parseFloat(variance) > 0 ? <TrendingUp className="w-3 h-3 text-red-500" /> : <TrendingDown className="w-3 h-3 text-emerald-500" />}
              <span className={`text-[10px] ${parseFloat(variance) > 0 ? 'text-red-500' : 'text-emerald-600'}`}>{variance}% vs {prevYear}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Prior Year CAM ({prevYear})</p>
            <p className="text-xl font-bold text-slate-500">${prevTotal.toLocaleString()}</p>
            <p className="text-[10px] text-slate-400">Historical baseline</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Budgeted CAM ({currentYear})</p>
            <p className="text-xl font-bold text-blue-600">${budgetedCAM.toLocaleString()}</p>
            <p className="text-[10px] text-slate-400">From approved budget</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Tenants Allocated</p>
            <p className="text-xl font-bold">{currentCAMs.length}</p>
            <p className="text-[10px] text-slate-400">of {leases.length} active leases</p>
          </CardContent>
        </Card>
      </div>

      {/* Per-tenant CAM table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Tenant CAM Allocation — Current vs Prior Year vs Lease Terms</CardTitle>
          <Link to={createPageUrl("CAMCalculation") + `?property=${propertyId}`}>
            <Button size="sm" className="bg-blue-600 hover:bg-blue-700"><Calculator className="w-3 h-3 mr-1" />Run Calculation</Button>
          </Link>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[11px]">TENANT</TableHead>
                <TableHead className="text-[11px]">LEASE TYPE</TableHead>
                <TableHead className="text-[11px] text-right">SF</TableHead>
                <TableHead className="text-[11px] text-right">SHARE %</TableHead>
                <TableHead className="text-[11px] text-right">MONTHLY ({currentYear})</TableHead>
                <TableHead className="text-[11px] text-right">MONTHLY ({prevYear})</TableHead>
                <TableHead className="text-[11px] text-right">LEASE CAM/MO</TableHead>
                <TableHead className="text-[11px] text-right">ANNUAL ({currentYear})</TableHead>
                <TableHead className="text-[11px]">CAP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenantData.length > 0 ? tenantData.map((t, i) => (
                <TableRow key={i}>
                  <TableCell className="text-sm font-medium">{t.tenant}</TableCell>
                  <TableCell><Badge variant="outline" className="text-[10px]">{t.leaseType}</Badge></TableCell>
                  <TableCell className="text-sm text-right font-mono">{t.sf.toLocaleString()}</TableCell>
                  <TableCell className="text-sm text-right font-mono">{t.sharePct.toFixed(1)}%</TableCell>
                  <TableCell className="text-sm text-right font-mono">${t.currentMonthly.toLocaleString()}</TableCell>
                  <TableCell className="text-sm text-right font-mono text-slate-400">${t.prevMonthly.toLocaleString()}</TableCell>
                  <TableCell className="text-sm text-right font-mono text-blue-600">${t.leaseCAMRate.toLocaleString()}</TableCell>
                  <TableCell className="text-sm text-right font-mono font-medium">${t.currentAnnual.toLocaleString()}</TableCell>
                  <TableCell>{t.capApplied ? <Badge className="bg-amber-100 text-amber-700 text-[10px]">CAPPED</Badge> : <span className="text-xs text-slate-300">—</span>}</TableCell>
                </TableRow>
              )) : (
                <TableRow><TableCell colSpan={9} className="text-center py-8 text-sm text-slate-400">No CAM calculations yet. Run a calculation to see tenant allocations.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}