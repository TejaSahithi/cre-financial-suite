import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  FileSearch,
  LayoutDashboard,
  Receipt,
  Scale,
} from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

import PageHeader from "@/components/PageHeader";
import ScopeSelector from "@/components/ScopeSelector";
import MetricCard from "@/components/MetricCard";
import ModuleLink from "@/components/ModuleLink";
import useOrgQuery from "@/hooks/useOrgQuery";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createPageUrl } from "@/utils";
import { buildHierarchyScope, getScopeSubtitle, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function isApproved(value) {
  return normalizeStatus(value) === "approved";
}

function isExceptionRow(row) {
  const classificationStatus = normalizeStatus(row?.classification_status);
  const recoveryStatus = normalizeStatus(row?.recoverability_result || row?.recovery_status);
  const exceptionType = normalizeStatus(row?.exception_type);
  return (
    ["unmatched", "exception", "conditional"].includes(classificationStatus) ||
    recoveryStatus === "needs_review" ||
    (exceptionType && exceptionType !== "none")
  );
}

function isFinalizedRow(row) {
  return Boolean(row?.finalized_at) || normalizeStatus(row?.classification_status) === "finalized";
}

function isCamReadyRow(row) {
  const recoverability = normalizeStatus(row?.recoverability_result || row?.recovery_status);
  const camEligible = normalizeStatus(row?.cam_eligible);
  const approved = normalizeStatus(row?.approved_status);
  const status = normalizeStatus(row?.classification_status);
  return (
    approved === "approved" &&
    (status === "finalized" || Boolean(row?.finalized_at)) &&
    recoverability === "recoverable" &&
    ["yes", "true"].includes(camEligible) &&
    !row?.sent_to_cam &&
    Number(row?.amount || 0) > 0
  );
}

function sumBucket(rows, bucketKey, fallbackRecoveryStatus) {
  return rows.reduce((sum, row) => {
    const bucketValue = Number(row?.[bucketKey]);
    if (Number.isFinite(bucketValue)) {
      return sum + bucketValue;
    }
    const recoveryStatus = normalizeStatus(row?.recoverability_result || row?.recovery_status);
    if (recoveryStatus === fallbackRecoveryStatus) {
      return sum + Number(row?.amount || 0);
    }
    return sum;
  }, 0);
}

export default function ExpenseDashboard() {
  const location = useLocation();
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");

  const { data: expenses = [] } = useOrgQuery("Expense");
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
    return expense.source_type !== "lease_import" && expense.source !== "lease_import";
  });

  const selectorScopedExpenseIds = useMemo(
    () => selectorScopedExpenses.map((expense) => expense.id).filter(Boolean),
    [selectorScopedExpenses]
  );

  const selectorScopedLeases = leases.filter((lease) => {
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

    if (scopeBuilding !== "all") {
      const leaseUnit = lease.unit_id ? scope.unitById.get(lease.unit_id) ?? null : null;
      const leaseBuildingId = lease.building_id || leaseUnit?.building_id || null;
      if (leaseBuildingId !== scopeBuilding) return false;
    }

    if (scopeUnit !== "all" && lease.unit_id !== scopeUnit) return false;
    return true;
  });

  const selectorScopedLeaseIds = useMemo(
    () => selectorScopedLeases.map((lease) => lease.id).filter(Boolean),
    [selectorScopedLeases]
  );



  const allLeaseIds = useMemo(() => leases.map((l) => l.id), [leases]);
  const ruleLeaseIds = useMemo(() => {
    if (selectorScopedLeaseIds.length > 0) return selectorScopedLeaseIds;
    return allLeaseIds;
  }, [selectorScopedLeaseIds, allLeaseIds]);

  const { data: selectorScopedRuleSets = [] } = useQuery({
    queryKey: ["expense-dashboard-summary-rule-sets", ruleLeaseIds.slice(0, 50).join("|")],
    queryFn: () => leaseExpenseRuleService.loadRuleSets(ruleLeaseIds.slice(0, 50)),
    enabled: ruleLeaseIds.length > 0,
  });

  const displayedExpenses = useMemo(
    () =>
      selectorScopedExpenses.map((expense) => {
        const effectiveRecovery = expense.recoverability_result || expense.recovery_status || expense.classification || "needs_review";
        return {
          ...expense,
          recovery_status: effectiveRecovery,
          recoverability_result: effectiveRecovery,
          classification: effectiveRecovery === "excluded" ? "non_recoverable" : effectiveRecovery,
        };
      }),
    [selectorScopedExpenses]
  );

  const approvedActuals = useMemo(
    () => displayedExpenses.filter((expense) => isApproved(expense.approved_status || expense.approval_status || expense.review_status)),
    [displayedExpenses]
  );

  const approvedRuleEntries = useMemo(
    () => selectorScopedRuleSets.filter((entry) => isApproved(entry?.ruleSet?.status || entry?.ruleSet?.approval_status || entry?.ruleSet?.review_status)),
    [selectorScopedRuleSets]
  );

  const approvedRules = useMemo(
    () => approvedRuleEntries.flatMap((entry) => entry.rules || []),
    [approvedRuleEntries]
  );

  const summary = useMemo(() => {
    // Only count approved expenses for classification breakdown
    const classifiedRows = approvedActuals;
    const recoverableRows = classifiedRows.filter((row) => normalizeStatus(row.classification || row.recovery_status) === "recoverable");
    const nonRecoverableRows = classifiedRows.filter((row) => normalizeStatus(row.classification || row.recovery_status) === "non_recoverable");
    const conditionalRows = classifiedRows.filter((row) => normalizeStatus(row.classification || row.recovery_status) === "conditional");
    const excludedRows = classifiedRows.filter((row) => normalizeStatus(row.classification || row.recovery_status) === "excluded");
    const exceptionRows = classifiedRows.filter(isExceptionRow);
    const finalizedRows = classifiedRows.filter(isFinalizedRow);
    const camReadyRows = classifiedRows.filter(isCamReadyRow);

    return {
      approvedActualCount: approvedActuals.length,
      approvedActualAmount: approvedActuals.reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
      approvedRuleCount: approvedRules.length,
      approvedRuleSetCount: approvedRuleEntries.length,
      classificationCount: classifiedRows.length,
      recoverableCount: recoverableRows.length,
      recoverableAmount: recoverableRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      nonRecoverableCount: nonRecoverableRows.length,
      nonRecoverableAmount: nonRecoverableRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      conditionalCount: conditionalRows.length,
      conditionalAmount: conditionalRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      excludedCount: excludedRows.length,
      excludedAmount: excludedRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      exceptionCount: exceptionRows.length,
      finalizedCount: finalizedRows.length,
      finalizedAmount: finalizedRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      camReadyCount: camReadyRows.length,
      camReadyAmount: camReadyRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    };
  }, [approvedActuals, approvedRuleEntries, approvedRules]);

  const pieData = [
    { name: "Recoverable", value: summary.recoverableAmount, color: "#10b981" },
    { name: "Non-Recoverable", value: summary.nonRecoverableAmount, color: "#ef4444" },
    { name: "Conditional", value: summary.conditionalAmount, color: "#f59e0b" },
    { name: "Excluded", value: summary.excludedAmount, color: "#64748b" },
  ].filter((entry) => entry.value > 0);

  const scopedParams = {
    property: scopeProperty !== "all" ? scopeProperty : undefined,
    building: scopeBuilding !== "all" ? scopeBuilding : undefined,
    unit: scopeUnit !== "all" ? scopeUnit : undefined,
  };

  const subtitle = getScopeSubtitle(scope, {
    default: "Read-only workflow summary for approved actuals, approved lease rules, classification status, and CAM candidates.",
    portfolio: (portfolio) => `Workflow summary for ${portfolio.name}`,
    property: (property) => `Workflow summary for ${property.name}`,
    building: (building) => `Workflow summary for ${building.name}`,
    unit: (unit) => `Workflow summary for ${unit.unit_number || unit.unit_id_code || "selected unit"}`,
    org: () => "Workflow summary for the selected organization scope",
  });

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.group("[ExpenseDashboard] diagnostic");
    console.table({
      scoped_actual_expenses: selectorScopedExpenses.length,
      approved_actual_expenses: summary.approvedActualCount,
      approved_actual_amount: summary.approvedActualAmount,
      scoped_leases: selectorScopedLeases.length,
      approved_rule_sets: summary.approvedRuleSetCount,
      approved_rules: summary.approvedRuleCount,
      classification_rows: summary.classificationCount,
      recoverable_amount: summary.recoverableAmount,
      non_recoverable_amount: summary.nonRecoverableAmount,
      conditional_amount: summary.conditionalAmount,
      excluded_amount: summary.excludedAmount,
      exception_rows: summary.exceptionCount,
      finalized_rows: summary.finalizedCount,
      cam_ready_rows: summary.camReadyCount,
    });
    console.groupEnd();
  }, [selectorScopedExpenses.length, selectorScopedLeases.length, summary]);

  const workflowReady = summary.approvedRuleCount > 0 && summary.approvedActualCount > 0;

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader
        icon={LayoutDashboard}
        title="Expense Dashboard"
        subtitle={subtitle}
        iconColor="from-sky-500 to-blue-600"
      >
        <div className="flex gap-2">
          <ModuleLink page="LeaseExpenseRules">
            <Button variant="outline" size="sm">
              <ClipboardCheck className="w-4 h-4 mr-1" />
              Lease Expense Rules
            </Button>
          </ModuleLink>
          <ModuleLink page="Expenses">
            <Button size="sm" className="bg-gradient-to-r from-sky-500 to-blue-600 shadow-sm">
              <Receipt className="w-4 h-4 mr-1" />
              Actual Expenses
            </Button>
          </ModuleLink>
        </div>
      </PageHeader>

      <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
        This dashboard is read-only by design. It summarizes approved actual expenses, approved lease expense rules,
        classification results, exceptions, and CAM readiness without mutating workflow state on page load.
      </div>

      <ScopeSelector
        portfolios={scope.orgScopedPortfolios}
        properties={scope.scopedProperties}
        buildings={scope.scopedBuildings}
        units={scope.scopedUnits}
        selectedProperty={scopeProperty}
        selectedBuilding={scopeBuilding}
        selectedUnit={scopeUnit}
        onPropertyChange={setScopeProperty}
        onBuildingChange={setScopeBuilding}
        onUnitChange={setScopeUnit}
        syncToUrl
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <MetricCard
          label="Approved Actuals"
          value={String(summary.approvedActualCount)}
          sub={summary.approvedActualCount > 0 ? `$${summary.approvedActualAmount.toLocaleString()} loaded` : "No approved actuals in scope"}
          icon={Receipt}
          color="bg-slate-100 text-slate-700"
        />
        <MetricCard
          label="Approved Lease Rules"
          value={String(summary.approvedRuleCount)}
          sub={summary.approvedRuleSetCount > 0 ? `${summary.approvedRuleSetCount} approved rule set(s)` : "No approved rules in scope"}
          icon={ClipboardCheck}
          color="bg-emerald-50 text-emerald-700"
        />
        <MetricCard
          label="Recoverable Costs"
          value={`$${(summary.recoverableAmount / 1000).toFixed(1)}K`}
          sub={`${summary.recoverableCount} classified row(s)`}
          icon={Scale}
          color="bg-emerald-50 text-emerald-700"
        />
        <MetricCard
          label="Exceptions"
          value={String(summary.exceptionCount)}
          sub={summary.exceptionCount > 0 ? "Needs Expense Review" : "No active exceptions"}
          icon={AlertTriangle}
          color="bg-amber-50 text-amber-700"
        />
        <MetricCard
          label="CAM Candidates"
          value={String(summary.camReadyCount)}
          sub={summary.camReadyCount > 0 ? `$${summary.camReadyAmount.toLocaleString()} awaiting publish` : "No publish candidates"}
          icon={CheckCircle2}
          color="bg-blue-50 text-blue-700"
        />
      </div>

      <div className="grid lg:grid-cols-[1.4fr,1fr] gap-6">
        <Card className="border-slate-200">
          <CardHeader>
            <CardTitle className="text-base">Classification Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="grid md:grid-cols-[280px,1fr] gap-4">
            <div className="h-60">
              {pieData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={62} outerRadius={92}>
                      {pieData.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value) => `$${Number(value || 0).toLocaleString()}`} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full rounded-xl border border-dashed border-slate-200 bg-slate-50 flex items-center justify-center text-sm text-slate-500 text-center px-6">
                  No persisted classification amounts in this scope yet. Approve actuals and run Expense Classification to populate this view.
                </div>
              )}
            </div>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Badge className="bg-emerald-100 text-emerald-700">{summary.recoverableCount} recoverable</Badge>
                <Badge className="bg-rose-100 text-rose-700">{summary.nonRecoverableCount} non-recoverable</Badge>
                <Badge className="bg-amber-100 text-amber-800">{summary.conditionalCount} conditional</Badge>
                <Badge className="bg-slate-200 text-slate-700">{summary.excludedCount} excluded</Badge>
                <Badge className="bg-blue-100 text-blue-700">{summary.finalizedCount} finalized</Badge>
              </div>
              <div className="grid sm:grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl border border-slate-200 p-3">
                  <div className="text-slate-500">Recoverable</div>
                  <div className="mt-1 text-xl font-semibold text-slate-900">${summary.recoverableAmount.toLocaleString()}</div>
                </div>
                <div className="rounded-xl border border-slate-200 p-3">
                  <div className="text-slate-500">Non-Recoverable</div>
                  <div className="mt-1 text-xl font-semibold text-slate-900">${summary.nonRecoverableAmount.toLocaleString()}</div>
                </div>
                <div className="rounded-xl border border-slate-200 p-3">
                  <div className="text-slate-500">Conditional</div>
                  <div className="mt-1 text-xl font-semibold text-slate-900">${summary.conditionalAmount.toLocaleString()}</div>
                </div>
                <div className="rounded-xl border border-slate-200 p-3">
                  <div className="text-slate-500">Excluded</div>
                  <div className="mt-1 text-xl font-semibold text-slate-900">${summary.excludedAmount.toLocaleString()}</div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-blue-200 bg-blue-50/60">
          <CardHeader>
            <CardTitle className="text-base">Workflow Readiness</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl border border-white/70 bg-white/80 p-3 text-sm text-slate-700">
              {workflowReady ? (
                <span>
                  Approved actual expenses and approved lease rules are both present in this scope. The workflow is ready for
                  classification, review, finalization, and CAM handoff.
                </span>
              ) : (
                <span>
                  Upstream approvals are still incomplete in this scope. Finish approving lease expense rules and actual expenses
                  before expecting stable classification and CAM totals.
                </span>
              )}
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between rounded-lg border border-white/70 bg-white/80 px-3 py-2">
                <span>Approved actual expenses</span>
                <span className="font-medium">{summary.approvedActualCount}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-white/70 bg-white/80 px-3 py-2">
                <span>Approved lease rules</span>
                <span className="font-medium">{summary.approvedRuleCount}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-white/70 bg-white/80 px-3 py-2">
                <span>Classification rows</span>
                <span className="font-medium">{summary.classificationCount}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-white/70 bg-white/80 px-3 py-2">
                <span>Needs review / exceptions</span>
                <span className="font-medium">{summary.exceptionCount}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-white/70 bg-white/80 px-3 py-2">
                <span>Finalized rows</span>
                <span className="font-medium">{summary.finalizedCount}</span>
              </div>
            </div>

            <div className="grid gap-2">
              <Link to={createPageUrl("Expenses", scopedParams)}>
                <Button variant="outline" className="w-full justify-between bg-white">
                  Actual Expenses
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              <Link to={createPageUrl("LeaseExpenseRules", scopedParams)}>
                <Button variant="outline" className="w-full justify-between bg-white">
                  Lease Expense Rules
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              <Link to={createPageUrl("ExpenseReview", scopedParams)}>
                <Button variant="outline" className="w-full justify-between bg-white">
                  Expense Review
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              <Link to={createPageUrl("ExpenseProjection", scopedParams)}>
                <Button variant="outline" className="w-full justify-between bg-white">
                  Expense Projection
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              <Link to={createPageUrl("LeaseExpenseClassification", selectorScopedLeaseIds[0] ? { id: selectorScopedLeaseIds[0] } : {})}>
                <Button variant="outline" className="w-full justify-between bg-white">
                  Expense Classification
                  <FileSearch className="w-4 h-4" />
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
