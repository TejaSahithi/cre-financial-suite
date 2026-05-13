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

function normalizeBucket(expense) {
  const status = String(expense?.recovery_status || expense?.classification || "needs_review").toLowerCase();
  if (status === "recoverable") return "recoverable";
  if (["non_recoverable", "excluded"].includes(status)) return status;
  if (status === "conditional") return "conditional";
  return "needs_review";
}

function toAmount(expense) {
  return Number(expense?.amount || 0);
}

function filterExpenseByScope(expense, scope, propertyId, buildingId, unitId) {
  if (
    !matchesHierarchyScope(expense, scope, {
      portfolioKey: "portfolio_id",
      propertyKey: "property_id",
      buildingKey: "building_id",
      unitKey: "unit_id",
    })
  ) {
    return false;
  }

  if (propertyId !== "all" && expense.property_id !== propertyId) return false;
  if (buildingId !== "all" && expense.building_id !== buildingId) return false;
  if (unitId !== "all" && expense.unit_id !== unitId) return false;
  return true;
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

  const { data: expenses = [], isLoading: isLoadingExpenses } = useOrgQuery("Expense");
  const { data: leases = [] } = useOrgQuery("Lease");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: allBuildings = [] } = useOrgQuery("Building");
  const { data: allUnits = [] } = useOrgQuery("Unit");
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

  const scopedExpenses = expenses.filter((expense) =>
    filterExpenseByScope(expense, scope, scopeProperty, scopeBuilding, scopeUnit)
  );

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
    enabled: Boolean(scopeProperty !== "all" || scope.propertyId),
  });

  const actualExpenses = scopedExpenses.filter((expense) => expense.source_type !== "lease_import");
  const bucketedExpenses = useMemo(() => {
    return scopedExpenses.reduce((accumulator, expense) => {
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
  }, [scopedExpenses]);

  const ruleSummary = useMemo(() => {
    const allRules = scopedRuleSets.flatMap((entry) => entry.rules || []);
    const grouped = leaseExpenseRuleService.groupRulesByRecoveryStatus(allRules);
    return {
      approvedLeaseCount: scopedRuleSets.filter((entry) => entry.ruleSet?.status === "approved").length,
      draftLeaseCount: scopedRuleSets.filter((entry) => entry.ruleSet?.status !== "approved").length,
      recoverableCount: grouped.recoverable.length,
      nonRecoverableCount: grouped.nonRecoverable.length,
      conditionalCount: grouped.conditional.length,
      needsReviewCount: grouped.needsReview.length,
    };
  }, [scopedRuleSets]);

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
    mutationFn: async ({ expenseId, recoveryStatus, approvedStatus }) => {
      const classification = recoveryStatus === "excluded" ? "non_recoverable" : recoveryStatus;
      return expenseService.update(expenseId, {
        recovery_status: recoveryStatus,
        classification,
        approved_status: approvedStatus,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["Expense"] });
      toast.success("Expense review updated.");
    },
    onError: (error) => {
      toast.error(error?.message || "Could not update expense review.");
    },
  });

  const subtitle = getScopeSubtitle(scope, {
    default: `${scopedExpenses.length} expense rows under review`,
    portfolio: (portfolio) => `${scopedExpenses.length} expense rows in ${portfolio.name}`,
    property: (property) => `${scopedExpenses.length} expense rows for ${property.name}`,
    building: (building) => `${scopedExpenses.length} expense rows for ${building.name}`,
    unit: (unit) => `${scopedExpenses.length} expense rows for ${unit.unit_number || unit.unit_id_code || "selected unit"}`,
    org: () => `${scopedExpenses.length} expense rows across the organization`,
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

  const isLoading = isLoadingExpenses || isLoadingRuleSets;

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
                No actual expenses found. Upload expenses, import GL, import invoices, or add manual expenses before CAM calculation.
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

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Review Buckets</CardTitle>
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
                isLoading={isLoading}
                mutation={reviewMutation}
              />
            </TabsContent>
            <TabsContent value="non_recoverable">
              <ExpenseBucketTable
                bucket="non_recoverable"
                expenses={filteredBuckets.non_recoverable}
                scope={scope}
                isLoading={isLoading}
                mutation={reviewMutation}
              />
            </TabsContent>
            <TabsContent value="conditional">
              <ExpenseBucketTable
                bucket="conditional"
                expenses={filteredBuckets.conditional}
                scope={scope}
                isLoading={isLoading}
                mutation={reviewMutation}
              />
            </TabsContent>
            <TabsContent value="excluded">
              <ExpenseBucketTable
                bucket="excluded"
                expenses={filteredBuckets.excluded}
                scope={scope}
                isLoading={isLoading}
                mutation={reviewMutation}
              />
            </TabsContent>
            <TabsContent value="needs_review">
              <ExpenseBucketTable
                bucket="needs_review"
                expenses={filteredBuckets.needs_review}
                scope={scope}
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

function ExpenseBucketTable({ expenses, scope, isLoading, mutation }) {
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

              return (
                <TableRow key={expense.id}>
                  <TableCell className="text-xs">
                    <div className="font-medium text-slate-900">{expense.description || expense.category || "Expense"}</div>
                    <div className="mt-1 text-slate-500">{expense.tenant_name || expense.vendor_name || expense.vendor || "—"}</div>
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
                        onClick={() => mutation.mutate({ expenseId: expense.id, recoveryStatus: reviewStatus, approvedStatus: "approved" })}
                      >
                        <CheckCircle2 className="mr-1 h-4 w-4" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => mutation.mutate({ expenseId: expense.id, recoveryStatus: "recoverable", approvedStatus: "needs_review" })}
                      >
                        Mark Recoverable
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => mutation.mutate({ expenseId: expense.id, recoveryStatus: "non_recoverable", approvedStatus: "needs_review" })}
                      >
                        Mark Non-Recoverable
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => mutation.mutate({ expenseId: expense.id, recoveryStatus: "conditional", approvedStatus: "needs_review" })}
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
                        onClick={() => mutation.mutate({ expenseId: expense.id, recoveryStatus: reviewStatus, approvedStatus: "rejected" })}
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
