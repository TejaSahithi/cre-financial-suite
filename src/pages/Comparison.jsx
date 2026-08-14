import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { PropertyService, LeaseService, ExpenseService, BudgetService, PortfolioService, BuildingService, UnitService } from "@/services/api";

import { useQuery } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ScopeSelector from "@/components/ScopeSelector";
import ComparisonTable from "@/components/comparison/ComparisonTable";
import ComparisonChart from "@/components/comparison/ComparisonChart";
import ComparisonSummary from "@/components/comparison/ComparisonSummary";
import { buildHierarchyScope, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { supabase } from "@/services/supabaseClient";

export default function Comparison() {
  const location = useLocation();
  const currentYear = new Date().getFullYear();
  const [yearA, setYearA] = useState(currentYear - 1);
  const [yearB, setYearB] = useState(currentYear);
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");

  const { data: leases = [] } = useQuery({ queryKey: ['leases'], queryFn: () => LeaseService.list() });
  const { data: expenses = [] } = useQuery({ queryKey: ['expenses'], queryFn: () => ExpenseService.list() });
  const { data: budgets = [] } = useQuery({ queryKey: ['budgets'], queryFn: () => BudgetService.list() });
  const { data: camCalcs = [] } = useQuery({
    queryKey: ["cam-comparison-runs"],
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_runs").select("*, cam_run_lease_results(*)");
      if (error) return [];
      return data ?? [];
    },
  });
  const { data: properties = [] } = useQuery({ queryKey: ['properties'], queryFn: () => PropertyService.list() });
  const { data: portfolios = [] } = useQuery({ queryKey: ['portfolios'], queryFn: () => PortfolioService.list() });
  const { data: buildings = [] } = useQuery({ queryKey: ['buildings'], queryFn: () => BuildingService.list() });
  const { data: units = [] } = useQuery({ queryKey: ['units'], queryFn: () => UnitService.list() });

  const scope = useMemo(
    () => buildHierarchyScope({ search: location.search, portfolios, properties, buildings, units }),
    [location.search, portfolios, properties, buildings, units],
  );

  useEffect(() => {
    setScopeProperty(scope.propertyId || "all");
    setScopeBuilding(scope.buildingId || "all");
    setScopeUnit(scope.unitId || "all");
  }, [scope.propertyId, scope.buildingId, scope.unitId]);

  const scopedLeases = leases.filter((lease) => matchesHierarchyScope(lease, scope));
  const scopedExpenses = expenses.filter((expense) => matchesHierarchyScope(expense, scope));
  const scopedBudgets = budgets.filter((budget) => matchesHierarchyScope(budget, scope));
  const scopedCamCalcs = camCalcs.filter((calc) => {
    const scopeRecord = {
      ...calc,
      property_id: calc.property_id || (calc.scope_type === "property" ? calc.scope_id : null),
      building_id: calc.building_id || (calc.scope_type === "building" ? calc.scope_id : null),
      unit_id: calc.unit_id || (calc.scope_type === "unit" ? calc.scope_id : null),
    };
    return matchesHierarchyScope(scopeRecord, scope);
  });

  // Aggregate by year
  const expA = scopedExpenses.filter(e => e.fiscal_year === yearA);
  const expB = scopedExpenses.filter(e => e.fiscal_year === yearB);
  const budA = scopedBudgets.filter(b => b.budget_year === yearA);
  const budB = scopedBudgets.filter(b => b.budget_year === yearB);
  const camA = scopedCamCalcs.filter(c => c.fiscal_year === yearA);
  const camB = scopedCamCalcs.filter(c => c.fiscal_year === yearB);

  const totalExpA = expA.reduce((s, e) => s + (e.amount || 0), 0);
  const totalExpB = expB.reduce((s, e) => s + (e.amount || 0), 0);
  const revenueA = budA.reduce((s, b) => s + (b.total_revenue || 0), 0) || scopedLeases.reduce((s, l) => s + (l.annual_rent || 0), 0) * 0.95;
  const revenueB = budB.reduce((s, b) => s + (b.total_revenue || 0), 0) || scopedLeases.reduce((s, l) => s + (l.annual_rent || 0), 0);
  const camPoolA = camA.reduce((s, c) => s + (c.annual_cam || 0), 0);
  const camPoolB = camB.reduce((s, c) => s + (c.annual_cam || 0), 0);
  const noiA = revenueA - totalExpA;
  const noiB = revenueB - totalExpB;

  // Expense by category comparison
  const buildCatMap = (exps) => {
    const map = {};
    exps.forEach(e => { map[e.category || 'other'] = (map[e.category || 'other'] || 0) + (e.amount || 0); });
    return map;
  };
  const catMapA = buildCatMap(expA);
  const catMapB = buildCatMap(expB);
  const allCats = [...new Set([...Object.keys(catMapA), ...Object.keys(catMapB)])];
  const categoryRows = allCats.map(cat => ({
    label: cat.replace(/_/g, ' '),
    yearA: catMapA[cat] || 0,
    yearB: catMapB[cat] || 0,
  })).sort((a, b) => b.yearB - a.yearB);

  // Tenant revenue comparison
  const tenantRevenueA = {};
  const tenantRevenueB = {};
  scopedLeases.forEach(l => {
    if (!l.tenant_name) return;
    const rent = l.annual_rent || (l.base_rent || 0) * 12;
    // Approximate by assuming all leases are current year; for prior year reduce slightly
    tenantRevenueB[l.tenant_name] = (tenantRevenueB[l.tenant_name] || 0) + rent;
    tenantRevenueA[l.tenant_name] = (tenantRevenueA[l.tenant_name] || 0) + rent * 0.95;
  });
  const allTenants = [...new Set([...Object.keys(tenantRevenueA), ...Object.keys(tenantRevenueB)])];
  const tenantRows = allTenants.map(t => ({
    label: t,
    yearA: tenantRevenueA[t] || 0,
    yearB: tenantRevenueB[t] || 0,
  })).sort((a, b) => b.yearB - a.yearB);

  // Summary rows
  const summaryRows = [
    { label: "Total Revenue", yearA: revenueA, yearB: revenueB },
    { label: "Total Expenses", yearA: totalExpA, yearB: totalExpB },
    { label: "NOI", yearA: noiA, yearB: noiB },
    { label: "CAM Pool", yearA: camPoolA, yearB: camPoolB },
    { label: "Budget Total", yearA: budA.reduce((s, b) => s + (b.total_expenses || 0), 0), yearB: budB.reduce((s, b) => s + (b.total_expenses || 0), 0) },
  ];

  const years = [currentYear - 3, currentYear - 2, currentYear - 1, currentYear, currentYear + 1];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-[28px] font-bold text-slate-900">Year-over-Year Comparison</h1>
          <p className="text-sm text-slate-500">Split-screen financial comparison across all entities</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Select value={String(yearA)} onValueChange={v => setYearA(Number(v))}>
              <SelectTrigger className="w-[100px] h-9 bg-blue-50 border-blue-200"><SelectValue /></SelectTrigger>
              <SelectContent>{years.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
            </Select>
            <span className="text-sm text-slate-400 font-medium">vs</span>
            <Select value={String(yearB)} onValueChange={v => setYearB(Number(v))}>
              <SelectTrigger className="w-[100px] h-9 bg-emerald-50 border-emerald-200"><SelectValue /></SelectTrigger>
              <SelectContent>{years.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <ScopeSelector
        portfolios={scope.orgScopedPortfolios}
        properties={properties}
        buildings={buildings}
        units={units}
        selectedPortfolio={scope.portfolioId || "all"}
        selectedProperty={scopeProperty}
        selectedBuilding={scopeBuilding}
        selectedUnit={scopeUnit}
        onPropertyChange={setScopeProperty}
        onBuildingChange={(value) => {
          setScopeBuilding(value);
          setScopeUnit("all");
        }}
        onUnitChange={setScopeUnit}
        syncToUrl
      />

      <ComparisonSummary rows={summaryRows} yearA={yearA} yearB={yearB} />

      <Tabs defaultValue="summary">
        <TabsList className="bg-white border">
          <TabsTrigger value="summary">Financial Summary</TabsTrigger>
          <TabsTrigger value="expenses">Expense Categories</TabsTrigger>
          <TabsTrigger value="tenants">Tenant Revenue</TabsTrigger>
          <TabsTrigger value="chart">Visual Comparison</TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="mt-4">
          <ComparisonTable rows={summaryRows} yearA={yearA} yearB={yearB} />
        </TabsContent>

        <TabsContent value="expenses" className="mt-4">
          <ComparisonTable rows={categoryRows} yearA={yearA} yearB={yearB} title="Expense Category Comparison" />
        </TabsContent>

        <TabsContent value="tenants" className="mt-4">
          <ComparisonTable rows={tenantRows} yearA={yearA} yearB={yearB} title="Tenant Revenue Comparison" />
        </TabsContent>

        <TabsContent value="chart" className="mt-4">
          <div className="grid lg:grid-cols-2 gap-6">
            <ComparisonChart
              title="Financial Summary"
              data={summaryRows}
              yearA={yearA}
              yearB={yearB}
            />
            <ComparisonChart
              title="Top Expense Categories"
              data={categoryRows.slice(0, 8)}
              yearA={yearA}
              yearB={yearB}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
