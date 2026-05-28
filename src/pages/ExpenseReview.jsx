import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ClipboardCheck, FileText, Loader2, Search, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import MetricCard from "@/components/MetricCard";
import PageHeader from "@/components/PageHeader";
import ScopeSelector from "@/components/ScopeSelector";
import useOrgQuery from "@/hooks/useOrgQuery";
import { buildHierarchyScope, getScopeSubtitle, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import { expenseService } from "@/services/expenseService";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createPageUrl } from "@/utils";
import { resolveTenantForExpense } from "@/lib/tenantResolver";

function normalizeBucket(expense) {
  const status = String(expense?.recoverability_result || expense?.recovery_status || expense?.classification || "needs_review").toLowerCase();
  if (status === "recoverable") return "recoverable";
  if (["non_recoverable", "excluded"].includes(status)) return status;
  if (status === "conditional") return "conditional";
  return "needs_review";
}

function toAmount(expense) {
  return Number(expense?.amount || 0);
}

function amountBuckets(amount, recoveryStatus) {
  const numericAmount = Number(amount) || 0;
  return {
    recoverable_amount: recoveryStatus === "recoverable" ? numericAmount : 0,
    non_recoverable_amount: recoveryStatus === "non_recoverable" ? numericAmount : 0,
    conditional_amount: recoveryStatus === "conditional" ? numericAmount : 0,
    excluded_amount: recoveryStatus === "excluded" ? numericAmount : 0,
  };
}

function buildClassificationReviewPatch(row, { recoveryStatus, approvedStatus }) {
  const now = new Date().toISOString();
  const nextStatus =
    approvedStatus === "approved"
      ? (["recoverable", "non_recoverable", "excluded"].includes(recoveryStatus) ? "finalized" : "conditional")
      : recoveryStatus === "conditional"
        ? "conditional"
        : ["non_recoverable", "excluded"].includes(recoveryStatus)
          ? "excluded"
          : "matched";

  return {
    recoverability_result: recoveryStatus,
    recovery_status: recoveryStatus,
    approved_status: approvedStatus,
    classification_status: nextStatus,
    exception_type: ["finalized", "excluded"].includes(nextStatus) ? null : row?.exception_type || null,
    reviewed_at: now,
    finalized_at: nextStatus === "finalized" || nextStatus === "excluded" ? now : null,
    ...amountBuckets(row?.amount, recoveryStatus),
    next_step: nextStatus === "finalized" || nextStatus === "excluded" ? "Ready for projection" : "Finalize row",
  };
}

function getRecoveryTone(bucket) {
  if (bucket === "recoverable") return "bg-emerald-100 text-emerald-700";
  if (bucket === "non_recoverable") return "bg-rose-100 text-rose-700";
  if (bucket === "excluded") return "bg-slate-200 text-slate-700";
  if (bucket === "conditional") return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-700";
}

export default function ExpenseReview() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");

  const { data: leases = [] } = useOrgQuery("Lease");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: allBuildings = [] } = useOrgQuery("Building");
  const { data: allUnits = [] } = useOrgQuery("Unit");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  // Tenants are loaded only for the centralized tenant resolver
  // (src/lib/tenantResolver.js) — used for the diagnostic tooltip when a
  // review row has no tenant_name on it.
  const { data: tenants = [] } = useOrgQuery("Tenant");

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

  const scopedLeases = leases.filter((lease) => {
    if (
      !matchesHierarchyScope(lease, scope, {
        portfolioKey: "portfolio_id",
        propertyKey: "property_id",
        buildingKey: "building_id",
        unitKey: "unit_id",
      })
    ) {
      return false;
    }

    if (scopeProperty !== "all" && lease.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all" && lease.building_id && lease.building_id !== scopeBuilding) return false;
    if (scopeUnit !== "all" && lease.unit_id && lease.unit_id !== scopeUnit) return false;
    return true;
  });

  const scopedLeaseIds = useMemo(
    () => scopedLeases.map((lease) => lease.id).filter(Boolean),
    [scopedLeases]
  );

  const { data: scopedRuleSets = [], isLoading: isLoadingRuleSets } = useQuery({
    queryKey: ["expense-review-rule-sets", scopedLeaseIds.join("|")],
    queryFn: () => leaseExpenseRuleService.loadRuleSets(scopedLeaseIds),
    enabled: scopedLeaseIds.length > 0,
  });

  const { data: workflowSummary } = useQuery({
    queryKey: ["expense-review-workflow-summary", scopeProperty, scopeBuilding, scopeUnit],
    queryFn: () =>
      expenseService.getWorkflowSummary({
        propertyId: scopeProperty !== "all" ? scopeProperty : scope.propertyId || null,
        buildingId: scopeBuilding !== "all" ? scopeBuilding : scope.buildingId || null,
        unitId: scopeUnit !== "all" ? scopeUnit : scope.unitId || null,
        fiscalYear: new Date().getFullYear(),
      }),
    enabled: true,
  });

  const classificationScope = useMemo(
    () => ({
      property_id: scopeProperty !== "all" ? scopeProperty : "all",
      building_id: scopeBuilding !== "all" ? scopeBuilding : "all",
      unit_id: scopeUnit !== "all" ? scopeUnit : "all",
    }),
    [scopeProperty, scopeBuilding, scopeUnit]
  );

  const { data: scopedClassifications = [], isLoading: isLoadingClassifications } = useQuery({
    queryKey: ["expense-review-classifications", scopeProperty, scopeBuilding, scopeUnit],
    queryFn: () => expenseService.listExpenseClassificationsForScope(classificationScope),
  });

  const reviewRows = useMemo(() => {
    return scopedClassifications
      .filter((row) => row.actual_expense_id || row.expense_id)
      .map((row) => {
        const expenseId = row.actual_expense_id || row.expense_id;
        return {
          ...row,
          id: row.id,
          expense_id: expenseId,
          actual_expense_id: expenseId,
          amount: Number(row.amount ?? 0),
          category: row.category || null,
          expense_subcategory: row.subcategory || null,
          tenant_name: row.tenant_name || null,
          vendor_name: row.vendor_name || null,
          vendor: row.vendor || null,
          lease_id: row.lease_id || null,
          property_id: row.property_id || null,
          building_id: row.building_id || null,
          unit_id: row.unit_id || null,
          recovery_rule_id: row.lease_expense_rule_id || row.recovery_rule_id || null,
          evidence_text: row.evidence_text || row.recovery_reason || row.notes || null,
          classification: row.recoverability_result || row.recovery_status,
          recovery_status: row.recoverability_result || row.recovery_status,
        };
      });
  }, [scopedClassifications]);

  const actualExpenses = reviewRows.filter((expense) => Boolean(expense.actual_expense_id));
  const bucketedExpenses = useMemo(() => {
    return reviewRows.reduce((accumulator, expense) => {
      const bucket = normalizeBucket(expense);
      accumulator[bucket].push(expense);
      return accumulator;
    }, {
      recoverable: [],
      non_recoverable: [],
      excluded: [],
      conditional: [],
      needs_review: [],
    });
  }, [reviewRows]);

  const ruleSummary = useMemo(() => {
    const allRules = scopedRuleSets.flatMap((entry) => entry.rules || []);
    const grouped = leaseExpenseRuleService.groupRulesByRecoveryStatus(allRules);
    const approvedRuleLeaseIds = new Set(
      allRules
        .filter((rule) => expenseService.isApprovedLeaseRule(rule))
        .map((rule) => rule.lease_id || rule.rule_set?.lease_id)
        .filter(Boolean)
    );
    return {
      approvedLeaseCount: approvedRuleLeaseIds.size,
      draftLeaseCount: Math.max(scopedLeases.length - approvedRuleLeaseIds.size, 0),
      recoverableCount: grouped.recoverable.length,
      nonRecoverableCount: grouped.nonRecoverable.length,
      conditionalCount: grouped.conditional.length,
      needsReviewCount: grouped.needsReview.length,
    };
  }, [scopedLeases.length, scopedRuleSets]);

  const totals = {
    recoverable: bucketedExpenses.recoverable.reduce((sum, expense) => sum + toAmount(expense), 0),
    nonRecoverable: bucketedExpenses.non_recoverable.reduce((sum, expense) => sum + toAmount(expense), 0),
    excluded: bucketedExpenses.excluded.reduce((sum, expense) => sum + toAmount(expense), 0),
    conditional: bucketedExpenses.conditional.reduce((sum, expense) => sum + toAmount(expense), 0),
    needsReview: bucketedExpenses.needs_review.reduce((sum, expense) => sum + toAmount(expense), 0),
  };

  const filteredBuckets = useMemo(() => {
    const predicate = (expense) => {
      if (!search) return true;
      const haystack = [
        expense.property_name,
        expense.tenant_name,
        expense.vendor_name,
        expense.vendor,
        expense.category,
        expense.expense_subcategory,
        expense.description,
        expense.evidence_text,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(search.toLowerCase());
    };

    return Object.fromEntries(
      Object.entries(bucketedExpenses).map(([bucket, bucketExpenses]) => [
        bucket,
        bucketExpenses.filter(predicate),
      ])
    );
  }, [bucketedExpenses, search]);

  const reviewMutation = useMutation({
    mutationFn: async ({ classificationId, recoveryStatus, approvedStatus }) => {
      const row = reviewRows.find((item) => item.id === classificationId);
      return expenseService.updateExpenseClassification(
        classificationId,
        buildClassificationReviewPatch(row, { recoveryStatus, approvedStatus })
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["Expense"] });
      queryClient.invalidateQueries({ queryKey: ["expense-review-classifications"] });
      queryClient.invalidateQueries({ queryKey: ["expense-review-exceptions"] });
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
      queryClient.invalidateQueries({ queryKey: ["expense-projection-finalized"] });
      toast.success("Expense review updated.");
    },
    onError: (error) => {
      toast.error(error?.message || "Could not update expense review.");
    },
  });

  // ── Exception Queue ───────────────────────────────────────────────────
  // Per spec: Expense Review's primary job is resolving classification
  // exceptions, NOT browsing every classified row. The Exception Queue
  // pulls from expense_classifications WHERE classification_status is
  // 'unmatched'/'exception'/'conditional' OR exception_type is non-null.
  // Each row is one decision the reviewer must make.
  const exceptionRows = useMemo(() => {
    return scopedClassifications.filter((row) => {
      const status = String(row?.classification_status || "").toLowerCase();
      const recoverability = String(row?.recoverability_result || row?.recovery_status || "").toLowerCase();
      const exceptionType = String(row?.exception_type || "").toLowerCase();
      return (
        ["unmatched", "exception", "conditional"].includes(status) ||
        recoverability === "needs_review" ||
        (exceptionType && exceptionType !== "none" && exceptionType !== "null")
      );
    });
  }, [scopedClassifications]);
  const isLoadingExceptions = isLoadingClassifications;

  // Join in actual expense details (vendor, date) for each exception so the
  // queue can show "Vendor X, invoice $Y, dated Z" without a separate fetch.
  const enrichedExceptions = useMemo(() => {
    return exceptionRows.map((row) => {
      const expenseId = row.expense_id || row.actual_expense_id;
      return {
        ...row,
        expense_id: expenseId,
        expense_vendor: row.vendor || row.vendor_name || null,
        expense_date: row.service_period_start || row.service_period_end || row.classified_at || null,
        expense_amount: row.amount,
        expense_category: row.category,
        expense_description: row.description || row.recovery_reason || row.notes,
        expense_invoice_number: row.invoice_number,
      };
    });
  }, [exceptionRows]);

  const exceptionCounts = useMemo(() => ({
    unmatched: enrichedExceptions.filter((e) => e.classification_status === "unmatched").length,
    low_confidence: enrichedExceptions.filter((e) => e.exception_type === "low_confidence").length,
    conditional: enrichedExceptions.filter((e) => e.classification_status === "conditional").length,
    other_exception: enrichedExceptions.filter((e) => e.classification_status === "exception" && e.exception_type !== "low_confidence").length,
    total: enrichedExceptions.length,
  }), [enrichedExceptions]);

  const exceptionMutation = useMutation({
    mutationFn: async ({ classificationId, action }) => {
      if (action === "approve") {
        const row = scopedClassifications.find((item) => item.id === classificationId);
        await expenseService.updateExpenseClassification(
          classificationId,
          buildClassificationReviewPatch(row, {
            recoveryStatus: row?.recoverability_result || row?.recovery_status || "recoverable",
            approvedStatus: "approved",
          })
        );
        return { classificationId, action };
      }
      if (action === "reject") {
        const row = scopedClassifications.find((item) => item.id === classificationId);
        await expenseService.updateExpenseClassification(classificationId, {
          classification_status: "excluded",
          recoverability_result: "excluded",
          recovery_status: "excluded",
          exception_type: null,
          ...amountBuckets(row?.amount, "excluded"),
          next_step: "Ready for projection",
        });
        return { classificationId, action };
      }
      if (action === "mark_na") {
        const row = scopedClassifications.find((item) => item.id === classificationId);
        await expenseService.updateExpenseClassification(classificationId, {
          classification_status: "excluded",
          recoverability_result: "non_recoverable",
          recovery_status: "non_recoverable",
          exception_type: null,
          ...amountBuckets(row?.amount, "non_recoverable"),
          next_step: "Ready for projection",
        });
        return { classificationId, action };
      }
      if (action === "resolve") {
        await expenseService.updateExpenseClassification(classificationId, {
          classification_status: "matched",
          exception_type: null,
          next_step: "Finalize row",
        });
        return { classificationId, action };
      }
      // Action → patch shape
      // approve   → classification_status='finalized', reviewed/finalized timestamps
      // reject    → classification_status='excluded', recoverability_result='excluded'
      // mark_na   → classification_status='excluded', recoverability_result='non_recoverable'
      // resolve   → classification_status='matched' (sends back to normal review)
      const now = new Date().toISOString();
      const patch = { reviewed_at: now };
      if (action === "approve") {
        patch.classification_status = "finalized";
        patch.finalized_at = now;
        patch.exception_type = null;
      } else if (action === "reject") {
        patch.classification_status = "excluded";
        patch.recoverability_result = "excluded";
        patch.exception_type = null;
      } else if (action === "mark_na") {
        patch.classification_status = "excluded";
        patch.recoverability_result = "non_recoverable";
        patch.exception_type = null;
      } else if (action === "resolve") {
        patch.classification_status = "matched";
        patch.exception_type = null;
      }
      await expenseService.updateExpenseClassification(classificationId, patch);
      return { classificationId, action };
    },
    onSuccess: ({ action }) => {
      const label = {
        approve: "Approved", reject: "Rejected", mark_na: "Marked N/A", resolve: "Resolved",
      }[action] || "Updated";
      toast.success(`${label}.`);
      queryClient.invalidateQueries({ queryKey: ["expense-review-exceptions"] });
      queryClient.invalidateQueries({ queryKey: ["expense-review-classifications"] });
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
      queryClient.invalidateQueries({ queryKey: ["expense-projection-finalized"] });
    },
    onError: (err) => {
      toast.error(err?.message || "Could not update classification");
    },
  });

  const subtitle = getScopeSubtitle(scope, {
    default: `${reviewRows.length} classified expense rows under review`,
    portfolio: (portfolio) => `${reviewRows.length} classified expense rows in ${portfolio.name}`,
    property: (property) => `${reviewRows.length} classified expense rows for ${property.name}`,
    building: (building) => `${reviewRows.length} classified expense rows for ${building.name}`,
    unit: (unit) => `${reviewRows.length} classified expense rows for ${unit.unit_number || unit.unit_id_code || "selected unit"}`,
    org: () => `${reviewRows.length} classified expense rows across the organization`,
  });

  const scopedParams = Object.fromEntries(
    Object.entries({
      property: scopeProperty !== "all" ? scopeProperty : undefined,
      building: scopeBuilding !== "all" ? scopeBuilding : undefined,
      unit: scopeUnit !== "all" ? scopeUnit : undefined,
    }).filter(([, value]) => value)
  );
  const classificationUrl = scopedLeaseIds[0]
    ? createPageUrl("LeaseExpenseClassification", { id: scopedLeaseIds[0] })
    : createPageUrl("LeaseExpenseClassification");

  const isLoading = isLoadingRuleSets || isLoadingClassifications;

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader
        icon={ClipboardCheck}
        title="Expense Review"
        subtitle={subtitle}
        iconColor="from-slate-900 to-slate-700"
      >
        <div className="flex gap-2">
          <Link to={classificationUrl}>
            <Button variant="outline" size="sm">
              <FileText className="mr-2 h-4 w-4" />
              Expense Classification
            </Button>
          </Link>
          <Link to={createPageUrl("ExpenseProjection", scopedParams)}>
            <Button size="sm" className="bg-blue-600 hover:bg-blue-700">
              Continue to Projection
            </Button>
          </Link>
        </div>
      </PageHeader>

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

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <MetricCard label="Recoverable Pool" value={`$${(totals.recoverable / 1000).toFixed(1)}K`} sub={`${bucketedExpenses.recoverable.length} rows`} />
        <MetricCard label="Non-Recoverable" value={`$${(totals.nonRecoverable / 1000).toFixed(1)}K`} sub={`${bucketedExpenses.non_recoverable.length} rows`} />
        <MetricCard label="Conditional" value={`$${(totals.conditional / 1000).toFixed(1)}K`} sub={`${bucketedExpenses.conditional.length} rows`} />
        <MetricCard label="Needs Review" value={`$${(totals.needsReview / 1000).toFixed(1)}K`} sub={`${bucketedExpenses.needs_review.length} rows`} />
        <MetricCard label="Lease Rules Ready" value={`${ruleSummary.approvedLeaseCount}`} sub={`${ruleSummary.recoverableCount} recoverable rules`} />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <Card className="border-blue-200 bg-blue-50/60">
          <CardHeader>
            <CardTitle className="text-base">Lease Rule Readiness</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-700">
            <div className="flex flex-wrap gap-2">
              <Badge className="bg-emerald-100 text-emerald-700">{ruleSummary.recoverableCount} recoverable rules</Badge>
              <Badge className="bg-rose-100 text-rose-700">{ruleSummary.nonRecoverableCount} non-recoverable rules</Badge>
              <Badge className="bg-amber-100 text-amber-800">{ruleSummary.conditionalCount} conditional rules</Badge>
              <Badge className="bg-slate-100 text-slate-700">{ruleSummary.needsReviewCount} still need review</Badge>
            </div>
            <p>
              Approved lease rule sets: <span className="font-semibold">{ruleSummary.approvedLeaseCount}</span>
              {" "}of {scopedLeases.length || 0} scoped leases.
            </p>
            <p>
              Draft-only rule sets: <span className="font-semibold">{ruleSummary.draftLeaseCount}</span>.
              These still need yes/no/value review before CAM can rely on them.
            </p>
          </CardContent>
        </Card>

        <Card className={actualExpenses.length > 0 ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50/70"}>
          <CardHeader>
            <CardTitle className="text-base">CAM Input Readiness</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-700">
            {actualExpenses.length === 0 ? (
              <div className="rounded-lg border border-amber-200 bg-white px-4 py-3 text-amber-800">
                No classified actual expense rows found. Run Expense Classification after adding or importing expenses.
              </div>
            ) : (
              <div className="rounded-lg border border-emerald-200 bg-white px-4 py-3 text-emerald-800">
                {actualExpenses.length} actual expense row(s) are available for review before CAM calculation.
              </div>
            )}
            <p>Workflow checks:</p>
            <div className="flex flex-wrap gap-2">
              <Badge className={workflowSummary?.approvedLeaseCount > 0 ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-700"}>
                {workflowSummary?.approvedLeaseCount || 0} approved leases
              </Badge>
              <Badge className={workflowSummary?.approvedRuleLeaseCount > 0 ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-700"}>
                {workflowSummary?.approvedRuleLeaseCount || 0} approved rule sets
              </Badge>
              <Badge className={workflowSummary?.needsReviewCount > 0 ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-700"}>
                {workflowSummary?.needsReviewCount || 0} expenses need review
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Exception Queue (primary review surface, per spec) ───────────── */}
      <Card className="border-amber-200">
        <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-600" />
              Exception Queue
            </CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              Classifications that need a human decision before they're finalized. Approving here promotes the row to <code>finalized</code> and lets it flow into Projection / CAM / Budget.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge className="bg-rose-100 text-rose-800 text-[10px] uppercase">
              {exceptionCounts.unmatched} unmatched
            </Badge>
            <Badge className="bg-amber-100 text-amber-800 text-[10px] uppercase">
              {exceptionCounts.low_confidence} low-confidence
            </Badge>
            <Badge className="bg-amber-100 text-amber-800 text-[10px] uppercase">
              {exceptionCounts.conditional} conditional
            </Badge>
            <Badge className="bg-slate-200 text-slate-700 text-[10px] uppercase">
              {exceptionCounts.other_exception} other
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {isLoadingExceptions ? (
            <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading exceptions…
            </div>
          ) : enrichedExceptions.length === 0 ? (
            <div className="rounded-md border border-dashed border-emerald-200 bg-emerald-50 px-4 py-6 text-center text-sm text-emerald-800">
              <CheckCircle2 className="mx-auto mb-2 h-5 w-5" />
              No exceptions in this scope. Run classification on Expense Classification if you've added new actual expenses.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <Table>
                <TableHeader className="bg-slate-50">
                  <TableRow>
                    <TableHead className="text-[10px] uppercase">Exception</TableHead>
                    <TableHead className="text-[10px] uppercase">Vendor / Invoice</TableHead>
                    <TableHead className="text-[10px] uppercase">Category</TableHead>
                    <TableHead className="text-[10px] uppercase text-right">Amount</TableHead>
                    <TableHead className="text-[10px] uppercase">Reason</TableHead>
                    <TableHead className="text-[10px] uppercase">Confidence</TableHead>
                    <TableHead className="text-[10px] uppercase text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {enrichedExceptions.map((row) => {
                    const exceptionTone =
                      row.classification_status === "unmatched" ? "bg-rose-100 text-rose-800"
                      : row.exception_type === "low_confidence" ? "bg-amber-100 text-amber-800"
                      : row.classification_status === "conditional" ? "bg-amber-100 text-amber-800"
                      : "bg-slate-200 text-slate-700";
                    const exceptionLabel = row.exception_type || row.classification_status;
                    const confidencePct = Number.isFinite(Number(row.confidence_score))
                      ? `${Math.round((Number(row.confidence_score) <= 1 ? Number(row.confidence_score) * 100 : Number(row.confidence_score)))}%`
                      : "—";
                    return (
                      <TableRow key={row.id} className="hover:bg-slate-50">
                        <TableCell>
                          <Badge className={`${exceptionTone} text-[10px] uppercase`}>
                            {String(exceptionLabel || "—").replace(/_/g, " ")}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">
                          <div className="font-medium text-slate-900">{row.expense_vendor || "—"}</div>
                          <div className="text-[10px] text-slate-500">
                            {row.expense_invoice_number ? `#${row.expense_invoice_number} · ` : ""}{row.expense_date || ""}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-slate-700">{row.expense_category || "—"}</TableCell>
                        <TableCell className="text-sm text-right font-mono">
                          {Number.isFinite(Number(row.expense_amount)) ? `$${Math.round(Number(row.expense_amount)).toLocaleString()}` : "—"}
                        </TableCell>
                        <TableCell className="text-xs text-slate-600 max-w-[260px] truncate" title={row.recovery_reason || row.evidence_text || ""}>
                          {row.recovery_reason || row.evidence_text || "—"}
                        </TableCell>
                        <TableCell className="text-xs">{confidencePct}</TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs text-emerald-700 hover:text-emerald-800"
                              onClick={() => exceptionMutation.mutate({ classificationId: row.id, action: "approve" })}
                              disabled={exceptionMutation.isPending}
                              title="Promote to finalized — row flows into Projection / CAM"
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs text-rose-700 hover:text-rose-800"
                              onClick={() => exceptionMutation.mutate({ classificationId: row.id, action: "reject" })}
                              disabled={exceptionMutation.isPending}
                              title="Reject as not recoverable / excluded"
                            >
                              Reject
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs text-slate-600"
                              onClick={() => exceptionMutation.mutate({ classificationId: row.id, action: "mark_na" })}
                              disabled={exceptionMutation.isPending}
                              title="Mark non-recoverable but keep in the books"
                            >
                              N/A
                            </Button>
                            {row.lease_id && (
                              <Link
                                to={createPageUrl("LeaseExpenseClassification", { id: row.lease_id })}
                                className="text-[10px] text-blue-600 underline"
                                title="Open the per-lease classification view"
                              >
                                Open
                              </Link>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Review Buckets <span className="ml-2 text-xs font-normal text-slate-400">(reference — all expenses in scope)</span></CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search tenant, category, vendor, evidence..."
              className="pl-9"
            />
          </div>

          <Tabs defaultValue="recoverable" className="space-y-4">
            <TabsList className="flex flex-wrap h-auto gap-2 bg-transparent p-0">
              <TabsTrigger value="recoverable">Recoverable</TabsTrigger>
              <TabsTrigger value="non_recoverable">Non-Recoverable</TabsTrigger>
              <TabsTrigger value="conditional">Conditional</TabsTrigger>
              <TabsTrigger value="excluded">Excluded</TabsTrigger>
              <TabsTrigger value="needs_review">Needs Review</TabsTrigger>
            </TabsList>

            <TabsContent value="recoverable">
              <ExpenseBucketTable
                bucket="recoverable"
                expenses={filteredBuckets.recoverable}
                scope={scope}
                leases={leases}
                units={allUnits}
                tenants={tenants}
                isLoading={isLoading}
                mutation={reviewMutation}
              />
            </TabsContent>
            <TabsContent value="non_recoverable">
              <ExpenseBucketTable
                bucket="non_recoverable"
                expenses={filteredBuckets.non_recoverable}
                scope={scope}
                leases={leases}
                units={allUnits}
                tenants={tenants}
                isLoading={isLoading}
                mutation={reviewMutation}
              />
            </TabsContent>
            <TabsContent value="conditional">
              <ExpenseBucketTable
                bucket="conditional"
                expenses={filteredBuckets.conditional}
                scope={scope}
                leases={leases}
                units={allUnits}
                tenants={tenants}
                isLoading={isLoading}
                mutation={reviewMutation}
              />
            </TabsContent>
            <TabsContent value="excluded">
              <ExpenseBucketTable
                bucket="excluded"
                expenses={filteredBuckets.excluded}
                scope={scope}
                leases={leases}
                units={allUnits}
                tenants={tenants}
                isLoading={isLoading}
                mutation={reviewMutation}
              />
            </TabsContent>
            <TabsContent value="needs_review">
              <ExpenseBucketTable
                bucket="needs_review"
                expenses={filteredBuckets.needs_review}
                scope={scope}
                leases={leases}
                units={allUnits}
                tenants={tenants}
                isLoading={isLoading}
                mutation={reviewMutation}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

function ExpenseBucketTable({ expenses, scope, leases = [], units = [], tenants = [], isLoading, mutation }) {
  return (
    <Card className="border-slate-200/80">
      <Table>
        <TableHeader>
          <TableRow className="bg-slate-50">
            <TableHead className="text-[10px] font-bold tracking-wider">EXPENSE</TableHead>
            <TableHead className="text-[10px] font-bold tracking-wider">SCOPE</TableHead>
            <TableHead className="text-[10px] font-bold tracking-wider">MATCHED RULE</TableHead>
            <TableHead className="text-[10px] font-bold tracking-wider">EVIDENCE</TableHead>
            <TableHead className="text-[10px] font-bold tracking-wider text-right">AMOUNT</TableHead>
            <TableHead className="text-[10px] font-bold tracking-wider">STATUS</TableHead>
            <TableHead className="text-[10px] font-bold tracking-wider text-right">ACTIONS</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={7} className="py-10 text-center">
                <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" />
              </TableCell>
            </TableRow>
          ) : expenses.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-400">
                No expenses in this review bucket yet.
              </TableCell>
            </TableRow>
          ) : (
            expenses.map((expense) => {
              const property = expense.property_id ? scope.propertyById.get(expense.property_id) ?? null : null;
              const building = expense.building_id ? scope.buildingById.get(expense.building_id) ?? null : null;
              const unit = expense.unit_id ? scope.unitById.get(expense.unit_id) ?? null : null;
              const reviewStatus = normalizeBucket(expense);
              // Surface a tooltip-friendly diagnostic when tenant cannot be
              // resolved. Mirrors the behavior on Actual Expenses and
              // Expense Classification pages.
              const tenantResolution = resolveTenantForExpense(expense, {
                leases,
                units,
                tenants,
              });
              const tenantOrVendor = tenantResolution.tenant?.name || expense.vendor_name || expense.vendor || null;

              return (
                <TableRow key={expense.id}>
                  <TableCell className="text-xs">
                    <div className="font-medium text-slate-900">{expense.description || expense.category || "Expense"}</div>
                    {tenantOrVendor ? (
                      <div
                        className="mt-1 text-slate-500"
                        title={
                          tenantResolution.tenant?.name
                            ? `Tenant resolved via ${tenantResolution.source}`
                            : "No tenant linked — showing vendor"
                        }
                      >
                        {tenantOrVendor}
                      </div>
                    ) : (
                      <div
                        className="mt-1 inline-flex items-center gap-1 text-slate-400"
                        title={
                          tenantResolution.reasonText
                            ? `No tenant linked: ${tenantResolution.reasonText}`
                            : "No tenant or vendor linked"
                        }
                      >
                        — <span className="text-amber-500">⚠</span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-slate-600">
                    {[property?.name, building?.name, unit?.unit_number || unit?.unit_id_code].filter(Boolean).join(" / ") || "Unscoped"}
                  </TableCell>
                  <TableCell className="text-xs text-slate-600">
                    {expense.recovery_rule_id ? (
                      <Link to={createPageUrl("LeaseExpenseClassification", { id: expense.lease_id })} className="text-blue-600 hover:underline">
                        {expense.rule_source || "lease"} rule
                      </Link>
                    ) : (
                      "Default / manual"
                    )}
                  </TableCell>
                  <TableCell className="max-w-xs text-xs text-slate-500">
                    <div className="line-clamp-2">{expense.evidence_text || "No supporting evidence saved yet."}</div>
                  </TableCell>
                  <TableCell className="text-right text-xs font-semibold tabular-nums">
                    ${(expense.amount || 0).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Badge className={getRecoveryTone(reviewStatus)}>
                      {reviewStatus.replaceAll("_", "-")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => mutation.mutate({ classificationId: expense.id, recoveryStatus: reviewStatus, approvedStatus: "approved" })}
                      >
                        <CheckCircle2 className="mr-1 h-4 w-4" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => mutation.mutate({ classificationId: expense.id, recoveryStatus: "recoverable", approvedStatus: "needs_review" })}
                      >
                        Mark Recoverable
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => mutation.mutate({ classificationId: expense.id, recoveryStatus: "non_recoverable", approvedStatus: "needs_review" })}
                      >
                        Mark Non-Recoverable
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => mutation.mutate({ classificationId: expense.id, recoveryStatus: "conditional", approvedStatus: "needs_review" })}
                      >
                        <ShieldAlert className="mr-1 h-4 w-4" />
                        Mark Conditional
                      </Button>
                      {expense.lease_id && (
                        <Link to={createPageUrl("LeaseExpenseClassification", { id: expense.lease_id })}>
                          <Button size="sm" variant="outline">
                            Edit Rule
                          </Button>
                        </Link>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => mutation.mutate({ classificationId: expense.id, recoveryStatus: reviewStatus, approvedStatus: "rejected" })}
                      >
                        Reject
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
  );
}
