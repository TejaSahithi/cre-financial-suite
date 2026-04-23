import React, { useMemo, useState } from "react";
import useOrgQuery from "@/hooks/useOrgQuery";
import { useSnapshotQuery } from "@/hooks/useSnapshotQuery";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Upload, AlertTriangle, Loader2, CheckCircle2, Calculator } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { toast } from "sonner";
import { invokeEdgeFunction } from "@/services/edgeFunctions";

export default function Reconciliation() {
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [selectedPropertyId, setSelectedPropertyId] = useState("all");

  const { data: properties = [] } = useOrgQuery("Property");
  const { data: budgets = [] } = useOrgQuery("Budget");
  const { data: expenses = [] } = useOrgQuery("Expense");
  const { data: camCalcs = [] } = useOrgQuery("CAMCalculation");
  const { data: leases = [] } = useOrgQuery("Lease");

  const activePropertyId = selectedPropertyId !== "all" ? selectedPropertyId : null;
  const {
    outputs,
    computedAt,
    hasSnapshot,
    refetch,
  } = useSnapshotQuery({
    engineType: "reconciliation",
    propertyId: activePropertyId,
    fiscalYear: selectedYear,
  });

  const filteredBudgets = budgets.filter((budget) =>
    budget.budget_year === selectedYear &&
    (!activePropertyId || budget.property_id === activePropertyId),
  );
  const filteredExpenses = expenses.filter((expense) =>
    expense.fiscal_year === selectedYear &&
    (!activePropertyId || expense.property_id === activePropertyId),
  );
  const filteredCamCalcs = camCalcs.filter((cam) =>
    cam.fiscal_year === selectedYear &&
    (!activePropertyId || cam.property_id === activePropertyId),
  );
  const filteredLeases = leases.filter((lease) => !activePropertyId || lease.property_id === activePropertyId);

  const preview = useMemo(() => {
    const budgetedCAMPool = filteredBudgets.reduce((sum, budget) => sum + (budget.cam_total || 0), 0);
    const actualCAMPool = filteredExpenses
      .filter((expense) => expense.classification === "recoverable")
      .reduce((sum, expense) => sum + (expense.amount || 0), 0);

    const budgetByCategory = {};
    filteredBudgets.forEach((budget) => {
      (budget.expense_items || []).forEach((item) => {
        if (item.classification === "recoverable" || !item.classification) {
          const key = item.category || "Other";
          budgetByCategory[key] = (budgetByCategory[key] || 0) + (item.amount || 0);
        }
      });
    });

    const actualByCategory = {};
    filteredExpenses
      .filter((expense) => expense.classification === "recoverable")
      .forEach((expense) => {
        const key = expense.category || "other";
        actualByCategory[key] = (actualByCategory[key] || 0) + (expense.amount || 0);
      });

    const categories = [...new Set([...Object.keys(budgetByCategory), ...Object.keys(actualByCategory)])];
    const lineItems = categories
      .map((category) => ({
        category: category.replace(/_/g, " "),
        budget: budgetByCategory[category] || 0,
        actual: actualByCategory[category] || 0,
        variance: (actualByCategory[category] || 0) - (budgetByCategory[category] || 0),
        variance_pct: budgetByCategory[category]
          ? (((actualByCategory[category] || 0) - (budgetByCategory[category] || 0)) / budgetByCategory[category]) * 100
          : 0,
        flagged: budgetByCategory[category]
          ? Math.abs((((actualByCategory[category] || 0) - (budgetByCategory[category] || 0)) / budgetByCategory[category]) * 100) > 10
          : false,
      }))
      .sort((left, right) => right.variance - left.variance);

    const tenantAdjustments = filteredCamCalcs.map((cam) => {
      const lease = filteredLeases.find((item) => item.id === cam.lease_id);
      const budgeted = cam.annual_cam || 0;
      const share = cam.tenant_share_pct || 0;
      const actual = actualCAMPool * (share / 100);
      const adjustment = actual - budgeted;
      return {
        tenant: cam.tenant_name || lease?.tenant_name || "Unknown",
        budgeted,
        actual,
        adjustment,
        type: adjustment > 0 ? "owed" : "refund",
      };
    });

    return {
      summary: {
        budget_expenses: budgetedCAMPool,
        actual_expenses: actualCAMPool,
        expense_variance: actualCAMPool - budgetedCAMPool,
        expense_variance_pct: budgetedCAMPool ? ((actualCAMPool - budgetedCAMPool) / budgetedCAMPool) * 100 : 0,
      },
      line_items: lineItems,
      tenant_adjustments: tenantAdjustments,
    };
  }, [filteredBudgets, filteredExpenses, filteredCamCalcs, filteredLeases]);

  const currentData = hasSnapshot
    ? {
        summary: outputs?.summary ?? {},
        line_items: outputs?.line_items ?? [],
        tenant_adjustments: outputs?.flagged_items ?? [],
      }
    : preview;

  const triggerMutation = useMutation({
    mutationFn: async () => {
      if (!activePropertyId) {
        throw new Error("Select a property before running reconciliation");
      }
      return invokeEdgeFunction("compute-reconciliation", {
        property_id: activePropertyId,
        fiscal_year: selectedYear,
      });
    },
    onSuccess: async () => {
      await refetch();
      toast.success("Reconciliation completed");
    },
    onError: (error) => {
      toast.error(`Reconciliation failed: ${error?.message || "Unexpected error"}`);
    },
  });

  const chartData = (currentData.line_items || []).slice(0, 10).map((row) => ({
    category: row.category,
    budgeted: row.budget ?? 0,
    actual: row.actual ?? 0,
  }));

  const summary = currentData.summary || {};
  const hasExpenseData = filteredExpenses.length > 0;
  const propertyLabel =
    properties.find((property) => property.id === activePropertyId)?.name ||
    "selected property";

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Year-End CAM Reconciliation</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {hasSnapshot
              ? "Rendering the latest authoritative reconciliation snapshot."
              : "Showing a preview from stored budget and expense data until a reconciliation snapshot is generated."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={String(selectedYear)} onValueChange={(value) => setSelectedYear(Number(value))}>
            <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[2024, 2025, 2026].map((year) => (
                <SelectItem key={year} value={String(year)}>FY {year}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={selectedPropertyId} onValueChange={setSelectedPropertyId}>
            <SelectTrigger className="w-[220px]"><SelectValue placeholder="Select property" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Select property</SelectItem>
              {properties.map((property) => (
                <SelectItem key={property.id} value={property.id}>{property.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            className="bg-blue-600 hover:bg-blue-700"
            onClick={() => triggerMutation.mutate()}
            disabled={triggerMutation.isPending || !activePropertyId}
          >
            {triggerMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Calculator className="w-4 h-4 mr-2" />}
            Run Reconciliation
          </Button>
        </div>
      </div>

      {!hasExpenseData && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            <p className="text-sm text-amber-800">No actual expenses imported for FY {selectedYear}. Import from your accounting system or upload a CSV file.</p>
          </div>
          <Button size="sm" className="bg-amber-600 hover:bg-amber-700"><Upload className="w-4 h-4 mr-2" />Import Now</Button>
        </div>
      )}

      {(hasSnapshot || activePropertyId) && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-blue-500" />
            <div>
              <p className="text-sm font-medium text-blue-800">
                {activePropertyId ? `Reconciliation scope: ${propertyLabel}` : "Select a property to run reconciliation"}
              </p>
              <p className="text-xs text-blue-600">
                {hasSnapshot && computedAt
                  ? `Authoritative snapshot updated ${new Date(computedAt).toLocaleString()}`
                  : "Preview mode only - no completed reconciliation snapshot yet"}
              </p>
            </div>
          </div>
          <Badge className={hasSnapshot ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}>
            {hasSnapshot ? "snapshot" : "preview"}
          </Badge>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-l-4 border-l-blue-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Budgeted CAM Pool</p>
            <p className="text-2xl font-bold text-slate-900">${Number(summary.budget_expenses || 0).toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-slate-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Actual CAM Pool</p>
            <p className="text-2xl font-bold text-slate-900">${Number(summary.actual_expenses || 0).toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card className={`border-l-4 ${Number(summary.expense_variance || 0) > 0 ? "border-l-red-500" : "border-l-emerald-500"}`}>
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Total Variance</p>
            <p className={`text-2xl font-bold ${Number(summary.expense_variance || 0) > 0 ? "text-red-600" : "text-emerald-600"}`}>
              {Number(summary.expense_variance || 0) > 0 ? "+" : ""}${Number(summary.expense_variance || 0).toLocaleString()}
            </p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Flagged Variances</p>
            <p className="text-2xl font-bold text-slate-900">{(currentData.line_items || []).filter((item) => item.flagged).length}</p>
          </CardContent>
        </Card>
      </div>

      {chartData.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Budget vs Actual - Recoverable Expenses</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(value) => `$${(value / 1000).toFixed(0)}K`} />
                <YAxis type="category" dataKey="category" width={130} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(value) => `$${value.toLocaleString()}`} />
                <Legend />
                <Bar dataKey="budgeted" fill="#1a2744" name="Budgeted" radius={[0, 2, 2, 0]} />
                <Bar dataKey="actual" fill="#3b82f6" name="Actual" radius={[0, 2, 2, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Expense Category Comparison</CardTitle>
            <span className="text-sm text-slate-400">FY {selectedYear}</span>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="text-[11px]">EXPENSE CATEGORY</TableHead>
                  <TableHead className="text-[11px] text-right">BUDGETED</TableHead>
                  <TableHead className="text-[11px] text-right">ACTUAL</TableHead>
                  <TableHead className="text-[11px] text-right">VARIANCE</TableHead>
                  <TableHead className="text-[11px] text-right">% CHANGE</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(currentData.line_items || []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-12 text-slate-400 text-sm">
                      No reconciliation data available for this property/year.
                    </TableCell>
                  </TableRow>
                ) : (currentData.line_items || []).map((row) => (
                  <TableRow key={row.category}>
                    <TableCell className="text-sm font-medium capitalize">{row.category}</TableCell>
                    <TableCell className="text-sm text-right font-mono">${Number(row.budget || 0).toLocaleString()}</TableCell>
                    <TableCell className="text-sm text-right font-mono">${Number(row.actual || 0).toLocaleString()}</TableCell>
                    <TableCell className={`text-sm text-right font-mono ${Number(row.variance || 0) > 0 ? "text-red-600" : "text-emerald-600"}`}>
                      {Number(row.variance || 0) > 0 ? "+" : ""}${Number(row.variance || 0).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge className={Math.abs(Number(row.variance_pct || 0)) > 10 ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-700"}>
                        {Number(row.variance_pct || 0).toFixed(1)}%
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Flagged Items</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {(currentData.tenant_adjustments || []).length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">
                {hasSnapshot ? "No flagged reconciliation items" : "No authoritative reconciliation snapshot yet"}
              </p>
            ) : (currentData.tenant_adjustments || []).map((item, index) => (
              <div key={`${item.category || item.tenant || "item"}-${index}`} className="p-3 rounded-lg bg-slate-50">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-semibold text-slate-900">{item.category || item.tenant || "Flagged item"}</p>
                  <Badge className="bg-amber-100 text-amber-700">
                    {item.flagged ? "Flagged" : item.type === "owed" ? "Tenant Owes" : "Refund Due"}
                  </Badge>
                </div>
                {"variance" in item ? (
                  <p className="text-sm text-slate-600">
                    Variance: ${Number(item.variance || 0).toLocaleString()} ({Number(item.variance_pct || 0).toFixed(1)}%)
                  </p>
                ) : (
                  <p className="text-sm text-slate-600">
                    Adjustment: ${Math.round(Number(item.adjustment || 0)).toLocaleString()}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
