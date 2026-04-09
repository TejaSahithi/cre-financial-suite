import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Calculator, ArrowRight, Save, SlidersHorizontal, TrendingUp, Building2 } from "lucide-react";
import { toast } from "sonner";

import useOrgQuery from "@/hooks/useOrgQuery";
import { useSnapshotQuery } from "@/hooks/useSnapshotQuery";
import { fetchPropertyCamConfig, savePropertyCamConfig } from "@/services/camConfig";
import { getCamScopeContext } from "@/lib/camScope";
import { createPageUrl } from "@/utils";

import PageHeader from "@/components/PageHeader";
import ScopeSelector from "@/components/ScopeSelector";
import MetricCard from "@/components/MetricCard";
import CAMReviewTab from "@/components/cam/CAMReviewTab";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function toDraft(values) {
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

function toPersistedValues(draft) {
  const excludeVacant = Boolean(draft.exclude_vacant);
  return {
    cam_calculation_method: "pro_rata",
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

export default function CAMDashboard() {
  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;
  const queryClient = useQueryClient();

  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");
  const [draft, setDraft] = useState(() => toDraft({}));

  const { data: camCalcs = [] } = useOrgQuery("CAMCalculation");
  const { data: leaseList = [] } = useOrgQuery("Lease");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: expenses = [] } = useOrgQuery("Expense");

  const scope = useMemo(
    () =>
      getCamScopeContext({
        properties,
        buildings,
        units,
        leases: leaseList,
        expenses,
        scopeProperty,
        scopeBuilding,
        scopeUnit,
        fiscalYear: currentYear,
      }),
    [properties, buildings, units, leaseList, expenses, scopeProperty, scopeBuilding, scopeUnit, currentYear],
  );

  const {
    data: configData,
    isLoading: configLoading,
  } = useQuery({
    queryKey: ["property-cam-config", scope.targetPropertyId ?? "none"],
    queryFn: () => fetchPropertyCamConfig(scope.targetPropertyId),
    enabled: !!scope.targetPropertyId,
  });

  useEffect(() => {
    if (configData?.values) {
      setDraft(toDraft(configData.values));
    } else if (!scope.targetPropertyId) {
      setDraft(toDraft({}));
    }
  }, [configData, scope.targetPropertyId]);

  const {
    outputs,
    computedAt,
    refetch: refetchSnapshot,
  } = useSnapshotQuery({
    engineType: "cam",
    propertyId: scope.targetPropertyId,
    fiscalYear: currentYear,
    scopeLevel: scope.targetScopeLevel,
    scopeId: scope.targetScopeId,
  });

  const saveConfigMutation = useMutation({
    mutationFn: async () => savePropertyCamConfig(scope.targetPropertyId, toPersistedValues(draft)),
    onSuccess: async () => {
      toast.success("CAM configuration saved");
      await queryClient.invalidateQueries({ queryKey: ["property-cam-config", scope.targetPropertyId] });
      await refetchSnapshot();
    },
    onError: (error) => {
      toast.error(`Failed to save CAM config: ${error?.message || "Unexpected error"}`);
    },
  });

  const recoverableTotal = scope.recoverableExpenses.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const controllableTotal = scope.recoverableExpenses
    .filter((item) => item.is_controllable !== false)
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const nonControllableTotal = recoverableTotal - controllableTotal;
  const occupancyPct = scope.totalSqft > 0 ? (scope.occupiedSqft / scope.totalSqft) * 100 : 0;

  const snapshotOutputs = outputs ?? {};
  const currentTotal = Number(snapshotOutputs.total_cam ?? 0);
  const prevTotal = Number(snapshotOutputs.prev_year_total ?? 0);
  const budgetedCam = Number(snapshotOutputs.budgeted_cam ?? 0);
  const billedTotal = Number(snapshotOutputs.total_billed ?? 0);

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader
        icon={Calculator}
        title="CAM Engine"
        subtitle="Save CAM rules at the property level and review backend-generated CAM snapshots"
        iconColor="from-teal-500 to-cyan-600"
      >
        <div className="flex items-center gap-2">
          <Link to={createPageUrl("CreateBudget")}>
            <Button variant="outline" size="sm">
              Budget Studio <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          </Link>
          <Link to={createPageUrl("CAMCalculation")}>
            <Button size="sm" className="bg-teal-600 hover:bg-teal-700">
              Open CAM Calculation
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
          Select a property to load CAM configuration and review the latest backend snapshot.
        </div>
      ) : (
        <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          Current scope: <span className="font-semibold capitalize">{scope.targetScopeLevel}</span> {"→"}{" "}
          <span className="font-semibold">{scope.targetScopeLabel}</span>
          {computedAt ? <span className="ml-2 text-slate-400">Latest snapshot: {new Date(computedAt).toLocaleString()}</span> : null}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard
          label={`CAM Pool (${currentYear})`}
          value={`$${currentTotal.toLocaleString()}`}
          icon={Calculator}
          color="bg-teal-50 text-teal-600"
          trend={prevTotal > 0 ? parseFloat((((currentTotal - prevTotal) / prevTotal) * 100).toFixed(1)) : undefined}
        />
        <MetricCard
          label={`Prior Year (${prevYear})`}
          value={`$${prevTotal.toLocaleString()}`}
          icon={TrendingUp}
          color="bg-slate-100 text-slate-500"
          sub="Historical baseline"
        />
        <MetricCard
          label="Budgeted CAM"
          value={`$${budgetedCam.toLocaleString()}`}
          icon={Building2}
          color="bg-blue-50 text-blue-600"
          sub={`FY ${currentYear}`}
        />
        <MetricCard
          label="Tenant CAM Billed"
          value={`$${billedTotal.toLocaleString()}`}
          icon={SlidersHorizontal}
          color="bg-amber-50 text-amber-600"
          sub="From latest snapshot"
        />
      </div>

      <Tabs defaultValue="config">
        <TabsList className="bg-white border">
          <TabsTrigger value="config">Config</TabsTrigger>
          <TabsTrigger value="summary">Input Summary</TabsTrigger>
          <TabsTrigger value="review">Review</TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base">Property CAM Configuration</CardTitle>
                <p className="text-xs text-slate-500 mt-1">
                  These values persist to <code>property_config</code> and are consumed by <code>compute-cam</code>.
                </p>
              </div>
              <Button
                onClick={() => saveConfigMutation.mutate()}
                disabled={!scope.targetPropertyId || saveConfigMutation.isPending || configLoading}
                className="bg-blue-600 hover:bg-blue-700"
              >
                <Save className="w-4 h-4 mr-2" />
                {saveConfigMutation.isPending ? "Saving..." : "Save Config"}
              </Button>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label className="text-xs">Allocation Method</Label>
                  <Select
                    value={draft.allocation_method}
                    onValueChange={(value) => setDraft((current) => ({ ...current, allocation_method: value }))}
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

                <div className="space-y-2">
                  <Label className="text-xs">Admin Fee %</Label>
                  <Input
                    type="number"
                    value={draft.admin_fee_pct}
                    onChange={(event) => setDraft((current) => ({ ...current, admin_fee_pct: event.target.value }))}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-xs">Management Fee %</Label>
                  <Input
                    type="number"
                    value={draft.management_fee_pct}
                    onChange={(event) => setDraft((current) => ({ ...current, management_fee_pct: event.target.value }))}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-xs">Management Fee Basis</Label>
                  <Select
                    value={draft.management_fee_basis}
                    onValueChange={(value) => setDraft((current) => ({ ...current, management_fee_basis: value }))}
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
              </div>

              <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label className="text-xs">CAM Cap %</Label>
                  <Input
                    type="number"
                    value={draft.cam_cap_rate}
                    onChange={(event) => setDraft((current) => ({ ...current, cam_cap_rate: event.target.value }))}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-xs">Gross-Up Target Occupancy %</Label>
                  <Input
                    type="number"
                    value={draft.gross_up_target_occupancy_pct}
                    disabled={!draft.gross_up_enabled}
                    onChange={(event) => setDraft((current) => ({ ...current, gross_up_target_occupancy_pct: event.target.value }))}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-xs">Gross-Up Applies To</Label>
                  <Select
                    value={draft.gross_up_apply_to}
                    onValueChange={(value) => setDraft((current) => ({ ...current, gross_up_apply_to: value }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="controllable">Controllable Expenses</SelectItem>
                      <SelectItem value="all">All Recoverable Expenses</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs">Rule Summary</Label>
                  <div className="text-xs text-slate-600 border rounded-md px-3 py-2 bg-slate-50">
                    {draft.exclude_vacant ? "Occupied SqFt denominator" : "Total SqFt denominator"}
                  </div>
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="flex items-center justify-between border rounded-xl px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-900">Enable Gross-Up</p>
                    <p className="text-xs text-slate-500">Used by the backend calculator only</p>
                  </div>
                  <Switch
                    checked={draft.gross_up_enabled}
                    onCheckedChange={(checked) => setDraft((current) => ({ ...current, gross_up_enabled: checked }))}
                  />
                </div>

                <div className="flex items-center justify-between border rounded-xl px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-900">Exclude Vacant from Denominator</p>
                    <p className="text-xs text-slate-500">Switches total SqFt allocation to occupied SqFt</p>
                  </div>
                  <Switch
                    checked={draft.exclude_vacant}
                    onCheckedChange={(checked) => setDraft((current) => ({ ...current, exclude_vacant: checked }))}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="summary" className="mt-4">
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Recoverable Expenses</CardTitle></CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">${recoverableTotal.toLocaleString()}</p>
                <p className="text-xs text-slate-500">{scope.recoverableExpenses.length} recoverable lines in FY {currentYear}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Active Leases</CardTitle></CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{scope.activeLeases.length}</p>
                <p className="text-xs text-slate-500">Eligible leases in current scope</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Total / Occupied SqFt</CardTitle></CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{Math.round(scope.totalSqft).toLocaleString()}</p>
                <p className="text-xs text-slate-500">{Math.round(scope.occupiedSqft).toLocaleString()} occupied ({occupancyPct.toFixed(1)}%)</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Controllable / Non-Controllable</CardTitle></CardHeader>
              <CardContent>
                <p className="text-lg font-bold">${controllableTotal.toLocaleString()}</p>
                <p className="text-xs text-slate-500">${nonControllableTotal.toLocaleString()} non-controllable</p>
              </CardContent>
            </Card>
          </div>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="text-base">Backend Input Checklist</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-slate-600">
              <div>Property selected: <span className="font-semibold text-slate-900">{scope.targetPropertyId ? "Yes" : "No"}</span></div>
              <div>Recoverable expenses present: <span className="font-semibold text-slate-900">{scope.recoverableExpenses.length}</span></div>
              <div>Active leases present: <span className="font-semibold text-slate-900">{scope.activeLeases.length}</span></div>
              <div>Total scope SqFt: <span className="font-semibold text-slate-900">{Math.round(scope.totalSqft).toLocaleString()}</span></div>
              <div className="pt-2 text-xs text-slate-500">
                No calculations are performed on this page. Use the CAM Calculation page to send these inputs to <code>compute-cam</code>.
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="review" className="mt-4">
          <CAMReviewTab
            camCalcs={camCalcs}
            expenses={expenses}
            leases={leaseList}
            currentYear={currentYear}
            prevYear={prevYear}
            scopeProperty={scopeProperty}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
