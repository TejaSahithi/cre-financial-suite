import React, { useState } from "react";
import { CAMCalculationService } from "@/services/api";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import useOrgQuery from "@/hooks/useOrgQuery";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Calculator, Loader2, CheckCircle2, ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import PageHeader from "@/components/PageHeader";
import ScopeSelector from "@/components/ScopeSelector";
import CalculationReferenceGuide from "@/components/cam/CalculationReferenceGuide";

export default function CAMCalculation() {
  const queryClient = useQueryClient();
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [fiscalYear, setFiscalYear] = useState(new Date().getFullYear());
  const [allocMethod, setAllocMethod] = useState("pro_rata");
  const [adminFeePct, setAdminFeePct] = useState(10);
  const [grossUpEnabled, setGrossUpEnabled] = useState(false);
  const [grossUpOcc, setGrossUpOcc] = useState(95);
  const [camCapPct, setCamCapPct] = useState(5);
  const [calculating, setCalculating] = useState(false);
  const [results, setResults] = useState(null);
  const [cpiSource, setCpiSource] = useState("CPI-U");
  const [cpiValue, setCpiValue] = useState("");

  const { data: properties = [], orgId } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: leases = [] } = useOrgQuery("Lease");
  const { data: expenses = [] } = useOrgQuery("Expense");
  const { data: camCalcs = [] } = useOrgQuery("CAMCalculation");

  const saveMutation = useMutation({
    mutationFn: (data) => CAMCalculationService.create(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cam-calcs'] }),
  });

  // Scoped data
  const scopedLeases = leases.filter(l => {
    if (scopeProperty !== "all" && l.property_id !== scopeProperty) return false;
    return l.status !== "expired";
  });

  const scopedExpenses = expenses.filter(e => {
    if (scopeProperty !== "all" && e.property_id !== scopeProperty) return false;
    return e.fiscal_year === fiscalYear && e.classification === "recoverable";
  });

  const scopedUnits = units.filter(u => {
    if (scopeProperty !== "all" && u.property_id !== scopeProperty) return false;
    return true;
  });

  // Separate pool vs direct expenses
  const poolExpenses = scopedExpenses.filter(e => e.allocation_type !== 'direct');
  const directExpenses = scopedExpenses.filter(e => e.allocation_type === 'direct');

  const totalRecoverable = poolExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  const totalDirectExpenses = directExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  const controllableTotal = poolExpenses.filter(e => e.is_controllable !== false).reduce((s, e) => s + (e.amount || 0), 0);
  const nonControllableTotal = totalRecoverable - controllableTotal;
  // Exclude under_construction units from CAM-eligible SF
  const camEligibleUnits = scopedUnits.filter(u => u.occupancy_status !== 'under_construction');
  const totalBuildingSF = camEligibleUnits.reduce((s, u) => s + (u.square_feet || 0), 0);
  const occupiedSF = camEligibleUnits.filter(u => u.occupancy_status === "leased").reduce((s, u) => s + (u.square_feet || 0), 0);
  const occupancyPct = totalBuildingSF > 0 ? (occupiedSF / totalBuildingSF * 100) : 0;

  // Previous year CAMs for cap check
  const prevYearCAMs = camCalcs.filter(c => c.fiscal_year === fiscalYear - 1);

  const runCalculation = () => {
    setCalculating(true);

    // Gross-up the pool if enabled
    let camPool = totalRecoverable;
    let grossUpAdj = 0;
    if (grossUpEnabled && occupancyPct < grossUpOcc) {
      const factor = grossUpOcc / Math.max(occupancyPct, 1);
      grossUpAdj = controllableTotal * (factor - 1);
      camPool = nonControllableTotal + (controllableTotal * factor);
    }

    // Calculate per tenant with management fee variability
    const tenantResults = scopedLeases.map(lease => {
      const leaseSF = lease.total_sf || camEligibleUnits.find(u => u.lease_id === lease.id)?.square_feet || 0;
      let sharePct = 0;
      if (allocMethod === "pro_rata" && totalBuildingSF > 0) {
        sharePct = (leaseSF / totalBuildingSF) * 100;
      } else if (allocMethod === "equal" && scopedLeases.length > 0) {
        sharePct = 100 / scopedLeases.length;
      }

      // Management fee — varies by lease config
      const mgmtBasis = lease.management_fee_basis || "cam_pool";
      const mgmtPct = lease.management_fee_pct || adminFeePct;
      let mgmtFeeForTenant = 0;
      if (mgmtBasis === "tenant_annual_rent") {
        mgmtFeeForTenant = (lease.annual_rent || 0) * (mgmtPct / 100);
      } else {
        mgmtFeeForTenant = camPool * (sharePct / 100) * (mgmtPct / 100);
      }

      let annualCAM = camPool * (sharePct / 100) + mgmtFeeForTenant;

      // Direct expense allocation
      const tenantDirectExpenses = directExpenses.filter(e =>
        (e.direct_tenant_ids || []).includes(lease.id)
      );
      const directExpenseTotal = tenantDirectExpenses.reduce((s, e) => s + (e.amount || 0), 0);
      annualCAM += directExpenseTotal;

      // Base year / stop deduction
      let baseYearDeduction = 0;
      if (lease.base_year_cam && lease.base_year_cam > 0) {
        baseYearDeduction = lease.base_year_cam * (sharePct / 100);
        annualCAM = Math.max(0, annualCAM - baseYearDeduction);
      }

      // CPI-based cap check
      let capApplied = false;
      let capAmount = null;
      let cpiIncreasePct = null;
      const prevCAM = prevYearCAMs.find(c => c.lease_id === lease.id);
      if (prevCAM && lease.cam_cap_type === 'cpi' && cpiValue) {
        const baseCpi = lease.cpi_base_value || prevCAM.cpi_index_value || 100;
        const currentCpi = parseFloat(cpiValue) || baseCpi;
        cpiIncreasePct = ((currentCpi - baseCpi) / baseCpi) * 100;
        const maxCAM = prevCAM.annual_cam * (1 + cpiIncreasePct / 100);
        if (annualCAM > maxCAM) { capAmount = maxCAM; annualCAM = maxCAM; capApplied = true; }
      } else if (prevCAM && camCapPct > 0) {
        const maxCAM = prevCAM.annual_cam * (1 + camCapPct / 100);
        if (annualCAM > maxCAM) { capAmount = maxCAM; annualCAM = maxCAM; capApplied = true; }
      }

      // HVAC landlord limit check
      let hvacLandlordExp = 0;
      let hvacTenantExcess = 0;
      if (lease.hvac_landlord_limit && lease.hvac_landlord_limit > 0) {
        const hvacExpenses = poolExpenses.filter(e => e.category === 'hvac_maintenance');
        const totalHvac = hvacExpenses.reduce((s, e) => s + (e.amount || 0), 0) * (sharePct / 100);
        if (totalHvac > lease.hvac_landlord_limit) {
          hvacLandlordExp = lease.hvac_landlord_limit;
          hvacTenantExcess = totalHvac - lease.hvac_landlord_limit;
        } else {
          hvacLandlordExp = totalHvac;
        }
      }

      // Proration — Partial Year CAM = Annual CAM × (Months Occupied / 12)
      let prorationMonths = 12;
      if (lease.start_date) {
        const start = new Date(lease.start_date);
        if (start.getFullYear() === fiscalYear) { prorationMonths = 12 - start.getMonth(); }
      }
      if (lease.end_date) {
        const end = new Date(lease.end_date);
        if (end.getFullYear() === fiscalYear) { prorationMonths = Math.min(prorationMonths, end.getMonth() + 1); }
      }

      const proratedCAM = annualCAM * (prorationMonths / 12);
      const monthlyCAM = prorationMonths > 0 ? proratedCAM / prorationMonths : 0;

      return {
        lease_id: lease.id,
        tenant_name: lease.tenant_name,
        property_id: lease.property_id,
        lease_type: lease.lease_type,
        square_feet: leaseSF,
        tenant_share_pct: parseFloat(sharePct.toFixed(2)),
        total_cam_pool: camPool + mgmtFeeForTenant,
        admin_fee: mgmtFeeForTenant,
        management_fee_amount: mgmtFeeForTenant,
        management_fee_basis: mgmtBasis,
        gross_up_adjustment: grossUpAdj * (sharePct / 100),
        base_year_deduction: baseYearDeduction,
        annual_cam: parseFloat(proratedCAM.toFixed(2)),
        monthly_cam: parseFloat(monthlyCAM.toFixed(2)),
        cap_applied: capApplied,
        cap_amount: capAmount,
        proration_months: prorationMonths,
        controllable_total: controllableTotal * (sharePct / 100),
        non_controllable_total: nonControllableTotal * (sharePct / 100),
        direct_expense_total: directExpenseTotal,
        cpi_index_source: cpiSource,
        cpi_index_value: cpiValue ? parseFloat(cpiValue) : null,
        cpi_increase_pct: cpiIncreasePct,
        hvac_landlord_expense: hvacLandlordExp,
        hvac_tenant_excess: hvacTenantExcess,
        allocation_model: allocMethod,
        fiscal_year: fiscalYear,
        org_id: orgId || "",
      };
    });

    const totalAdminFee = tenantResults.reduce((s, t) => s + (t.admin_fee || 0), 0);

    setResults({
      tenants: tenantResults,
      summary: { camPool, grossUpAdj, adminFee: totalAdminFee, totalPool: camPool + totalAdminFee, totalBuildingSF, occupiedSF, occupancyPct, totalDirectExpenses: tenantResults.reduce((s, t) => s + (t.direct_expense_total || 0), 0) }
    });
    setCalculating(false);
  };

  const saveAllResults = async () => {
    if (!results) return;
    for (const t of results.tenants) {
      await saveMutation.mutateAsync(t);
    }
  };

  const currentYear = new Date().getFullYear();

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader icon={Calculator} title="CAM Calculation" subtitle="Run tenant-level CAM allocations based on recoverable expenses and lease terms" iconColor="from-teal-500 to-cyan-600">
        <Link to={createPageUrl("CAMDashboard")}>
          <Button variant="outline" size="sm"><ArrowLeft className="w-4 h-4 mr-1" />CAM Dashboard</Button>
        </Link>
      </PageHeader>

      <ScopeSelector properties={properties} buildings={buildings} units={units} selectedProperty={scopeProperty} selectedBuilding={scopeBuilding} onPropertyChange={(v) => { setScopeProperty(v); setResults(null); }} onBuildingChange={setScopeBuilding} showUnit={false} />

      {/* Configuration */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Calculation Parameters</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Fiscal Year</Label>
                <Select value={String(fiscalYear)} onValueChange={v => { setFiscalYear(parseInt(v)); setResults(null); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[currentYear - 1, currentYear, currentYear + 1].map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Allocation Method</Label>
                <Select value={allocMethod} onValueChange={v => { setAllocMethod(v); setResults(null); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pro_rata">Pro-Rata (SqFt)</SelectItem>
                    <SelectItem value="equal">Equal Distribution</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">Default Admin Fee %</Label>
                <Input type="number" value={adminFeePct} onChange={e => { setAdminFeePct(parseFloat(e.target.value) || 0); setResults(null); }} className="h-8" />
              </div>
              <div>
                <Label className="text-xs">CAM Cap % (Fixed)</Label>
                <Input type="number" value={camCapPct} onChange={e => { setCamCapPct(parseFloat(e.target.value) || 0); setResults(null); }} className="h-8" />
              </div>
              <div>
                <Label className="text-xs flex items-center gap-2">
                  <input type="checkbox" checked={grossUpEnabled} onChange={e => { setGrossUpEnabled(e.target.checked); setResults(null); }} className="rounded" />
                  Gross-Up to
                </Label>
                <div className="flex items-center gap-1">
                  <Input type="number" value={grossUpOcc} onChange={e => { setGrossUpOcc(parseFloat(e.target.value) || 95); setResults(null); }} className="h-8" disabled={!grossUpEnabled} />
                  <span className="text-xs text-slate-400">%</span>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-2">
              <div>
                <Label className="text-xs">CPI Index Source</Label>
                <Select value={cpiSource} onValueChange={v => { setCpiSource(v); setResults(null); }}>
                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CPI-U">CPI-U (All Urban Consumers)</SelectItem>
                    <SelectItem value="CPI-W">CPI-W (Wage Earners)</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Current CPI Value (for CPI caps)</Label>
                <Input type="number" step="0.1" value={cpiValue} onChange={e => { setCpiValue(e.target.value); setResults(null); }} className="h-8" placeholder="e.g. 314.2" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Input Summary</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Recoverable Expenses</p>
                <p className="text-lg font-bold">${totalRecoverable.toLocaleString()}</p>
                <p className="text-[10px] text-slate-400">{scopedExpenses.length} line items</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Active Leases</p>
                <p className="text-lg font-bold">{scopedLeases.length}</p>
                <p className="text-[10px] text-slate-400">{scopedLeases.length} tenants</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Total / Occupied SF</p>
                <p className="text-lg font-bold">{totalBuildingSF.toLocaleString()}</p>
                <p className="text-[10px] text-slate-400">{occupiedSF.toLocaleString()} occupied ({occupancyPct.toFixed(0)}%)</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Controllable / Non</p>
                <p className="text-sm font-bold">${controllableTotal.toLocaleString()}</p>
                <p className="text-[10px] text-slate-400">${nonControllableTotal.toLocaleString()} non-ctrl</p>
              </div>
            </div>
            {totalDirectExpenses > 0 && (
              <div className="bg-amber-50 rounded-lg p-3 mt-3 border border-amber-200">
                <p className="text-[9px] text-amber-600 uppercase font-bold">Direct Tenant Expenses</p>
                <p className="text-sm font-bold text-amber-700">${totalDirectExpenses.toLocaleString()}</p>
                <p className="text-[10px] text-amber-500">{directExpenses.length} items allocated to specific tenants</p>
              </div>
            )}

            <Button onClick={runCalculation} disabled={calculating || scopedLeases.length === 0 || totalRecoverable === 0} className="w-full mt-4 bg-teal-600 hover:bg-teal-700 h-11 text-sm font-semibold">
              {calculating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Calculator className="w-4 h-4 mr-2" />}
              Calculate CAM for {scopedLeases.length} Tenants
            </Button>
            {scopedLeases.length === 0 && <p className="text-[10px] text-amber-600 mt-1 text-center">Select a property with active leases to run calculation</p>}
            {totalRecoverable === 0 && scopedLeases.length > 0 && <p className="text-[10px] text-amber-600 mt-1 text-center">No recoverable expenses found for FY {fiscalYear}</p>}
          </CardContent>
        </Card>
      </div>

      {/* Results */}
      {results && (
        <div className="space-y-4">
          {/* Pool Summary */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Card className="border-l-4 border-l-teal-500">
              <CardContent className="p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Total CAM Pool</p>
                <p className="text-xl font-bold">${results.summary.totalPool.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Base Expenses</p>
                <p className="text-xl font-bold">${results.summary.camPool.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Admin Fee</p>
                <p className="text-xl font-bold text-indigo-600">${results.summary.adminFee.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Gross-Up Adj.</p>
                <p className="text-xl font-bold text-amber-600">${results.summary.grossUpAdj.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Caps Applied</p>
                <p className="text-xl font-bold text-amber-600">{results.tenants.filter(t => t.cap_applied).length}</p>
                <p className="text-[10px] text-slate-400">of {results.tenants.length}</p>
              </CardContent>
            </Card>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card>
              <CardContent className="p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Direct Expenses</p>
                <p className="text-lg font-bold text-orange-600">${(results.summary.totalDirectExpenses || 0).toLocaleString()}</p>
                <p className="text-[10px] text-slate-400">Tenant-specific allocation</p>
              </CardContent>
            </Card>
            {cpiValue && (
              <Card>
                <CardContent className="p-3">
                  <p className="text-[9px] text-slate-400 uppercase font-bold">CPI Reference</p>
                  <p className="text-lg font-bold">{cpiSource}: {cpiValue}</p>
                  <p className="text-[10px] text-slate-400">Stored for audit trail</p>
                </CardContent>
              </Card>
            )}
            <Card>
              <CardContent className="p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">HVAC Excess Charges</p>
                <p className="text-lg font-bold text-red-600">${results.tenants.reduce((s, t) => s + (t.hvac_tenant_excess || 0), 0).toLocaleString()}</p>
                <p className="text-[10px] text-slate-400">{results.tenants.filter(t => (t.hvac_tenant_excess || 0) > 0).length} tenants over limit</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Mgmt Fee (Rent-Based)</p>
                <p className="text-lg font-bold text-indigo-600">{results.tenants.filter(t => t.management_fee_basis === 'tenant_annual_rent').length}</p>
                <p className="text-[10px] text-slate-400">tenants with % rent basis</p>
              </CardContent>
            </Card>
          </div>

          {/* Tenant Results Table */}
          <Card className="overflow-hidden">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">Tenant CAM Allocations — FY {fiscalYear}</CardTitle>
              <Button size="sm" onClick={saveAllResults} disabled={saveMutation.isPending} className="bg-emerald-600 hover:bg-emerald-700">
                {saveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1" />}
                Save All Results
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50">
                    <TableHead className="text-[10px] font-bold">TENANT</TableHead>
                    <TableHead className="text-[10px] font-bold">LEASE TYPE</TableHead>
                    <TableHead className="text-[10px] font-bold text-right">SQ FT</TableHead>
                    <TableHead className="text-[10px] font-bold text-right">SHARE %</TableHead>
                    <TableHead className="text-[10px] font-bold text-right">ANNUAL CAM</TableHead>
                    <TableHead className="text-[10px] font-bold text-right">MONTHLY</TableHead>
                    <TableHead className="text-[10px] font-bold text-center">MONTHS</TableHead>
                    <TableHead className="text-[10px] font-bold">FLAGS</TableHead>
                    </TableRow>
                    </TableHeader>
                    <TableBody>
                    {results.tenants.map(t => (
                    <TableRow key={t.lease_id} className="hover:bg-slate-50">
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg bg-teal-100 flex items-center justify-center text-teal-700 font-bold text-[10px]">{t.tenant_name?.charAt(0)}</div>
                          <span className="text-xs font-semibold">{t.tenant_name}</span>
                        </div>
                      </TableCell>
                      <TableCell><Badge variant="outline" className="text-[8px] uppercase">{t.lease_type || '—'}</Badge></TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{t.square_feet?.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{t.tenant_share_pct}%</TableCell>
                      <TableCell className="text-right text-xs font-mono font-bold tabular-nums">${t.annual_cam.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-xs font-mono tabular-nums">${t.monthly_cam.toLocaleString()}/mo</TableCell>
                      <TableCell className="text-center text-xs">{t.proration_months}</TableCell>
                      <TableCell>
                        <div className="flex gap-1 flex-wrap">
                          {t.cap_applied && <Badge className="bg-amber-100 text-amber-700 text-[7px]">{t.cpi_increase_pct ? 'CPI CAP' : 'CAPPED'}</Badge>}
                          {t.base_year_deduction > 0 && <Badge className="bg-blue-100 text-blue-700 text-[7px]">BASE YR</Badge>}
                          {t.proration_months < 12 && <Badge className="bg-purple-100 text-purple-700 text-[7px]">PRORATED</Badge>}
                          {(t.direct_expense_total || 0) > 0 && <Badge className="bg-orange-100 text-orange-700 text-[7px]">DIRECT ${t.direct_expense_total.toLocaleString()}</Badge>}
                          {(t.hvac_tenant_excess || 0) > 0 && <Badge className="bg-red-100 text-red-700 text-[7px]">HVAC +${t.hvac_tenant_excess.toLocaleString()}</Badge>}
                          {t.management_fee_basis === 'tenant_annual_rent' && <Badge className="bg-indigo-100 text-indigo-700 text-[7px]">MGMT %RENT</Badge>}
                        </div>
                      </TableCell>
                    </TableRow>
                    ))}
                  {/* Totals */}
                  <TableRow className="bg-slate-100 font-bold border-t-2">
                    <TableCell className="text-xs" colSpan={2}>TOTAL ({results.tenants.length} tenants)</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{results.tenants.reduce((s, t) => s + (t.square_feet || 0), 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{results.tenants.reduce((s, t) => s + t.tenant_share_pct, 0).toFixed(1)}%</TableCell>
                    <TableCell className="text-right text-xs font-mono tabular-nums">${results.tenants.reduce((s, t) => s + t.annual_cam, 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right text-xs font-mono tabular-nums">${results.tenants.reduce((s, t) => s + t.monthly_cam, 0).toLocaleString()}/mo</TableCell>
                    <TableCell colSpan={2}></TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
      {/* Reference Guide */}
      <CalculationReferenceGuide />
    </div>
  );
}