import React, { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Calculator, AlertTriangle, RefreshCw, Sliders } from "lucide-react";

import { toast } from "sonner";
import { supabase } from "@/lib/supabaseClient";

import useOrgQuery from "@/hooks/useOrgQuery";
import { useSnapshotQuery } from "@/hooks/useSnapshotQuery";
import { useComputeTrigger } from "@/hooks/useComputeTrigger";
import { fetchPropertyCamConfig } from "@/services/camConfig";
import { expenseService } from "@/services/expenseService";
import { getCamScopeContext } from "@/lib/camScope";
import { createPageUrl } from "@/utils";

import PageHeader from "@/components/PageHeader";
import ScopeSelector from "@/components/ScopeSelector";
import CalculationReferenceGuide from "@/components/cam/CalculationReferenceGuide";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function toOverrideDraft(values) {
  const vacancyHandling = String(values?.vacancy_handling || "");
  const propertyDenominator = String(values?.property_pool_denominator_mode || "");
  const buildingDenominator = String(values?.building_pool_denominator_mode || "");
  const excludeVacant =
    vacancyHandling.includes("occupied") ||
    propertyDenominator.includes("occupied") ||
    buildingDenominator.includes("occupied");

  return {
    allocation_method: values?.allocation_method ?? "pro_rata_total_sqft",
    admin_fee_pct: Number(values?.admin_fee_pct ?? 0),
    management_fee_pct: Number(values?.management_fee_pct ?? 0),
    management_fee_basis: values?.management_fee_basis ?? "shared_pool",
    gross_up_enabled: Boolean(values?.gross_up_enabled),
    gross_up_target_occupancy_pct: Number(values?.gross_up_target_occupancy_pct ?? 95),
    gross_up_apply_to: values?.gross_up_apply_to ?? "controllable",
    cam_cap_rate: Number(values?.cam_cap_rate ?? 0),
    exclude_vacant: excludeVacant,
  };
}

function buildOverrides(draft) {
  const excludeVacant = Boolean(draft.exclude_vacant);
  return {
    allocation_method: draft.allocation_method,
    admin_fee_pct: Number(draft.admin_fee_pct ?? 0),
    management_fee_pct: Number(draft.management_fee_pct ?? 0),
    management_fee_basis: draft.management_fee_basis ?? "shared_pool",
    gross_up_enabled: Boolean(draft.gross_up_enabled),
    gross_up_target_occupancy_pct: Number(draft.gross_up_target_occupancy_pct ?? 95),
    gross_up_apply_to: draft.gross_up_apply_to ?? "controllable",
    cam_cap_rate: Number(draft.cam_cap_rate ?? 0),
    vacancy_handling: excludeVacant ? "occupied_tenants" : "include_vacant",
    property_pool_denominator_mode: excludeVacant ? "occupied_sqft" : "property_total_sqft",
    building_pool_denominator_mode: excludeVacant ? "occupied_sqft" : "building_total_sqft",
  };
}

export default function CAMCalculation() {
  const queryClient = useQueryClient();
  const currentYear = new Date().getFullYear();

  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");
  const [fiscalYear, setFiscalYear] = useState(currentYear);
  const [overrideDraft, setOverrideDraft] = useState(() => toOverrideDraft({}));
  const [searchParams] = useSearchParams();

  // Pre-fill from URL params when navigated from Custom CAM Rules tab
  useEffect(() => {
    const pid = searchParams.get("property_id");
    const yr = searchParams.get("year");
    if (pid) setScopeProperty(pid);
    if (yr) setFiscalYear(Number(yr));
  }, []);

  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: leases = [] } = useOrgQuery("Lease");
  const { data: expenses = [] } = useOrgQuery("Expense");
  const { trigger, isTriggering } = useComputeTrigger();

  const scope = useMemo(
    () =>
      getCamScopeContext({
        properties,
        buildings,
        units,
        leases,
        expenses,
        scopeProperty,
        scopeBuilding,
        scopeUnit,
        fiscalYear,
      }),
    [properties, buildings, units, leases, expenses, scopeProperty, scopeBuilding, scopeUnit, fiscalYear],
  );

  const { data: configData } = useQuery({
    queryKey: ["property-cam-config", scope.targetPropertyId ?? "none"],
    queryFn: () => fetchPropertyCamConfig(scope.targetPropertyId),
    enabled: !!scope.targetPropertyId,
  });

  const { data: workflowSummary } = useQuery({
    queryKey: ["cam-workflow-summary", scope.targetPropertyId, scope.targetScopeId, fiscalYear],
    queryFn: () => expenseService.getWorkflowSummary({
      propertyId: scope.targetPropertyId,
      buildingId: scope.targetScopeLevel === "building" ? scope.targetScopeId : null,
      unitId: scope.targetScopeLevel === "unit" ? scope.targetScopeId : null,
      fiscalYear,
    }),
    enabled: !!scope.targetPropertyId,
  });

  useEffect(() => {
    if (configData?.values) {
      setOverrideDraft(toOverrideDraft(configData.values));
    }
  }, [configData]);

  const { data: customRules = [] } = useQuery({
    queryKey: ["lease-config-ids", scope.targetPropertyId],
    queryFn: async () => {
      if (!scope.targetPropertyId) return [];
      const leaseIdsInProperty = leases.filter(l => l.property_id === scope.targetPropertyId).map(l => l.id);
      if (!leaseIdsInProperty.length) return [];
      
      const { data } = await supabase
        .from("lease_config")
        .select("lease_id")
        .in("lease_id", leaseIdsInProperty);
      return data?.map(d => d.lease_id) || [];
    },
    enabled: !!scope.targetPropertyId,
  });

  const {
    outputs,
    computedAt,
    refetch: refetchSnapshot,
    hasSnapshot,
  } = useSnapshotQuery({
    engineType: "cam",
    propertyId: scope.targetPropertyId,
    fiscalYear,
    scopeLevel: scope.targetScopeLevel,
    scopeId: scope.targetScopeId,
  });

  const recoverableTotal = scope.recoverableExpenses.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const controllableTotal = scope.recoverableExpenses
    .filter((item) => item.is_controllable !== false)
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const nonControllableTotal = recoverableTotal - controllableTotal;
  const occupancyPct = scope.totalSqft > 0 ? (scope.occupiedSqft / scope.totalSqft) * 100 : 0;

  const validationIssues = [
    !scope.targetPropertyId ? "property_id is required" : null,
    scope.totalSqft <= 0 ? "Total scope square footage must be greater than 0" : null,
    workflowSummary?.approvedLeaseCount === 0 && scope.activeLeases.length > 0 ? "No approved or budget-ready leases found for this scope" : null,
    workflowSummary?.approvedRuleLeaseCount === 0 && scope.activeLeases.length > 0 ? "Lease expense/CAM rules must be approved before CAM calculation" : null,
    workflowSummary?.actualExpenseCount === 0 ? "No actual expenses found. Upload expenses, import GL, import invoices, or add manual expenses before CAM calculation." : null,
    workflowSummary?.needsReviewCount > 0 ? `${workflowSummary.needsReviewCount} expense(s) still need review before CAM can run` : null,
    workflowSummary?.missingSquareFootageCount > 0 ? `${workflowSummary.missingSquareFootageCount} lease(s) are missing square footage` : null,
    workflowSummary?.missingLeaseDatesCount > 0 ? `${workflowSummary.missingLeaseDatesCount} lease(s) are missing start/end dates` : null,
    workflowSummary?.missingCategoryCount > 0 ? `${workflowSummary.missingCategoryCount} expense(s) are missing categories` : null,
    workflowSummary?.conditionalExpenseCount > 0 ? `${workflowSummary.conditionalExpenseCount} conditional expense(s) require manual review` : null,
  ].filter(Boolean);

  const leaseNotice =
    scope.activeLeases.length === 0
      ? "No active leases overlap the selected fiscal year, so CAM allocation will be skipped."
      : null;

  const refreshAfterCompute = async () => {
    await queryClient.invalidateQueries({ queryKey: ["snapshot", "cam"] });
    await queryClient.invalidateQueries({ queryKey: ["CAMCalculation"] });
    await refetchSnapshot();
  };

  const handleCalculate = async () => {
    if (validationIssues.length > 0) {
      toast.error(validationIssues[0]);
      return;
    }

    const overrideValues = buildOverrides(overrideDraft);
    const payload = {
      property_id: scope.targetPropertyId,
      fiscal_year: fiscalYear,
      scope_level: scope.targetScopeLevel ?? "property",
      scope_id: scope.targetScopeId ?? scope.targetPropertyId,
      ...overrideValues,
      override_values: overrideValues,
    };

    try {
      await trigger("compute-cam", payload, {
        successMessage: `CAM calculated for ${scope.targetScopeLabel ?? "selected scope"}`,
      });
      await refreshAfterCompute();
    } catch {
      /* toast handled by hook */
    }
  };

  const tenantCharges = outputs?.tenant_charges ?? [];
  const assumptions = outputs?.assumptions ?? [];

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader
        icon={Calculator}
        title="CAM Calculation"
        subtitle="Validate actual inputs, send overrides to compute-cam, and render the latest backend snapshot"
        iconColor="from-teal-500 to-cyan-600"
      >
        <div className="flex items-center gap-2">
          <Link to={`${createPageUrl("CAMDashboard")}?property_id=${scope.targetPropertyId}&year=${fiscalYear}`}>
            <Button variant="outline" size="sm" className="border-teal-200 text-teal-700 hover:bg-teal-50">
              <Sliders className="w-4 h-4 mr-2" />
              Manage Custom Rules
            </Button>
          </Link>
          <Link to={createPageUrl("CAMDashboard")}>
            <Button variant="outline" size="sm">
              <ArrowLeft className="w-4 h-4 mr-1" />
              CAM Dashboard
            </Button>
          </Link>
        </div>
      </PageHeader>

      <ScopeSelector
        properties={properties}
        buildings={buildings}
        units={units}
        selectedProperty={scopeProperty}
        selectedBuilding={scopeBuilding}
        selectedUnit={scopeUnit}
        onPropertyChange={(value) => {
          setScopeProperty(value);
          setScopeBuilding("all");
          setScopeUnit("all");
        }}
        onBuildingChange={(value) => {
          setScopeBuilding(value);
          setScopeUnit("all");
        }}
        onUnitChange={setScopeUnit}
        showUnit
      />

      {!scope.targetPropertyId ? (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Select a property before triggering CAM calculation.
        </div>
      ) : (
        <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          Calculation scope: <span className="font-semibold capitalize">{scope.targetScopeLevel}</span> {"→"}{" "}
          <span className="font-semibold">{scope.targetScopeLabel}</span>
          {computedAt ? <span className="ml-2 text-slate-400">Latest snapshot: {new Date(computedAt).toLocaleString()}</span> : null}
        </div>
      )}

      {validationIssues.length > 0 ? (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-3 text-sm text-red-700 space-y-1">
          {validationIssues.map((issue) => (
            <div key={issue}>{issue}</div>
          ))}
        </div>
      ) : null}

      <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-3 text-sm text-blue-800">
        Lease is the source of truth for tenant obligations, reimbursement terms, caps, base years, and CAM rule logic.
        Approved expense rows are the source of truth for the actual expense pool used in CAM. Budget generation then uses lease revenue inputs plus approved expense and CAM snapshot outputs.
      </div>

      {leaseNotice ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-3 text-sm text-amber-700">
          {leaseNotice}
        </div>
      ) : null}

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Compute Payload Overrides</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Fiscal Year</Label>
                <Select value={String(fiscalYear)} onValueChange={(value) => setFiscalYear(Number(value))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[currentYear - 1, currentYear, currentYear + 1].map((year) => (
                      <SelectItem key={year} value={String(year)}>{year}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-xs">Allocation Method</Label>
                <Select
                  value={overrideDraft.allocation_method}
                  onValueChange={(value) => setOverrideDraft((current) => ({ ...current, allocation_method: value }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pro_rata_total_sqft">Pro-Rata by Total SqFt</SelectItem>
                    <SelectItem value="pro_rata_occupied_sqft">Pro-Rata by Occupied SqFt</SelectItem>
                    <SelectItem value="equal_split">Equal Split</SelectItem>
                    <SelectItem value="weighted_allocation">Weighted Allocation</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <Label className="text-xs">Admin Fee %</Label>
                <Input
                  type="number"
                  value={overrideDraft.admin_fee_pct}
                  onChange={(event) => setOverrideDraft((current) => ({ ...current, admin_fee_pct: event.target.value }))}
                />
              </div>
              <div>
                <Label className="text-xs">Mgmt Fee %</Label>
                <Input
                  type="number"
                  value={overrideDraft.management_fee_pct}
                  onChange={(event) => setOverrideDraft((current) => ({ ...current, management_fee_pct: event.target.value }))}
                />
              </div>
              <div>
                <Label className="text-xs">Gross-Up Target %</Label>
                <Input
                  type="number"
                  disabled={!overrideDraft.gross_up_enabled}
                  value={overrideDraft.gross_up_target_occupancy_pct}
                  onChange={(event) => setOverrideDraft((current) => ({ ...current, gross_up_target_occupancy_pct: event.target.value }))}
                />
              </div>
              <div>
                <Label className="text-xs">CAM Cap %</Label>
                <Input
                  type="number"
                  value={overrideDraft.cam_cap_rate}
                  onChange={(event) => setOverrideDraft((current) => ({ ...current, cam_cap_rate: event.target.value }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Management Fee Basis</Label>
                <Select
                  value={overrideDraft.management_fee_basis}
                  onValueChange={(value) => setOverrideDraft((current) => ({ ...current, management_fee_basis: value }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="shared_pool">Shared Pool</SelectItem>
                    <SelectItem value="shared_pool_plus_management">Shared Pool + Management</SelectItem>
                    <SelectItem value="controllable_only">Controllable Only</SelectItem>
                    <SelectItem value="tenant_annual_rent">Tenant Annual Rent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Gross-Up Applies To</Label>
                <Select
                  value={overrideDraft.gross_up_apply_to}
                  onValueChange={(value) => setOverrideDraft((current) => ({ ...current, gross_up_apply_to: value }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="controllable">Controllable</SelectItem>
                    <SelectItem value="all">All Recoverable</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center justify-between border rounded-xl px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-900">Enable Gross-Up</p>
                  <p className="text-xs text-slate-500">Override for this compute run</p>
                </div>
                <input
                  type="checkbox"
                  checked={overrideDraft.gross_up_enabled}
                  onChange={(event) => setOverrideDraft((current) => ({ ...current, gross_up_enabled: event.target.checked }))}
                />
              </div>
              <div className="flex items-center justify-between border rounded-xl px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-900">Exclude Vacant</p>
                  <p className="text-xs text-slate-500">Use occupied SqFt denominator</p>
                </div>
                <input
                  type="checkbox"
                  checked={overrideDraft.exclude_vacant}
                  onChange={(event) => setOverrideDraft((current) => ({ ...current, exclude_vacant: event.target.checked }))}
                />
              </div>
            </div>

            <Button
              onClick={handleCalculate}
              disabled={!scope.targetPropertyId || isTriggering || workflowSummary?.canRunCam === false}
              className="w-full bg-teal-600 hover:bg-teal-700 h-11 text-sm font-semibold"
            >
              {isTriggering ? <RefreshCw className="w-4 h-4 animate-spin mr-2" /> : <Calculator className="w-4 h-4 mr-2" />}
              {isTriggering ? "Calculating..." : "Calculate CAM"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Validated Input Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Recoverable Expenses</p>
                <p className="text-lg font-bold">${recoverableTotal.toLocaleString()}</p>
                <p className="text-[10px] text-slate-400">{scope.recoverableExpenses.length} line items</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Active Leases</p>
                <div className="flex items-center justify-between">
                  <p className="text-lg font-bold">{scope.activeLeases.length}</p>
                  {customRules.length > 0 && (
                    <Badge variant="outline" className="bg-teal-50 text-teal-700 text-[9px] border-teal-200 uppercase px-1.5 py-0">
                      {customRules.length} Custom Rules
                    </Badge>
                  )}
                </div>
                <p className="text-[10px] text-slate-400">Eligible for allocation</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Total / Occupied SqFt</p>
                <p className="text-lg font-bold">{Math.round(scope.totalSqft).toLocaleString()}</p>
                <p className="text-[10px] text-slate-400">{Math.round(scope.occupiedSqft).toLocaleString()} occupied ({occupancyPct.toFixed(1)}%)</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-[9px] text-slate-400 uppercase font-bold">Controllable / Non</p>
                <p className="text-sm font-bold">${controllableTotal.toLocaleString()}</p>
                <p className="text-[10px] text-slate-400">${nonControllableTotal.toLocaleString()} non-ctrl</p>
              </div>
            </div>

            <div className="text-xs text-slate-500 space-y-1">
              <div>Payload property_id: <span className="font-semibold text-slate-900">{scope.targetPropertyId || "—"}</span></div>
              <div>Payload scope_level: <span className="font-semibold text-slate-900">{scope.targetScopeLevel || "—"}</span></div>
              <div>Payload scope_id: <span className="font-semibold text-slate-900">{scope.targetScopeId || "—"}</span></div>
              <div>Payload allocation_method: <span className="font-semibold text-slate-900">{overrideDraft.allocation_method}</span></div>
            </div>
          </CardContent>
        </Card>
      </div>

      {hasSnapshot ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card><CardContent className="p-3"><p className="text-[9px] text-slate-400 uppercase font-bold">Total CAM</p><p className="text-xl font-bold">${Number(outputs?.total_cam ?? 0).toLocaleString()}</p></CardContent></Card>
            <Card><CardContent className="p-3"><p className="text-[9px] text-slate-400 uppercase font-bold">CAM / SqFt</p><p className="text-xl font-bold">${Number(outputs?.cam_per_sf ?? 0).toLocaleString()}</p></CardContent></Card>
            <Card><CardContent className="p-3"><p className="text-[9px] text-slate-400 uppercase font-bold">Billed to Tenants</p><p className="text-xl font-bold">${Number(outputs?.total_billed ?? 0).toLocaleString()}</p></CardContent></Card>
            <Card><CardContent className="p-3"><p className="text-[9px] text-slate-400 uppercase font-bold">Direct Allocations</p><p className="text-xl font-bold">${Number(outputs?.direct_allocations ?? 0).toLocaleString()}</p></CardContent></Card>
          </div>

          {assumptions.length > 0 ? (
            <Card className="border-amber-200 bg-amber-50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  Calculation Assumptions
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm text-amber-800">
                {assumptions.map((item) => <div key={item}>{item}</div>)}
              </CardContent>
            </Card>
          ) : null}

          <Card className="overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Tenant CAM Results</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50">
                    <TableHead className="text-[10px] font-bold">TENANT</TableHead>
                    <TableHead className="text-[10px] font-bold text-right">ANNUAL CAM</TableHead>
                    <TableHead className="text-[10px] font-bold text-right">MONTHLY CAM</TableHead>
                    <TableHead className="text-[10px] font-bold text-right">RAW SHARE</TableHead>
                    <TableHead className="text-[10px] font-bold text-right">BASE YEAR</TableHead>
                    <TableHead className="text-[10px] font-bold text-right">CAP ADJ.</TableHead>
                    <TableHead className="text-[10px] font-bold">FLAGS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tenantCharges.map((tenant) => (
                    <TableRow key={tenant.lease_id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg bg-teal-100 flex items-center justify-center text-teal-700 font-bold text-[10px]">
                            {tenant.tenant_name?.charAt(0) || "T"}
                          </div>
                          <div>
                            <p className="text-xs font-semibold">{tenant.tenant_name}</p>
                            <p className="text-[10px] text-slate-400">{tenant.unit_id || tenant.building_id || tenant.property_id}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-xs font-mono">${Number(tenant.annual_cam || 0).toLocaleString()}</TableCell>
                      <TableCell className="text-right text-xs font-mono">${Number(tenant.monthly_cam || 0).toLocaleString()}</TableCell>
                      <TableCell className="text-right text-xs font-mono">${Number(tenant.raw_share_before_caps || 0).toLocaleString()}</TableCell>
                      <TableCell className="text-right text-xs font-mono">${Number(tenant.base_year_adjustment || 0).toLocaleString()}</TableCell>
                      <TableCell className="text-right text-xs font-mono">${Number(tenant.cap_adjustment || 0).toLocaleString()}</TableCell>
                      <TableCell>
                        <div className="flex gap-1 flex-wrap">
                          {customRules.includes(tenant.lease_id) ? (
                            <Badge className="bg-teal-100 text-teal-700 text-[9px] border-teal-200">RULES ACTIVE</Badge>
                          ) : null}
                          {tenant.gross_up_applied ? <Badge className="bg-blue-100 text-blue-700 text-[9px]">GROSS-UP</Badge> : null}
                          {tenant.cap_applied ? <Badge className="bg-amber-100 text-amber-700 text-[9px]">CAPPED</Badge> : null}
                          {Number(tenant.base_year_adjustment || 0) > 0 ? <Badge className="bg-slate-100 text-slate-700 text-[9px]">BASE YEAR</Badge> : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <CalculationReferenceGuide />
    </div>
  );
}
