import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import { AlertCircle, Loader2 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";

import { budgetService } from "@/services/budgetService";
import { expenseService } from "@/services/expenseService";
import { propertyService } from "@/services/propertyService";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createPageUrl } from "@/utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ALL_PROPERTIES = "__all__";

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

export default function ExpenseProjection() {
  const location = useLocation();
  const urlParams = new URLSearchParams(location.search);
  const initProperty = urlParams.get("property") || ALL_PROPERTIES;
  const [selectedProperty, setSelectedProperty] = useState(initProperty);
  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;
  const selectedPropertyId = selectedProperty === ALL_PROPERTIES ? null : selectedProperty;

  const { data: properties = [] } = useQuery({
    queryKey: ["properties-exp-proj"],
    queryFn: () => propertyService.list(),
  });

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

  const expensesForProjection = useMemo(() => {
    return finalizedClassifications.map((classification) => {
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
  }, [currentYear, finalizedClassifications]);

  const hasFinalizedData = expensesForProjection.length > 0;
  const currentBudget = budgets.find((budget) => budget.budget_year === currentYear);
  const currentExpenses = expensesForProjection.filter((expense) => expense.fiscal_year === currentYear);
  const prevExpenses = expensesForProjection.filter((expense) => expense.fiscal_year === prevYear);

  const recoveryTotals = useMemo(() => {
    if (!hasFinalizedData) {
      return {
        recoverable: 0,
        nonRecoverable: 0,
        conditional: 0,
        excluded: 0,
        camEligible: 0,
        landlordAbsorbed: 0,
        tenantRecoveryEstimate: 0,
      };
    }

    const totals = {
      recoverable: 0,
      nonRecoverable: 0,
      conditional: 0,
      excluded: 0,
      camEligible: 0,
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
        if (normalizeProjectionText(expense.cam_eligible) === "yes") totals.camEligible += recoverableAmount;
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

    currentExpenses.forEach((expense) => {
      const category = expense.category || "other";
      if (!categories[category]) {
        categories[category] = {
          current: 0,
          prev: 0,
          budgeted: 0,
          classification: expense.classification,
          recoverability: null,
        };
      }
      categories[category].current += expense.amount || 0;
      if (expense.recoverability && !categories[category].recoverability) {
        categories[category].recoverability = expense.recoverability;
      }
    });

    prevExpenses.forEach((expense) => {
      const category = expense.category || "other";
      if (!categories[category]) {
        categories[category] = {
          current: 0,
          prev: 0,
          budgeted: 0,
          classification: expense.classification,
          recoverability: null,
        };
      }
      categories[category].prev += expense.amount || 0;
      if (expense.recoverability && !categories[category].recoverability) {
        categories[category].recoverability = expense.recoverability;
      }
    });

    if (currentBudget?.expense_items) {
      currentBudget.expense_items.forEach((item) => {
        const category = item.category || "other";
        if (!categories[category]) {
          categories[category] = { current: 0, prev: 0, budgeted: 0, recoverability: null };
        }
        categories[category].budgeted += item.amount || 0;
      });
    }

    return Object.entries(categories)
      .sort(([, left], [, right]) => right.current - left.current)
      .map(([category, values]) => {
        const projected =
          values.budgeted > 0 ? values.budgeted : values.prev > 0 ? values.prev * 1.03 : values.current;
        return { category, ...values, projected };
      });
  }, [currentBudget, currentExpenses, prevExpenses]);

  const totalCurrent = categoryData.reduce((sum, category) => sum + category.current, 0);
  const totalPrev = categoryData.reduce((sum, category) => sum + category.prev, 0);
  const totalBudgeted =
    currentBudget?.total_expenses || categoryData.reduce((sum, category) => sum + category.budgeted, 0);
  const totalProjected = categoryData.reduce((sum, category) => sum + category.projected, 0);

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

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Expense Projection</h1>
          <p className="text-sm text-slate-500 mt-1">
            Final expense step: compare current year actuals against prior year actuals, budget, and the forward projection.
          </p>
        </div>
        <Select value={selectedProperty} onValueChange={setSelectedProperty}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder="All Properties" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROPERTIES}>All Properties</SelectItem>
            {properties.map((property) => (
              <SelectItem key={property.id} value={property.id}>
                {property.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!hasFinalizedData && !isLoadingClassifications && (
        <Card className="border-amber-200 bg-amber-50/70">
          <CardContent className="flex items-start gap-3 p-4 text-sm text-amber-900">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="flex-1">
              <p className="font-medium">
                No finalized expense classifications yet. Complete Expense Classification to generate projection.
              </p>
            </div>
            <Link to={createPageUrl("LeaseExpenseClassification")}>
              <Button size="sm" className="bg-amber-700 text-white hover:bg-amber-800">
                Open Classification
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {hasFinalizedData && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <Card className="border-l-4 border-l-emerald-500">
            <CardContent className="p-4">
              <p className="text-[10px] font-semibold uppercase text-emerald-700">Recoverable from tenant</p>
              <p className="text-2xl font-bold text-emerald-900">${Math.round(recoveryTotals.recoverable).toLocaleString()}</p>
              <p className="text-[10px] text-emerald-700/70">finalized {currentYear} classifications</p>
            </CardContent>
          </Card>
          <Card className="border-l-4 border-l-amber-500">
            <CardContent className="p-4">
              <p className="text-[10px] font-semibold uppercase text-amber-700">Conditional</p>
              <p className="text-2xl font-bold text-amber-900">${Math.round(recoveryTotals.conditional).toLocaleString()}</p>
              <p className="text-[10px] text-amber-700/70">depends on caps / triggers</p>
            </CardContent>
          </Card>
          <Card className="border-l-4 border-l-rose-500">
            <CardContent className="p-4">
              <p className="text-[10px] font-semibold uppercase text-rose-700">Non-recoverable</p>
              <p className="text-2xl font-bold text-rose-900">${Math.round(recoveryTotals.nonRecoverable).toLocaleString()}</p>
              <p className="text-[10px] text-rose-700/70">landlord absorbs</p>
            </CardContent>
          </Card>
          <Card className="border-l-4 border-l-slate-500">
            <CardContent className="p-4">
              <p className="text-[10px] font-semibold uppercase text-slate-700">Excluded</p>
              <p className="text-2xl font-bold text-slate-900">${Math.round(recoveryTotals.excluded).toLocaleString()}</p>
              <p className="text-[10px] text-slate-700/70">finalized excluded rows</p>
            </CardContent>
          </Card>
          <Card className="border-l-4 border-l-blue-500">
            <CardContent className="p-4">
              <p className="text-[10px] font-semibold uppercase text-blue-700">CAM-eligible</p>
              <p className="text-2xl font-bold text-blue-900">${Math.round(recoveryTotals.camEligible).toLocaleString()}</p>
              <p className="text-[10px] text-blue-700/70">eligible finalized rows</p>
            </CardContent>
          </Card>
          <Card className="border-l-4 border-l-amber-500">
            <CardContent className="p-4">
              <p className="text-[10px] font-semibold uppercase text-amber-700">Tenant recovery estimate</p>
              <p className="text-2xl font-bold text-amber-900">${Math.round(recoveryTotals.tenantRecoveryEstimate).toLocaleString()}</p>
              <p className="text-[10px] text-amber-700/70">recoverable finalized rows</p>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-l-4 border-l-blue-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Current Year Actual ({currentYear})</p>
            <p className="text-2xl font-bold text-slate-900">${totalCurrent.toLocaleString()}</p>
            {totalPrev > 0 && (
              <p className="text-[10px] text-slate-400">
                {((totalCurrent - totalPrev) / totalPrev * 100).toFixed(1)}% vs prior
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-slate-400">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Prior Year Actual ({prevYear})</p>
            <p className="text-2xl font-bold text-slate-500">${totalPrev.toLocaleString()}</p>
            <p className="text-[10px] text-slate-400">Historical baseline</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-emerald-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Budgeted ({currentYear})</p>
            <p className="text-2xl font-bold text-blue-600">${totalBudgeted.toLocaleString()}</p>
            <p className="text-[10px] text-slate-400">From approved budget</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Forward Projection</p>
            <p className="text-2xl font-bold text-amber-600">${Math.round(totalProjected).toLocaleString()}</p>
            <p className="text-[10px] text-slate-400">Based on trend + budget</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Monthly Comparison - Current Year vs Prior Year vs Budget</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={monthlyChart}>
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => `$${(value / 1000).toFixed(0)}K`} />
              <Tooltip formatter={(value) => `$${value.toLocaleString()}`} />
              <Legend />
              <Bar dataKey="current" name={`Actual ${currentYear}`} fill="#1a2744" radius={[2, 2, 0, 0]} barSize={20} />
              <Bar dataKey="previous" name={`Actual ${prevYear}`} fill="#94a3b8" radius={[2, 2, 0, 0]} barSize={20} />
              <Bar dataKey="budget" name={`Budget ${currentYear}`} fill="#3b82f6" radius={[2, 2, 0, 0]} barSize={20} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Category Comparison - Current Year, Prior Year, Budget, and Projection</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoadingClassifications ? (
            <div className="py-12 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="text-[11px]">CATEGORY</TableHead>
                  <TableHead className="text-[11px]">RECOVERY</TableHead>
                  <TableHead className="text-[11px] text-right">ACTUAL {currentYear}</TableHead>
                  <TableHead className="text-[11px] text-right">ACTUAL {prevYear}</TableHead>
                  <TableHead className="text-[11px] text-right">BUDGET {currentYear}</TableHead>
                  <TableHead className="text-[11px] text-right">PROJECTED</TableHead>
                  <TableHead className="text-[11px] text-right">YOY CHANGE</TableHead>
                  <TableHead className="text-[11px] text-right">BUDGET VAR.</TableHead>
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
                      ? "bg-emerald-100 text-emerald-800"
                      : category.recoverability === "conditional"
                        ? "bg-amber-100 text-amber-800"
                        : category.recoverability === "non_recoverable" || category.recoverability === "excluded"
                          ? "bg-rose-100 text-rose-800"
                          : "bg-slate-100 text-slate-500";

                  return (
                    <TableRow key={category.category}>
                      <TableCell className="text-sm capitalize">{category.category.replace(/_/g, " ")}</TableCell>
                      <TableCell>
                        <Badge className={`${recoveryTone} text-[10px] uppercase`}>
                          {category.recoverability ? category.recoverability.replace(/_/g, " ") : "-"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm font-mono text-right">${category.current.toLocaleString()}</TableCell>
                      <TableCell className="text-sm font-mono text-right text-slate-400">${category.prev.toLocaleString()}</TableCell>
                      <TableCell className="text-sm font-mono text-right text-blue-600">${category.budgeted.toLocaleString()}</TableCell>
                      <TableCell className="text-sm font-mono text-right text-amber-600">${Math.round(category.projected).toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        {yoy !== null ? (
                          <span className={`text-xs ${parseFloat(yoy) > 0 ? "text-red-500" : "text-emerald-600"}`}>{yoy}%</span>
                        ) : (
                          <span className="text-xs text-slate-300">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {budgetVariance !== null ? (
                          <span className={`text-xs ${parseFloat(budgetVariance) > 0 ? "text-red-500" : "text-emerald-600"}`}>{budgetVariance}%</span>
                        ) : (
                          <span className="text-xs text-slate-300">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {categoryData.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-sm text-slate-400">
                      No expense data
                    </TableCell>
                  </TableRow>
                )}
                {categoryData.length > 0 && (
                  <TableRow className="bg-slate-50 font-bold">
                    <TableCell className="text-sm">TOTAL</TableCell>
                    <TableCell className="text-sm text-slate-400">-</TableCell>
                    <TableCell className="text-sm font-mono text-right">${totalCurrent.toLocaleString()}</TableCell>
                    <TableCell className="text-sm font-mono text-right text-slate-400">${totalPrev.toLocaleString()}</TableCell>
                    <TableCell className="text-sm font-mono text-right text-blue-600">${totalBudgeted.toLocaleString()}</TableCell>
                    <TableCell className="text-sm font-mono text-right text-amber-600">${Math.round(totalProjected).toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      {totalPrev > 0 && (
                        <span className={`text-xs ${totalCurrent > totalPrev ? "text-red-500" : "text-emerald-600"}`}>
                          {((totalCurrent - totalPrev) / totalPrev * 100).toFixed(1)}%
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {totalBudgeted > 0 && (
                        <span className={`text-xs ${totalCurrent > totalBudgeted ? "text-red-500" : "text-emerald-600"}`}>
                          {((totalCurrent - totalBudgeted) / totalBudgeted * 100).toFixed(1)}%
                        </span>
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
