import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Plus, Download, Mail, Loader2, CheckCircle2, X } from "lucide-react";

import useOrgQuery from "@/hooks/useOrgQuery";
import { buildHierarchyScope, getScopeSubtitle, matchesHierarchyScope } from "@/lib/hierarchyScope";
import ScopeSelector from "@/components/ScopeSelector";
import PageHeader from "@/components/PageHeader";
import PipelineActions, { BUDGET_ACTIONS } from "@/components/PipelineActions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { createPageUrl, downloadCSV } from "@/utils";

export default function BudgetDashboard() {
  const location = useLocation();
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");
  const [selectedBudgetId, setSelectedBudgetId] = useState(null);

  const { data: budgets = [], isLoading } = useOrgQuery("Budget");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");

  const scope = useMemo(
    () =>
      buildHierarchyScope({
        search: location.search,
        portfolios,
        properties,
        buildings,
        units,
      }),
    [location.search, portfolios, properties, buildings, units]
  );

  useEffect(() => {
    setScopeProperty(scope.propertyId || "all");
    setScopeBuilding(scope.buildingId || "all");
    setScopeUnit(scope.unitId || "all");
  }, [scope.propertyId, scope.buildingId, scope.unitId]);

  const statusColors = {
    draft: "bg-slate-100 text-slate-600",
    ai_generated: "bg-blue-100 text-blue-700",
    under_review: "bg-red-100 text-red-700",
    reviewed: "bg-amber-100 text-amber-700",
    approved: "bg-emerald-100 text-emerald-700",
    signed: "bg-green-100 text-green-700",
    locked: "bg-slate-800 text-white",
  };

  const scopedBudgets = budgets.filter((budget) =>
    matchesHierarchyScope(budget, scope, {
      portfolioKey: "portfolio_id",
      propertyKey: "property_id",
      buildingKey: "building_id",
      unitKey: "unit_id",
    })
  );

  const visibleBudgets = scopedBudgets.filter((budget) => {
    if (scopeProperty !== "all" && budget.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all" && budget.building_id !== scopeBuilding) return false;
    if (scopeUnit !== "all" && budget.unit_id !== scopeUnit) return false;
    return true;
  });

  useEffect(() => {
    if (!visibleBudgets.length) {
      setSelectedBudgetId(null);
      return;
    }
    if (!selectedBudgetId || !visibleBudgets.some((budget) => budget.id === selectedBudgetId)) {
      setSelectedBudgetId(visibleBudgets[0].id);
    }
  }, [visibleBudgets, selectedBudgetId]);

  const selectedBudget = visibleBudgets.find((budget) => budget.id === selectedBudgetId) || visibleBudgets[0] || null;
  const selectedPropertyId = scopeProperty !== "all" ? scopeProperty : scope.propertyId || selectedBudget?.property_id || null;

  const subtitleScope = getScopeSubtitle(scope, {
    default: `${visibleBudgets.length} budgets across the active scope`,
    portfolio: (portfolio) => `${visibleBudgets.length} budgets in ${portfolio.name}`,
    property: (property) => `${visibleBudgets.length} budgets for ${property.name}`,
    building: (building) => `${visibleBudgets.length} budgets for ${building.name}`,
    unit: (unit) => `${visibleBudgets.length} budgets for ${unit.unit_number || unit.unit_id_code || "selected unit"}`,
    org: () => `${visibleBudgets.length} budgets in selected organization`,
  });

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Budget Dashboard" subtitle={subtitleScope}>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCSV(visibleBudgets, "budgets.csv")}>
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
          <Link to={createPageUrl("CreateBudget") + location.search}>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" />
              Create Budget
            </Button>
          </Link>
        </div>
      </PageHeader>

      {selectedPropertyId ? (
        <PipelineActions propertyId={selectedPropertyId} fiscalYear={new Date().getFullYear()} actions={BUDGET_ACTIONS} />
      ) : (
        <div className="text-xs text-slate-500">Select a property scope to run budget compute/export actions.</div>
      )}

      <ScopeSelector
        properties={scope.scopedProperties}
        buildings={scope.scopedBuildings}
        units={scope.scopedUnits}
        selectedProperty={scopeProperty}
        selectedBuilding={scopeBuilding}
        selectedUnit={scopeUnit}
        onPropertyChange={setScopeProperty}
        onBuildingChange={setScopeBuilding}
        onUnitChange={setScopeUnit}
      />

      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      ) : visibleBudgets.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-slate-400">
            <p>No budgets created yet for this scope</p>
            <Link to={createPageUrl("CreateBudget") + location.search}>
              <Button className="mt-4">Create First Budget</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="space-y-3">
            {visibleBudgets.map((budget) => {
              const property = budget.property_id ? scope.propertyById.get(budget.property_id) ?? null : null;
              const building = budget.building_id ? scope.buildingById.get(budget.building_id) ?? null : null;
              const unit = budget.unit_id ? scope.unitById.get(budget.unit_id) ?? null : null;

              return (
                <Card
                  key={budget.id}
                  className={`cursor-pointer hover:shadow-md transition-shadow border-l-4 ${selectedBudget?.id === budget.id ? "border-l-blue-700" : "border-l-blue-500"}`}
                  onClick={() => setSelectedBudgetId(budget.id)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-sm font-bold text-slate-900">{budget.name}</p>
                        <p className="text-xs text-slate-400">
                          {(budget.budget_year || budget.fiscal_year) ?? "—"} · {budget.generation_method?.replace("_", " ") || "manual"}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-1">
                          {unit?.unit_number || unit?.unit_id_code || building?.name || property?.name || "Org scope"}
                        </p>
                      </div>
                      <Badge className={`${statusColors[budget.status] || "bg-slate-100 text-slate-600"} text-[10px] uppercase`}>
                        {budget.status?.replace("_", " ")}
                      </Badge>
                    </div>
                    <div className="flex gap-6 mt-3 text-xs text-slate-500">
                      <span className="text-emerald-600 font-medium">${((budget.total_revenue || 0) / 1000).toFixed(0)}K Revenue</span>
                      <span className="text-red-500 font-medium">${((budget.total_expenses || 0) / 1000).toFixed(0)}K Expenses</span>
                      <span className="font-bold text-slate-900">${((budget.noi || 0) / 1000).toFixed(0)}K NOI</span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {selectedBudget && (
            <div className="lg:col-span-2">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-base">{selectedBudget.name}</CardTitle>
                    <p className="text-xs text-slate-400">
                      {(selectedBudget.budget_year || selectedBudget.fiscal_year) ?? "—"} · {selectedBudget.generation_method?.replace("_", " ") || "manual"}
                    </p>
                  </div>
                  <Badge className={`${statusColors[selectedBudget.status] || "bg-slate-100 text-slate-600"} uppercase text-[10px]`}>
                    {selectedBudget.status?.replace("_", " ")}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid grid-cols-4 gap-4">
                    <div className="p-4 bg-slate-50 rounded-xl">
                      <p className="text-xs text-slate-500">Total Revenue</p>
                      <p className="text-xl font-bold text-slate-900">${(selectedBudget.total_revenue || 0).toLocaleString()}</p>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl">
                      <p className="text-xs text-slate-500">Total Expenses</p>
                      <p className="text-xl font-bold text-red-600">${(selectedBudget.total_expenses || 0).toLocaleString()}</p>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl">
                      <p className="text-xs text-slate-500">CAM Total</p>
                      <p className="text-xl font-bold text-blue-600">${(selectedBudget.cam_total || 0).toLocaleString()}</p>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl">
                      <p className="text-xs text-slate-500">NOI</p>
                      <p className="text-xl font-bold text-emerald-600">${(selectedBudget.noi || 0).toLocaleString()}</p>
                    </div>
                  </div>

                  {selectedBudget.ai_insights && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                      <p className="text-xs font-semibold text-amber-700 mb-1">AI Insights</p>
                      <p className="text-sm text-amber-800">{selectedBudget.ai_insights}</p>
                    </div>
                  )}

                  <div className="flex gap-3">
                    <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700">
                      <CheckCircle2 className="w-4 h-4 mr-2" />
                      Approve Budget
                    </Button>
                    <Button variant="outline" className="text-red-500 border-red-200 hover:bg-red-50">
                      <X className="w-4 h-4 mr-2" />
                      Reject
                    </Button>
                  </div>
                  <div className="flex gap-3">
                    <Button variant="outline" className="flex-1">
                      <Download className="w-4 h-4 mr-2" />
                      Download Excel/CSV
                    </Button>
                    <Button variant="outline" className="flex-1">
                      <Mail className="w-4 h-4 mr-2" />
                      Email to Stakeholders
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
