import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Upload,
  Search,
  Loader2,
  Pencil,
  Trash2,
  BookOpen,
  Receipt,
  DollarSign,
  TrendingDown,
  Layers,
  Download,
} from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from "recharts";
import { toast } from "sonner";

import PipelineActions, { EXPENSE_ACTIONS } from "@/components/PipelineActions";
import ModuleLink from "@/components/ModuleLink";
import RoleGuard from "@/components/RoleGuard";
import AuditTrailPanel from "@/components/AuditTrailPanel";
import PageHeader from "@/components/PageHeader";
import MetricCard from "@/components/MetricCard";
import ScopeSelector from "@/components/ScopeSelector";
import VendorSpendAnalysis from "@/components/expenses/VendorSpendAnalysis";
import useOrgQuery from "@/hooks/useOrgQuery";
import { buildHierarchyScope, getScopeSubtitle, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { ExpenseService } from "@/services/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { createPageUrl, downloadCSV } from "@/utils";
import DeleteConfirmDialog from "@/components/DeleteConfirmDialog";

export default function Expenses() {
  const location = useLocation();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");
  const [selectedExpenseIds, setSelectedExpenseIds] = useState([]);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const queryClient = useQueryClient();

  const { data: expenses = [], isLoading } = useOrgQuery("Expense");
  const { data: budgets = [] } = useOrgQuery("Budget");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: allBuildings = [] } = useOrgQuery("Building");
  const { data: allUnits = [] } = useOrgQuery("Unit");
  const { data: vendors = [] } = useOrgQuery("Vendor");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");

  const scope = useMemo(
    () =>
      buildHierarchyScope({
        search: location.search,
        portfolios,
        properties,
        buildings: allBuildings,
        units: allUnits,
      }),
    [location.search, portfolios, properties, allBuildings, allUnits]
  );

  useEffect(() => {
    setScopeProperty(scope.propertyId || "all");
    setScopeBuilding(scope.buildingId || "all");
    setScopeUnit(scope.unitId || "all");
  }, [scope.propertyId, scope.buildingId, scope.unitId]);

  const getPropertyName = (propertyId) => scope.propertyById.get(propertyId)?.name || "—";

  const scopedExpenses = expenses.filter((expense) =>
    matchesHierarchyScope(expense, scope, {
      portfolioKey: "portfolio_id",
      propertyKey: "property_id",
      buildingKey: "building_id",
      unitKey: "unit_id",
    })
  );

  const selectorScopedExpenses = scopedExpenses.filter((expense) => {
    if (scopeProperty !== "all" && expense.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all" && expense.building_id !== scopeBuilding) return false;
    if (scopeUnit !== "all" && expense.unit_id !== scopeUnit) return false;
    return true;
  });

  const selectedPropertyId = scopeProperty !== "all" ? scopeProperty : scope.propertyId || null;

  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;
  const currentYearExpenses = selectorScopedExpenses.filter((expense) => expense.fiscal_year === currentYear);
  const prevYearExpenses = selectorScopedExpenses.filter((expense) => expense.fiscal_year === prevYear);
  const prevYearTotal = prevYearExpenses.reduce((sum, expense) => sum + (expense.amount || 0), 0);
  const currentBudget = budgets.find((budget) => {
    if ((budget.budget_year || budget.fiscal_year) !== currentYear) return false;
    return matchesHierarchyScope(budget, scope, {
      portfolioKey: "portfolio_id",
      propertyKey: "property_id",
      buildingKey: "building_id",
      unitKey: "unit_id",
    });
  });
  const budgetedTotal = currentBudget?.total_expenses || 0;

  const classColors = {
    recoverable: "bg-emerald-100 text-emerald-700",
    non_recoverable: "bg-red-100 text-red-700",
    conditional: "bg-amber-100 text-amber-700",
  };

  const totals = {
    all: selectorScopedExpenses.reduce((sum, expense) => sum + (expense.amount || 0), 0),
    recoverable: selectorScopedExpenses
      .filter((expense) => expense.classification === "recoverable")
      .reduce((sum, expense) => sum + (expense.amount || 0), 0),
    non_recoverable: selectorScopedExpenses
      .filter((expense) => expense.classification === "non_recoverable")
      .reduce((sum, expense) => sum + (expense.amount || 0), 0),
    conditional: selectorScopedExpenses
      .filter((expense) => expense.classification === "conditional")
      .reduce((sum, expense) => sum + (expense.amount || 0), 0),
  };

  const pieData = [
    { name: "Recoverable", value: totals.recoverable, color: "#10b981" },
    { name: "Non-Recoverable", value: totals.non_recoverable, color: "#ef4444" },
    { name: "Conditional", value: totals.conditional, color: "#f59e0b" },
  ].filter((entry) => entry.value > 0);

  const filtered = selectorScopedExpenses.filter((expense) => {
    const property = expense.property_id ? scope.propertyById.get(expense.property_id) ?? null : null;
    const building = expense.building_id ? scope.buildingById.get(expense.building_id) ?? null : null;
    const unit = expense.unit_id ? scope.unitById.get(expense.unit_id) ?? null : null;

    const matchSearch =
      !search ||
      [expense.category, expense.vendor, property?.name, building?.name, unit?.unit_number, expense.description]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search.toLowerCase()));
    const matchFilter = filter === "all" || expense.classification === filter;
    return matchSearch && matchFilter;
  });

  const subtitleScope = getScopeSubtitle(scope, {
    default: `${selectorScopedExpenses.length} expense records · Classification and recovery tracking`,
    portfolio: (portfolio) => `${selectorScopedExpenses.length} expense records in ${portfolio.name}`,
    property: (property) => `${selectorScopedExpenses.length} expense records for ${property.name}`,
    building: (building) => `${selectorScopedExpenses.length} expense records for ${building.name}`,
    unit: (unit) => `${selectorScopedExpenses.length} expense records for ${unit.unit_number || unit.unit_id_code || "selected unit"}`,
    org: () => `${selectorScopedExpenses.length} expense records in selected organization`,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      const ok = await ExpenseService.delete(id);
      if (!ok) throw new Error("Delete failed");
      return id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["Expense"] });
      setDeleteTarget(null);
      setSelectedExpenseIds((prev) => prev.filter((selectedId) => selectedId !== id));
      toast.success("Expense deleted successfully");
    },
    onError: (err) => {
      toast.error(`Failed to delete expense: ${err?.message || "Unknown error"}`);
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids) => {
      await Promise.all(
        ids.map(async (id) => {
          const ok = await ExpenseService.delete(id);
          if (!ok) throw new Error("Delete failed");
        })
      );
      return ids.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["Expense"] });
      setSelectedExpenseIds([]);
      setShowBulkDelete(false);
      toast.success(`${count} expense record${count === 1 ? "" : "s"} deleted successfully`);
    },
    onError: (err) => {
      toast.error(`Failed to delete selected expenses: ${err?.message || "Unknown error"}`);
    },
  });

  const allFilteredSelected = filtered.length > 0 && filtered.every((expense) => selectedExpenseIds.includes(expense.id));

  const toggleExpenseSelection = (expenseId) => {
    setSelectedExpenseIds((prev) =>
      prev.includes(expenseId)
        ? prev.filter((id) => id !== expenseId)
        : [...prev, expenseId]
    );
  };

  const toggleSelectAllFiltered = (checked) => {
    if (checked) {
      setSelectedExpenseIds((prev) => [...new Set([...prev, ...filtered.map((expense) => expense.id)])]);
      return;
    }
    const filteredIds = new Set(filtered.map((expense) => expense.id));
    setSelectedExpenseIds((prev) => prev.filter((id) => !filteredIds.has(id)));
  };

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader icon={Receipt} title="Expense Engine" subtitle={subtitleScope} iconColor="from-red-500 to-rose-600">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCSV(filtered, "expenses.csv")}>
            <Download className="w-4 h-4 mr-1 text-slate-500" />
            Export
          </Button>
          <ModuleLink page="ChartOfAccounts">
            <Button variant="ghost" size="sm">
              <BookOpen className="w-4 h-4 mr-1" />
              GL Codes
            </Button>
          </ModuleLink>
          <Link to={createPageUrl("BulkImport") + location.search}>
            <Button variant="outline" size="sm">
              <Upload className="w-4 h-4 mr-1" />
              Bulk Import
            </Button>
          </Link>
          <RoleGuard allowedRoles={["org_admin", "finance", "property_manager"]} mode="disable">
            <Link to={createPageUrl("AddExpense") + location.search}>
              <Button size="sm" className="bg-gradient-to-r from-red-500 to-rose-600 shadow-sm">
                <Plus className="w-4 h-4 mr-1" />
                Add Expense
              </Button>
            </Link>
          </RoleGuard>
        </div>
      </PageHeader>

      {selectedPropertyId ? (
        <PipelineActions propertyId={selectedPropertyId} fiscalYear={new Date().getFullYear()} actions={EXPENSE_ACTIONS} />
      ) : (
        <div className="text-xs text-slate-500">Select a property scope to run expense compute/export actions.</div>
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

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <MetricCard label="Total Expenses" value={`$${(totals.all / 1000).toFixed(1)}K`} icon={DollarSign} color="bg-slate-100 text-slate-600" />
        <MetricCard label="Recoverable" value={`$${(totals.recoverable / 1000).toFixed(1)}K`} icon={TrendingDown} color="bg-emerald-50 text-emerald-600" sub="CAM pool eligible" />
        <MetricCard label="Non-Recoverable" value={`$${(totals.non_recoverable / 1000).toFixed(1)}K`} icon={Layers} color="bg-red-50 text-red-600" />
        <MetricCard label="Conditional" value={`$${(totals.conditional / 1000).toFixed(1)}K`} icon={Receipt} color="bg-amber-50 text-amber-600" />
        <MetricCard label="Prior Year" value={`$${(prevYearTotal / 1000).toFixed(1)}K`} sub={`FY ${prevYear}`} />
        <MetricCard
          label="Budgeted"
          value={`$${(budgetedTotal / 1000).toFixed(1)}K`}
          sub={`FY ${currentYear}`}
          trend={budgetedTotal > 0 ? parseFloat((((currentYearExpenses.reduce((sum, expense) => sum + (expense.amount || 0), 0) - budgetedTotal) / budgetedTotal) * 100).toFixed(1)) : undefined}
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Expense Classification</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value">
                  {pieData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => `$${Number(value).toLocaleString()}`} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex justify-center gap-4 mt-2">
              {pieData.map((entry) => (
                <div key={entry.name} className="flex items-center gap-1.5 text-xs">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
                  <span className="text-slate-600">
                    {entry.name} ${(entry.value / 1000).toFixed(1)}K
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Expenses by Category (Recoverable)</CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              const categoryTotals = {};
              selectorScopedExpenses
                .filter((expense) => expense.classification === "recoverable")
                .forEach((expense) => {
                  categoryTotals[expense.category] = (categoryTotals[expense.category] || 0) + (expense.amount || 0);
                });

              const barData = Object.entries(categoryTotals)
                .sort(([, left], [, right]) => right - left)
                .slice(0, 5)
                .map(([category, amount]) => ({
                  name: String(category || "Uncategorized").replace(/_/g, " ").substring(0, 15),
                  value: amount,
                }));

              return (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={barData} layout="vertical" margin={{ left: 10 }}>
                    <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(value) => `$${(value / 1000).toFixed(0)}K`} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={100} />
                    <Tooltip formatter={(value) => `$${Number(value).toLocaleString()}`} />
                    <Bar dataKey="value" fill="#1a2744" radius={[0, 4, 4, 0]} barSize={16} />
                  </BarChart>
                </ResponsiveContainer>
              );
            })()}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="expenses" className="space-y-4">
        <TabsList>
          <TabsTrigger value="expenses" className="text-xs">
            Expense Records
          </TabsTrigger>
          <TabsTrigger value="vendor_spend" className="text-xs">
            Vendor Spend Analysis
          </TabsTrigger>
          <TabsTrigger value="audit" className="text-xs">
            Audit Trail
          </TabsTrigger>
        </TabsList>

        <TabsContent value="expenses" className="space-y-4">
          <div className="flex gap-3 items-center flex-wrap">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input placeholder="Search category, vendor, property..." className="pl-9 h-9 text-sm" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <div className="flex gap-1">
              {["all", "recoverable", "non_recoverable", "conditional"].map((value) => (
                <Button
                  key={value}
                  variant={filter === value ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilter(value)}
                  className={`text-xs capitalize ${filter === value ? "bg-blue-600" : ""}`}
                >
                  {value === "all" ? "All" : value.replace("_", "-")}
                </Button>
              ))}
            </div>
            {selectedExpenseIds.length > 0 && (
              <>
                <span className="text-xs font-medium text-slate-500">
                  {selectedExpenseIds.length} selected
                </span>
                <Button variant="outline" size="sm" onClick={() => setSelectedExpenseIds([])}>
                  Clear
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-red-200 text-red-600 hover:bg-red-50"
                  onClick={() => setShowBulkDelete(true)}
                >
                  <Trash2 className="w-4 h-4 mr-1" />
                  Delete Selected
                </Button>
              </>
            )}
          </div>

          <Card className="overflow-hidden border-slate-200/80">
            <Table>
              <TableHeader>
                <TableRow className="bg-gradient-to-r from-slate-50 to-slate-100/50">
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allFilteredSelected}
                      onCheckedChange={toggleSelectAllFiltered}
                      aria-label="Select all filtered expenses"
                    />
                  </TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">DATE</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">PROPERTY</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">BUILDING</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">UNIT</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">CATEGORY</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">GL CODE</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">VENDOR</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider text-right">AMOUNT</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">CLASS</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">CTRL</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">SOURCE</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider w-20"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={13} className="text-center py-12">
                      <Loader2 className="w-5 h-5 animate-spin mx-auto text-slate-400" />
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={13} className="text-center py-12 text-sm text-slate-400">
                      No expenses found
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((expense) => {
                    const property = expense.property_id ? scope.propertyById.get(expense.property_id) ?? null : null;
                    const building = expense.building_id ? scope.buildingById.get(expense.building_id) ?? null : null;
                    const unit = expense.unit_id ? scope.unitById.get(expense.unit_id) ?? null : null;
                    const matchedVendor = vendors.find(
                      (vendor) => vendor.name?.toLowerCase() === expense.vendor?.toLowerCase() || vendor.id === expense.vendor_id
                    );

                    return (
                      <TableRow key={expense.id} className="hover:bg-slate-50">
                        <TableCell>
                          <Checkbox
                            checked={selectedExpenseIds.includes(expense.id)}
                            onCheckedChange={() => toggleExpenseSelection(expense.id)}
                            aria-label={`Select expense ${expense.category || expense.id}`}
                          />
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          {expense.date || (expense.fiscal_year ? `FY${expense.fiscal_year}${expense.month ? `-M${expense.month}` : ""}` : "—")}
                        </TableCell>
                        <TableCell className="text-xs font-medium text-slate-800">{property?.name || getPropertyName(expense.property_id)}</TableCell>
                        <TableCell className="text-xs text-slate-600">{building?.name || "—"}</TableCell>
                        <TableCell className="text-xs text-slate-600">{unit?.unit_number || unit?.unit_id_code || "—"}</TableCell>
                        <TableCell className="text-xs font-medium capitalize">{expense.category?.replace(/_/g, " ")}</TableCell>
                        <TableCell className="text-[10px] font-mono text-slate-500">{expense.gl_code || "—"}</TableCell>
                        <TableCell className="text-xs">
                          {expense.vendor ? (
                            matchedVendor ? (
                              <Link to={`/VendorProfile?id=${matchedVendor.id}`} className="text-blue-600 hover:underline font-medium" onClick={(event) => event.stopPropagation()}>
                                {expense.vendor}
                              </Link>
                            ) : (
                              <span>{expense.vendor}</span>
                            )
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-right text-xs font-mono font-semibold tabular-nums">${(expense.amount || 0).toLocaleString()}</TableCell>
                        <TableCell>
                          <Badge className={`${classColors[expense.classification]} text-[8px] uppercase`}>
                            {expense.classification?.replace("_", "-")}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span className={`text-[9px] font-semibold ${expense.is_controllable !== false ? "text-emerald-600" : "text-slate-400"}`}>
                            {expense.is_controllable !== false ? "CTRL" : "NON"}
                          </span>
                        </TableCell>
                        <TableCell className="text-[10px] text-slate-400 capitalize">{expense.source}</TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button variant="ghost" size="sm" className="text-[10px] h-6 px-1.5">
                              <Pencil className="w-3 h-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-[10px] h-6 px-1.5 text-red-500"
                              onClick={() => setDeleteTarget(expense)}
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Card>
          <div className="text-xs text-slate-400 text-right">
            {filtered.length} of {selectorScopedExpenses.length} expenses
          </div>
        </TabsContent>

        <TabsContent value="vendor_spend">
          <VendorSpendAnalysis expenses={selectorScopedExpenses} vendors={vendors} budgets={budgets} />
        </TabsContent>

      <TabsContent value="audit">
          <AuditTrailPanel entityType="Expense" />
        </TabsContent>
      </Tabs>

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete expense "${deleteTarget?.category?.replace(/_/g, " ") || ""}"?`}
        description="This will permanently remove the selected expense record."
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
      />

      <DeleteConfirmDialog
        open={showBulkDelete}
        onOpenChange={setShowBulkDelete}
        title={`Delete ${selectedExpenseIds.length} selected expense record${selectedExpenseIds.length === 1 ? "" : "s"}?`}
        description="This will permanently remove all selected expense records."
        confirmLabel="Delete Selected"
        loading={bulkDeleteMutation.isPending}
        onConfirm={() => bulkDeleteMutation.mutate(selectedExpenseIds)}
      />
    </div>
  );
}
