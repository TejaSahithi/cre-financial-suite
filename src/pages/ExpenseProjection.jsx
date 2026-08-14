import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import {
  AlertCircle,
  ArrowUpRight,
  BarChart3,
  Calendar,
  DollarSign,
  FileText,
  Layers,
  Loader2,
  PieChart,
  TrendingUp,
  Wallet
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid, Cell } from "recharts";

import useOrgQuery from "@/hooks/useOrgQuery";
import { budgetService } from "@/services/budgetService";
import { expenseService } from "@/services/expenseService";
import { propertyService } from "@/services/propertyService";
import ScopeSelector from "@/components/ScopeSelector";
import { buildHierarchyScope, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createPageUrl } from "@/utils";
import { supabase } from "@/services/supabaseClient";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function normalizeProjectionText(value) {
  return String(value || "").trim().toLowerCase();
}

function classificationExpenseId(row) {
  return row?.actual_expense_id || row?.expense_id || null;
}

function classificationDate(row) {
  return (
    row?.service_period_start ||
    row?.service_period_end ||
    row?.finalized_at ||
    row?.classified_at ||
    null
  );
}

function normalizedClassificationAmount(row) {
  const directAmount = Number(row?.amount);
  if (Number.isFinite(directAmount) && directAmount > 0) return directAmount;

  const bucketAmount =
    Number(row?.recoverable_amount || 0) +
    Number(row?.non_recoverable_amount || 0) +
    Number(row?.conditional_amount || 0) +
    Number(row?.excluded_amount || 0);
  if (bucketAmount > 0) return bucketAmount;

  return 0;
}

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="rounded-[8px] border border-[var(--border-cre)] bg-[var(--ink)] p-3 text-white shadow-[var(--shadow)] backdrop-blur-md">
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)] mb-1">{label}</p>
        {payload.map((entry, index) => (
          <div key={`item-${index}`} className="flex items-center justify-between gap-4 text-xs py-0.5">
            <span className="flex items-center gap-1.5 font-medium" style={{ color: entry.color || entry.fill }}>
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color || entry.fill }} />
              {entry.name}:
            </span>
            <span className="font-mono font-bold text-white">${Number(entry.value).toLocaleString()}</span>
          </div>
        ))}
      </div>
    );
  }
  return null;
};

export default function ExpenseProjection() {
  const location = useLocation();
  const urlParams = new URLSearchParams(location.search);
  const initProperty = urlParams.get("property") || "all";
  const [selectedProperty, setSelectedProperty] = useState(initProperty);
  const [selectedBuilding, setSelectedBuilding] = useState(urlParams.get("building") || "all");
  const [selectedUnit, setSelectedUnit] = useState(urlParams.get("unit") || "all");
  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;
  const selectedPropertyId = selectedProperty === "all" ? null : selectedProperty;

  const { data: properties = [] } = useQuery({
    queryKey: ["properties-exp-proj"],
    queryFn: () => propertyService.list(),
  });
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");

  const scope = useMemo(
    () => buildHierarchyScope({ search: location.search, portfolios, properties, buildings, units }),
    [location.search, portfolios, properties, buildings, units],
  );

  React.useEffect(() => {
    setSelectedProperty(scope.propertyId || "all");
    setSelectedBuilding(scope.buildingId || "all");
    setSelectedUnit(scope.unitId || "all");
  }, [scope.propertyId, scope.buildingId, scope.unitId]);

  const { data: budgets = [] } = useQuery({
    queryKey: ["budgets-proj", selectedProperty],
    queryFn: () =>
      selectedPropertyId
        ? budgetService.filter({ property_id: selectedPropertyId })
        : budgetService.list(),
  });

  const { data: finalizedClassifications = [], isLoading: isLoadingClassifications } = useQuery({
    queryKey: ["expense-projection-finalized", selectedProperty],
    queryFn: async () => {
      const rows = await expenseService.listExpenseClassificationsForScope({
        property_id: selectedPropertyId || "all",
      });
      return rows.filter(
        (row) =>
          normalizeProjectionText(row.classification_status) === "finalized" &&
          row.row_type !== "rule_missing_actual"
      );
    },
  });

  const scopedBudgets = budgets.filter((budget) => matchesHierarchyScope(budget, scope));
  const scopedFinalizedClassifications = finalizedClassifications.filter((classification) => matchesHierarchyScope(classification, scope));

  const finalizedClassificationIds = useMemo(
    () => finalizedClassifications.map((classification) => classification.id).filter(Boolean),
    [finalizedClassifications]
  );

  const { data: publishedCamInputs = [] } = useQuery({
    queryKey: ["expense-projection-published-cam-inputs", finalizedClassificationIds.join("|")],
    queryFn: async () => {
      if (finalizedClassificationIds.length === 0) return [];
      const { data, error } = await supabase
        .from("cam_expense_inputs")
        .select("id, classification_result_id, amount, publication_status")
        .in("classification_result_id", finalizedClassificationIds)
        .eq("publication_status", "published");
      if (error) {
        console.warn("[ExpenseProjection] published CAM input query failed:", error.message);
        return [];
      }
      return data || [];
    },
    enabled: finalizedClassificationIds.length > 0,
  });

  const publishedCamInputTotal = useMemo(
    () => publishedCamInputs.reduce((sum, input) => sum + (Number(input?.amount) || 0), 0),
    [publishedCamInputs]
  );

  const expensesForProjection = useMemo(() => {
    return scopedFinalizedClassifications.map((classification) => {
      const dateValue = classificationDate(classification);
      const parsedDate = dateValue
        ? new Date(String(dateValue).length === 10 ? `${dateValue}T00:00:00` : dateValue)
        : null;
      const fiscalYear =
        parsedDate && !Number.isNaN(parsedDate.getTime())
          ? parsedDate.getFullYear()
          : currentYear;
      const month =
        parsedDate && !Number.isNaN(parsedDate.getTime())
          ? parsedDate.getMonth() + 1
          : null;

      return {
        ...classification,
        id: classification.id,
        expense_id: classificationExpenseId(classification),
        amount: normalizedClassificationAmount(classification),
        category: classification.category || "other",
        recoverability:
          classification.recoverability_result ||
          classification.recovery_status ||
          null,
        fiscal_year: fiscalYear,
        month,
      };
    });
  }, [currentYear, scopedFinalizedClassifications]);

  const hasFinalizedData = expensesForProjection.length > 0;
  const currentBudget = scopedBudgets.find((budget) => budget.budget_year === currentYear);
  const currentExpenses = expensesForProjection.filter((expense) => expense.fiscal_year === currentYear);
  const prevExpenses = expensesForProjection.filter((expense) => expense.fiscal_year === prevYear);

  const recoveryTotals = useMemo(() => {
    if (!hasFinalizedData) {
      return {
        recoverable: 0,
        nonRecoverable: 0,
        conditional: 0,
        excluded: 0,
        landlordAbsorbed: 0,
        tenantRecoveryEstimate: 0,
      };
    }

    const totals = {
      recoverable: 0,
      nonRecoverable: 0,
      conditional: 0,
      excluded: 0,
      landlordAbsorbed: 0,
      tenantRecoveryEstimate: 0,
    };

    for (const expense of currentExpenses) {
      const amount = Number(expense.amount) || 0;
      const result = normalizeProjectionText(
        expense.recoverability_result || expense.recovery_status || expense.recoverability
      );
      const recoverableAmount = Number(expense.recoverable_amount || (result === "recoverable" ? amount : 0));
      const nonRecoverableAmount = Number(expense.non_recoverable_amount || (result === "non_recoverable" ? amount : 0));
      const conditionalAmount = Number(expense.conditional_amount || (result === "conditional" ? amount : 0));
      const excludedAmount = Number(expense.excluded_amount || (result === "excluded" ? amount : 0));

      if (result === "recoverable") {
        totals.recoverable += recoverableAmount;
        totals.tenantRecoveryEstimate += recoverableAmount;
      } else if (result === "conditional") {
        totals.conditional += conditionalAmount;
      } else if (result === "excluded") {
        totals.excluded += excludedAmount;
        totals.landlordAbsorbed += excludedAmount;
      } else {
        totals.nonRecoverable += nonRecoverableAmount;
        totals.landlordAbsorbed += nonRecoverableAmount;
      }
    }

    return totals;
  }, [currentExpenses, hasFinalizedData]);

  const categoryData = useMemo(() => {
    const categories = {};

    expensesForProjection.forEach((expense) => {
      const category = expense.category || "other";
      if (!categories[category]) {
        categories[category] = {
          all: 0,
          current: 0,
          prev: 0,
          budgeted: 0,
          classification: expense.classification,
          recoverability: null,
        };
      }
      categories[category].all += expense.amount || 0;
      if (expense.fiscal_year === currentYear) categories[category].current += expense.amount || 0;
      if (expense.fiscal_year === prevYear) categories[category].prev += expense.amount || 0;
      if (expense.recoverability && !categories[category].recoverability) {
        categories[category].recoverability = expense.recoverability;
      }
    });

    if (currentBudget?.expense_items) {
      currentBudget.expense_items.forEach((item) => {
        const category = item.category || "other";
        if (!categories[category]) {
          categories[category] = { all: 0, current: 0, prev: 0, budgeted: 0, recoverability: null };
        }
        categories[category].budgeted += item.amount || 0;
      });
    }

    return Object.entries(categories)
      .sort(([, left], [, right]) => right.all - left.all)
      .map(([category, values]) => {
        const projected =
          values.budgeted > 0 ? values.budgeted : values.prev > 0 ? values.prev * 1.03 : values.current;
        return { category, ...values, projected };
      });
  }, [currentBudget, currentYear, expensesForProjection, prevYear]);

  const totalCurrent = categoryData.reduce((sum, category) => sum + category.current, 0);
  const totalPrev = categoryData.reduce((sum, category) => sum + category.prev, 0);
  const totalBudgeted =
    currentBudget?.total_expenses || categoryData.reduce((sum, category) => sum + category.budgeted, 0);
  const totalProjected = categoryData.reduce((sum, category) => sum + category.projected, 0);
  const totalFinalized = expensesForProjection.reduce((sum, expense) => sum + (expense.amount || 0), 0);

  const yearlyChart = useMemo(() => {
    const byYear = {};
    expensesForProjection.forEach((expense) => {
      const year = expense.fiscal_year || currentYear;
      if (!byYear[year]) byYear[year] = { year: String(year), finalized: 0, recoverable: 0, nonRecoverable: 0 };
      byYear[year].finalized += expense.amount || 0;
      const recovery = normalizeProjectionText(expense.recoverability);
      if (recovery === "recoverable") byYear[year].recoverable += expense.amount || 0;
      if (recovery === "non_recoverable" || recovery === "excluded") byYear[year].nonRecoverable += expense.amount || 0;
    });
    return Object.values(byYear).sort((left, right) => Number(left.year) - Number(right.year));
  }, [currentYear, expensesForProjection]);

  const recoveryChart = useMemo(() => {
    const buckets = {
      recoverable: 0,
      non_recoverable: 0,
      conditional: 0,
      excluded: 0,
    };
    expensesForProjection.forEach((expense) => {
      const recovery = normalizeProjectionText(expense.recoverability);
      if (recovery === "recoverable") buckets.recoverable += expense.amount || 0;
      else if (recovery === "conditional") buckets.conditional += expense.amount || 0;
      else if (recovery === "excluded") buckets.excluded += expense.amount || 0;
      else buckets.non_recoverable += expense.amount || 0;
    });
    return [
      { type: "Recoverable", amount: Math.round(buckets.recoverable), color: "#10b981" },
      { type: "Non-Recoverable", amount: Math.round(buckets.non_recoverable), color: "#f43f5e" },
      { type: "Conditional", amount: Math.round(buckets.conditional), color: "#f59e0b" },
      { type: "Excluded", amount: Math.round(buckets.excluded), color: "#64748b" },
    ];
  }, [expensesForProjection]);

  const monthlyChart = useMemo(
    () =>
      MONTHS.map((month, index) => {
        const currentMonthTotal = currentExpenses
          .filter((expense) => expense.month === index + 1)
          .reduce((sum, expense) => sum + (expense.amount || 0), 0);
        const prevMonthTotal = prevExpenses
          .filter((expense) => expense.month === index + 1)
          .reduce((sum, expense) => sum + (expense.amount || 0), 0);
        const budgetMonth = totalBudgeted > 0 ? totalBudgeted / 12 : 0;
        return {
          month,
          current: Math.round(currentMonthTotal),
          previous: Math.round(prevMonthTotal),
          budget: Math.round(budgetMonth),
        };
      }),
    [currentExpenses, prevExpenses, totalBudgeted]
  );

  const selectedScopeName =
    scope.activeUnit?.unit_number ||
    scope.activeUnit?.name ||
    scope.activeBuilding?.name ||
    scope.activeProperty?.name ||
    scope.activePortfolio?.name ||
    "All Properties";

  return (
    <div className="p-4 lg:p-8 space-y-6 bg-[var(--surface-2)] min-h-screen">
      {/* ── Eye-Catching Glassmorphic Hero Banner ────────────────── */}
      <div className="relative overflow-hidden rounded-[8px] bg-[var(--surface)] p-6 lg:p-8 text-[var(--ink)] shadow-[var(--shadow)] border border-[var(--border-cre)]">
        <div className="absolute right-0 top-0 -mr-16 -mt-16 h-64 w-64 rounded-full bg-[var(--info-soft)] opacity-30 " />
        <div className="absolute left-1/3 bottom-0 -ml-16 -mb-16 h-64 w-64 rounded-full bg-[var(--accent-soft)] opacity-30 " />

        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Badge className="bg-[var(--info-soft)] text-[var(--info)] border-[var(--border-cre)] px-3 py-1 text-xs font-semibold">
                <TrendingUp className="w-3.5 h-3.5 mr-1.5 text-[var(--info)]" />
                Financial Forecasting Hub
              </Badge>
              <Badge variant="outline" className="border-[color-mix(in_srgb,var(--border-cre)_35%,transparent)] text-[var(--muted)] text-xs">
                Scope: {selectedScopeName}
              </Badge>
            </div>
            <h1 className="text-[28px] font-extrabold tracking-tight text-[var(--ink)]">Expense Projection</h1>
            <p className="mt-1 max-w-2xl text-xs lg:text-sm text-[var(--muted)]">
              Interactive financial dashboard driven by finalized expense classifications. Compare actuals, prior baselines, and budgets to forecast CAM recoveries.
            </p>
          </div>

          <ScopeSelector
            portfolios={scope.orgScopedPortfolios}
            properties={properties}
            buildings={buildings}
            units={units}
            selectedPortfolio={scope.portfolioId || "all"}
            selectedProperty={selectedProperty}
            selectedBuilding={selectedBuilding}
            selectedUnit={selectedUnit}
            onPropertyChange={setSelectedProperty}
            onBuildingChange={(value) => {
              setSelectedBuilding(value);
              setSelectedUnit("all");
            }}
            onUnitChange={setSelectedUnit}
            syncToUrl
          />
        </div>

        {/* Hero Quick Stats Row */}
        {hasFinalizedData && (
          <div className="mt-6 pt-6 border-t border-[color-mix(in_srgb,var(--border-cre)_35%,transparent)] grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="rounded-[8px] bg-[var(--surface-2)] p-3.5 border border-[var(--border-cre)]">
              <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]">Total Finalized Spend</p>
              <p className="mt-1 text-xl font-bold font-mono text-[var(--ink)]">${totalFinalized.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              <p className="text-[10px] text-[var(--muted)] mt-0.5">{expensesForProjection.length} approved classifications</p>
            </div>
            <div className="rounded-[8px] bg-[var(--success-soft)] p-3.5 border border-[var(--border-cre)]">
              <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--success)]">Tenant Recoverable</p>
              <p className="mt-1 text-xl font-bold font-mono text-[var(--success)]">${Math.round(recoveryTotals.recoverable).toLocaleString("en-US")}</p>
              <p className="text-[10px] text-[var(--success)] mt-0.5">Estimated tenant recovery</p>
            </div>
            <div className="rounded-[8px] bg-[var(--accent-soft)] p-3.5 border border-[var(--border-cre)]">
              <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--accent)]">Published CAM Inputs</p>
              <p className="mt-1 text-xl font-bold font-mono text-[var(--accent)]">${publishedCamInputTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              <p className="text-[10px] text-[var(--accent)] mt-0.5">Published via CAM input workflow</p>
            </div>
            <div className="rounded-[8px] bg-[var(--warning-soft)] p-3.5 border border-[var(--border-cre)]">
              <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--warning)]">Forward Projection</p>
              <p className="mt-1 text-xl font-bold font-mono text-[var(--warning)]">${Math.round(totalProjected).toLocaleString("en-US")}</p>
              <p className="text-[10px] text-[var(--warning)] mt-0.5">Trend + Budget forecast</p>
            </div>
          </div>
        )}
      </div>

      {!hasFinalizedData && !isLoadingClassifications && (
        <Card className="border-[var(--border-cre)] bg-[var(--warning-soft)] shadow-[var(--shadow-soft)]">
          <CardContent className="flex items-start gap-4 p-5 text-sm text-[var(--warning)]">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--warning)]" />
            <div className="flex-1">
              <h3 className="font-semibold text-[var(--warning)]">No finalized expense classifications yet</h3>
              <p className="text-xs text-[var(--warning)] mt-0.5">
                Complete Expense Classification to generate projection benchmarks and forward forecasts for this scope.
              </p>
            </div>
            <Link to={createPageUrl("LeaseExpenseClassification")}>
              <Button size="sm" className="bg-[var(--warning)] text-white hover:bg-[var(--warning)] shadow-[var(--shadow-soft)]">
                Open Classification
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {/* ── Executive Performance KPI Cards ────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-[var(--border-cre)] bg-[var(--surface)] shadow-[var(--shadow-soft)] hover:shadow-[var(--shadow-soft)] transition-all border-t-4 border-t-blue-600">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">Current Year ({currentYear})</span>
              <div className="rounded-lg bg-[var(--info-soft)] p-2 text-[var(--info)]">
                <Wallet className="h-4 w-4" />
              </div>
            </div>
            <p className="mt-2 text-2xl font-bold font-mono text-[var(--ink)]">${totalCurrent.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            {totalPrev > 0 && (
              <p className="mt-1 flex items-center text-xs font-semibold text-[var(--success)]">
                <ArrowUpRight className="mr-0.5 h-3.5 w-3.5" />
                {((totalCurrent - totalPrev) / totalPrev * 100).toFixed(1)}% vs prior baseline
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="border-[var(--border-cre)] bg-[var(--surface)] shadow-[var(--shadow-soft)] hover:shadow-[var(--shadow-soft)] transition-all border-t-4 border-t-slate-400">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">Prior Year ({prevYear})</span>
              <div className="rounded-lg bg-[var(--surface-2)] p-2 text-[var(--muted)]">
                <Calendar className="h-4 w-4" />
              </div>
            </div>
            <p className="mt-2 text-2xl font-bold font-mono text-[var(--muted)]">${totalPrev.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            <p className="mt-1 text-xs text-[var(--muted)]">Historical comparison baseline</p>
          </CardContent>
        </Card>

        <Card className="border-[var(--border-cre)] bg-[var(--surface)] shadow-[var(--shadow-soft)] hover:shadow-[var(--shadow-soft)] transition-all border-t-4 border-t-blue-500">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">Approved Budget ({currentYear})</span>
              <div className="rounded-lg bg-[var(--accent-soft)] p-2 text-[var(--accent)]">
                <DollarSign className="h-4 w-4" />
              </div>
            </div>
            <p className="mt-2 text-2xl font-bold font-mono text-[var(--accent)]">${totalBudgeted.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            <p className="mt-1 text-xs text-[var(--accent)]">Approved operating target</p>
          </CardContent>
        </Card>

        <Card className="border-[var(--border-cre)] bg-[var(--surface)] shadow-[var(--shadow-soft)] hover:shadow-[var(--shadow-soft)] transition-all border-t-4 border-t-amber-500">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">Forward Projection</span>
              <div className="rounded-lg bg-[var(--warning-soft)] p-2 text-[var(--warning)]">
                <TrendingUp className="h-4 w-4" />
              </div>
            </div>
            <p className="mt-2 text-2xl font-bold font-mono text-[var(--warning)]">${Math.round(totalProjected).toLocaleString("en-US")}</p>
            <p className="mt-1 text-xs text-[var(--warning)]">Modeled trend forecast</p>
          </CardContent>
        </Card>
      </div>

      {/* ── High-Impact Visual Analytics Hub ────────────────────── */}
      {hasFinalizedData && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Chart 1: Finalized Expenses & Recoverability Trend */}
          <Card className="border-[var(--border-cre)] shadow-[var(--shadow-soft)] bg-[var(--surface)] overflow-hidden">
            <CardHeader className="border-b border-[var(--border-cre)] bg-[var(--surface-2)] pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-bold text-[var(--ink)] flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-[var(--success)]" />
                    Finalized Expenses & Recoverability by Year
                  </CardTitle>
                  <CardDescription className="text-xs text-[var(--muted)]">
                    Annual comparison of recoverable tenant charges vs. landlord non-recoverable spend
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-6">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={yearlyChart} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="year" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={(val) => `$${(val / 1000).toFixed(0)}k`} axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ paddingTop: 15, fontSize: 12 }} />
                  <Bar dataKey="recoverable" name="Recoverable" fill="#10b981" radius={[6, 6, 0, 0]} barSize={32} />
                  <Bar dataKey="nonRecoverable" name="Non-Recoverable / Excluded" fill="#f43f5e" radius={[6, 6, 0, 0]} barSize={32} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Chart 2: Recoverability Mix */}
          <Card className="border-[var(--border-cre)] shadow-[var(--shadow-soft)] bg-[var(--surface)] overflow-hidden">
            <CardHeader className="border-b border-[var(--border-cre)] bg-[var(--surface-2)] pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-bold text-[var(--ink)] flex items-center gap-2">
                    <PieChart className="h-4 w-4 text-[var(--info)]" />
                    Recoverability Mix Breakdown
                  </CardTitle>
                  <CardDescription className="text-xs text-[var(--muted)]">
                    Distribution of finalized costs across recovery classifications
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-6">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={recoveryChart} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="type" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={(val) => `$${(val / 1000).toFixed(0)}k`} axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="amount" name="Amount" radius={[6, 6, 0, 0]} barSize={40}>
                    {recoveryChart.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Chart 3: Monthly Financial Pace (12-Month Bar Chart) */}
      <Card className="border-[var(--border-cre)] shadow-[var(--shadow-soft)] bg-[var(--surface)] overflow-hidden">
        <CardHeader className="border-b border-[var(--border-cre)] bg-[var(--surface-2)] pb-4">
          <div>
            <CardTitle className="text-base font-bold text-[var(--ink)] flex items-center gap-2">
              <Layers className="h-4 w-4 text-[var(--accent)]" />
              Monthly Comparison — Current Year vs. Prior Year vs. Budget
            </CardTitle>
            <CardDescription className="text-xs text-[var(--muted)]">
              12-month cadence tracking financial burn rate and seasonal variances
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="pt-6">
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={monthlyChart} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={(val) => `$${(val / 1000).toFixed(0)}k`} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ paddingTop: 15, fontSize: 12 }} />
              <Bar dataKey="current" name={`Actual ${currentYear}`} fill="#1e1b4b" radius={[4, 4, 0, 0]} barSize={16} />
              <Bar dataKey="previous" name={`Actual ${prevYear}`} fill="#94a3b8" radius={[4, 4, 0, 0]} barSize={16} />
              <Bar dataKey="budget" name={`Budget ${currentYear}`} fill="#3b82f6" radius={[4, 4, 0, 0]} barSize={16} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* ── Category Financial Breakdown Matrix ────────────────────── */}
      <Card className="border-[var(--border-cre)] shadow-[var(--shadow-soft)] bg-[var(--surface)] overflow-hidden">
        <CardHeader className="border-b border-[var(--border-cre)] bg-[var(--surface-2)] pb-4">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base font-bold text-[var(--ink)] flex items-center gap-2">
                <FileText className="h-4 w-4 text-[var(--info)]" />
                Category Comparison & Forward Projection Matrix
              </CardTitle>
              <CardDescription className="text-xs text-[var(--muted)]">
                Detailed category-level forecast comparing all finalized expenses, current actuals, prior actuals, budget, and YoY variance
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoadingClassifications ? (
            <div className="py-16 flex flex-col items-center justify-center text-[var(--muted)]">
              <Loader2 className="w-8 h-8 animate-spin mb-2 text-[var(--info)]" />
              <p className="text-xs">Loading projection matrix...</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-[var(--surface-2)] border-b border-[var(--border-cre)]">
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]">Category</TableHead>
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]">Recovery</TableHead>
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider text-right text-[var(--muted)]">All Finalized</TableHead>
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider text-right text-[var(--muted)]">Actual {currentYear}</TableHead>
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider text-right text-[var(--muted)]">Actual {prevYear}</TableHead>
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider text-right text-[var(--muted)]">Budget {currentYear}</TableHead>
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider text-right text-[var(--muted)]">Projected</TableHead>
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider text-right text-[var(--muted)]">YoY Var</TableHead>
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider text-right text-[var(--muted)]">Budget Var</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categoryData.map((category) => {
                  const yoy =
                    category.prev > 0
                      ? ((category.current - category.prev) / category.prev * 100).toFixed(1)
                      : null;
                  const budgetVariance =
                    category.budgeted > 0
                      ? ((category.current - category.budgeted) / category.budgeted * 100).toFixed(1)
                      : null;
                  const recoveryTone =
                    category.recoverability === "recoverable"
                      ? "bg-[var(--success-soft)] text-[var(--success)] border-[var(--border-cre)]"
                      : category.recoverability === "conditional"
                        ? "bg-[var(--warning-soft)] text-[var(--warning)] border-[var(--border-cre)]"
                        : category.recoverability === "non_recoverable" || category.recoverability === "excluded"
                          ? "bg-rose-50 text-rose-700 border-rose-200"
                          : "bg-[var(--surface-2)] text-[var(--muted)] border-[var(--border-cre)]";

                  return (
                    <TableRow key={category.category} className="hover:bg-[var(--bg)] transition-colors border-b border-[var(--border-cre)]">
                      <TableCell className="text-xs font-semibold capitalize text-[var(--ink)]">{category.category.replace(/_/g, " ")}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`${recoveryTone} text-[9px] uppercase border font-semibold`}>
                          {category.recoverability ? category.recoverability.replace(/_/g, " ") : "Needs Review"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs font-mono font-semibold text-right text-[var(--ink)]">${category.all.toLocaleString()}</TableCell>
                      <TableCell className="text-xs font-mono text-right text-[var(--ink)]">${category.current.toLocaleString()}</TableCell>
                      <TableCell className="text-xs font-mono text-right text-[var(--muted)]">${category.prev.toLocaleString()}</TableCell>
                      <TableCell className="text-xs font-mono text-right text-[var(--accent)]">${category.budgeted.toLocaleString()}</TableCell>
                      <TableCell className="text-xs font-mono font-bold text-right text-[var(--warning)]">${Math.round(category.projected).toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        {yoy !== null ? (
                          <Badge variant="outline" className={`text-[10px] font-mono border ${parseFloat(yoy) > 0 ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-[var(--success-soft)] text-[var(--success)] border-[var(--border-cre)]"}`}>
                            {parseFloat(yoy) > 0 ? `+${yoy}%` : `${yoy}%`}
                          </Badge>
                        ) : (
                          <span className="text-xs text-[var(--muted)]">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {budgetVariance !== null ? (
                          <Badge variant="outline" className={`text-[10px] font-mono border ${parseFloat(budgetVariance) > 0 ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-[var(--success-soft)] text-[var(--success)] border-[var(--border-cre)]"}`}>
                            {parseFloat(budgetVariance) > 0 ? `+${budgetVariance}%` : `${budgetVariance}%`}
                          </Badge>
                        ) : (
                          <span className="text-xs text-[var(--muted)]">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {categoryData.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-12 text-xs text-[var(--muted)]">
                      No finalized category data available for this scope.
                    </TableCell>
                  </TableRow>
                )}
                {categoryData.length > 0 && (
                  <TableRow className="bg-[var(--surface-2)] font-bold border-t-2 border-[var(--border-cre)]">
                    <TableCell className="text-xs uppercase font-extrabold text-[var(--ink)]">Total Projection</TableCell>
                    <TableCell className="text-xs text-[var(--muted)]">-</TableCell>
                    <TableCell className="text-xs font-mono font-extrabold text-right text-[var(--ink)]">${totalFinalized.toLocaleString()}</TableCell>
                    <TableCell className="text-xs font-mono font-bold text-right text-[var(--ink)]">${totalCurrent.toLocaleString()}</TableCell>
                    <TableCell className="text-xs font-mono text-right text-[var(--muted)]">${totalPrev.toLocaleString()}</TableCell>
                    <TableCell className="text-xs font-mono font-bold text-right text-[var(--accent)]">${totalBudgeted.toLocaleString()}</TableCell>
                    <TableCell className="text-xs font-mono font-extrabold text-right text-[var(--warning)]">${Math.round(totalProjected).toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      {totalPrev > 0 && (
                        <Badge variant="outline" className={`text-[10px] font-mono border ${totalCurrent > totalPrev ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-[var(--success-soft)] text-[var(--success)] border-[var(--border-cre)]"}`}>
                          {((totalCurrent - totalPrev) / totalPrev * 100).toFixed(1)}%
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {totalBudgeted > 0 && (
                        <Badge variant="outline" className={`text-[10px] font-mono border ${totalCurrent > totalBudgeted ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-[var(--success-soft)] text-[var(--success)] border-[var(--border-cre)]"}`}>
                          {((totalCurrent - totalBudgeted) / totalBudgeted * 100).toFixed(1)}%
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
