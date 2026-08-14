import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAssistantPageContext } from "@/assistant/useAssistantContext";
import { budgetService } from "@/services/budgetService";
import { expenseService } from "@/services/expenseService";
import { leaseService } from "@/services/leaseService";
import { useQuery } from "@tanstack/react-query";
import useOrgQuery from "@/hooks/useOrgQuery";
import ScopeSelector from "@/components/ScopeSelector";
import { buildHierarchyScope, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Layers, Target } from "lucide-react";
import ActualsTab from "@/components/financials/ActualsTab";
import VarianceTab from "@/components/financials/VarianceTab";

export default function ActualsVariance() {
  const location = useLocation();
  const [activeTab, setActiveTab] = useState("actuals");
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");
  const fiscalYear = new Date().getFullYear();
  useAssistantPageContext({ page: "ActualsVariance", route: location.pathname + location.search, fiscalYear, uiState: { selectedTab: activeTab } });
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: expenses = [] } = useQuery({ queryKey: ['expenses'], queryFn: () => expenseService.list() });
  const { data: leases = [] } = useQuery({ queryKey: ['leases'], queryFn: () => leaseService.list() });
  const { data: budgets = [] } = useQuery({ queryKey: ['budgets'], queryFn: () => budgetService.list() });

  const scope = useMemo(
    () => buildHierarchyScope({ search: location.search, portfolios, properties, buildings, units }),
    [location.search, portfolios, properties, buildings, units],
  );

  useEffect(() => {
    setScopeProperty(scope.propertyId || "all");
    setScopeBuilding(scope.buildingId || "all");
    setScopeUnit(scope.unitId || "all");
  }, [scope.propertyId, scope.buildingId, scope.unitId]);

  const scopedExpenses = expenses.filter((expense) => matchesHierarchyScope(expense, scope));
  const scopedLeases = leases.filter((lease) => matchesHierarchyScope(lease, scope));
  const scopedBudgets = budgets.filter((budget) => matchesHierarchyScope(budget, scope));

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div>
        <h1 className="text-[28px] font-bold text-slate-900">Actuals & Variance</h1>
        <p className="text-sm text-slate-500">Actual financial performance and budget variance analysis</p>
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

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="actuals" className="gap-1.5"><Layers className="w-3.5 h-3.5" />Actuals</TabsTrigger>
          <TabsTrigger value="variance" className="gap-1.5"><Target className="w-3.5 h-3.5" />Variance</TabsTrigger>
        </TabsList>

        <TabsContent value="actuals">
          <ActualsTab expenses={scopedExpenses} leases={scopedLeases} />
        </TabsContent>
        <TabsContent value="variance">
          <VarianceTab expenses={scopedExpenses} budgets={scopedBudgets} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
