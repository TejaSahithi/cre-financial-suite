import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRightCircle,
  Check,
  CheckCircle,
  FileText,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import useOrgQuery from "@/hooks/useOrgQuery";
import useOrgId from "@/hooks/useOrgId";
import { buildHierarchyScope, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import { expenseService } from "@/services/expenseService";
import { useAuth } from "@/lib/AuthContext";
import { getStoredActingOrgId } from "@/lib/actingOrg";
import { createPageUrl } from "@/utils";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function fmt(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value) || 0);
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function humanize(value) {
  const text = String(value || "").replace(/[_-]+/g, " ").trim();
  if (!text) return "-";
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

function toNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function buildAmountBuckets(amount, recoverabilityResult) {
  const numericAmount = toNumber(amount);
  return {
    recoverable_amount: recoverabilityResult === "recoverable" ? numericAmount : 0,
    non_recoverable_amount: recoverabilityResult === "non_recoverable" ? numericAmount : 0,
    conditional_amount: recoverabilityResult === "conditional" ? numericAmount : 0,
    excluded_amount: recoverabilityResult === "excluded" ? numericAmount : 0,
  };
}

function leaseCoversYear(lease, fiscalYear) {
  if (!fiscalYear || fiscalYear === "all") return true;

  const start = lease?.start_date ? new Date(`${lease.start_date}T00:00:00`) : null;
  const end = lease?.end_date ? new Date(`${lease.end_date}T23:59:59`) : null;
  const yearStart = new Date(Number(fiscalYear), 0, 1);
  const yearEnd = new Date(Number(fiscalYear), 11, 31, 23, 59, 59);

  if (start && Number.isNaN(start.getTime())) return true;
  if (end && Number.isNaN(end.getTime())) return true;
  if (start && start > yearEnd) return false;
  if (end && end < yearStart) return false;
  return true;
}

function recoverabilityBadge(result) {
  if (result === "recoverable") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (result === "non_recoverable") return "bg-rose-50 text-rose-700 border-rose-200";
  if (result === "conditional") return "bg-amber-50 text-amber-700 border-amber-200";
  if (result === "excluded") return "bg-slate-200 text-slate-700 border-slate-300";
  return "bg-slate-100 text-slate-600 border-slate-200";
}

function statusBadge(status) {
  if (status === "finalized") return "bg-indigo-50 text-indigo-700 border-indigo-200";
  if (status === "matched") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "conditional") return "bg-amber-50 text-amber-700 border-amber-200";
  if (status === "unmatched" || status === "exception") return "bg-rose-50 text-rose-700 border-rose-200";
  if (status === "coverage_gap") return "bg-blue-50 text-blue-700 border-blue-200";
  if (status === "excluded") return "bg-slate-100 text-slate-700 border-slate-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function rowTypeLabel(rowType) {
  if (rowType === "matched_classification") return "Matched";
  if (rowType === "actual_missing_rule") return "Actual Missing Rule";
  if (rowType === "rule_missing_actual") return "Rule Missing Actual";
  return humanize(rowType);
}

export default function LeaseExpenseClassification() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { orgId: resolvedOrgId } = useOrgId();
  const preselectedLeaseId = useMemo(
    () => new URLSearchParams(location.search).get("id") || "all",
    [location.search]
  );

  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");
  const [scopeLease, setScopeLease] = useState(preselectedLeaseId);
  const [scopeTenant, setScopeTenant] = useState("all");
  const [scopeYear, setScopeYear] = useState("all");
  const [activeTab, setActiveTab] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set());

  const { data: leases = [], isLoading: loadingLeases } = useOrgQuery("Lease");
  const { data: tenants = [] } = useOrgQuery("Tenant");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");

  const scope = useMemo(
    () => buildHierarchyScope({ search: "", portfolios: [], properties, buildings, units }),
    [properties, buildings, units]
  );

  const scopedLeases = useMemo(() => {
    return leases.filter((lease) => {
      if (!matchesHierarchyScope(lease, scope, { propertyKey: "property_id", unitKey: "unit_id" })) return false;
      if (scopeProperty !== "all" && lease.property_id !== scopeProperty) return false;
      const unit = lease.unit_id ? scope.unitById.get(lease.unit_id) ?? null : null;
      const buildingId = unit?.building_id || lease.building_id || null;
      if (scopeBuilding !== "all" && buildingId !== scopeBuilding) return false;
      if (scopeUnit !== "all" && lease.unit_id !== scopeUnit) return false;
      if (scopeLease !== "all" && lease.id !== scopeLease) return false;
      if (scopeTenant !== "all" && lease.tenant_id !== scopeTenant) return false;
      if (!leaseCoversYear(lease, scopeYear)) return false;
      return true;
    });
  }, [leases, scope, scopeProperty, scopeBuilding, scopeUnit, scopeLease, scopeTenant, scopeYear]);

  const leaseById = useMemo(() => new Map(leases.map((lease) => [lease.id, lease])), [leases]);
  const propertyById = useMemo(() => new Map(properties.map((property) => [property.id, property])), [properties]);
  const buildingById = useMemo(() => new Map(buildings.map((building) => [building.id, building])), [buildings]);
  const unitById = useMemo(() => new Map(units.map((unit) => [unit.id, unit])), [units]);

  useEffect(() => {
    if (!preselectedLeaseId || preselectedLeaseId === "all") return;
    const lease = leases.find((item) => item.id === preselectedLeaseId);
    if (!lease) return;

    setScopeLease(preselectedLeaseId);
    if (lease.property_id) setScopeProperty(lease.property_id);
    if (lease.tenant_id) setScopeTenant(lease.tenant_id);
    if (lease.unit_id) setScopeUnit(lease.unit_id);
    if (lease.building_id) {
      setScopeBuilding(lease.building_id);
      return;
    }
    const leaseUnit = lease.unit_id ? unitById.get(lease.unit_id) ?? null : null;
    if (leaseUnit?.building_id) {
      setScopeBuilding(leaseUnit.building_id);
    }
  }, [leases, preselectedLeaseId, unitById]);

  const scopePayload = useMemo(() => ({
    property_id: scopeProperty,
    building_id: scopeBuilding,
    unit_id: scopeUnit,
    lease_id: scopeLease,
    tenant_id: scopeTenant,
    fiscal_year: scopeYear,
  }), [scopeProperty, scopeBuilding, scopeUnit, scopeLease, scopeTenant, scopeYear]);

  const {
    data: workspace = { approvedRules: [], approvedActuals: [], existingClassifications: [], summary: {} },
    isLoading: loadingWorkspace,
  } = useQuery({
    queryKey: ["expense-recoverability-workspace", scopeProperty, scopeBuilding, scopeUnit, scopeLease, scopeTenant, scopeYear],
    queryFn: () => expenseService.loadExpenseRecoverabilityScope(scopePayload),
  });

  const { data: diagnostics = null } = useQuery({
    queryKey: ["expense-recoverability-diagnostics", scopeProperty, scopeBuilding, scopeUnit, scopeLease, scopeTenant, scopeYear],
    queryFn: () => expenseService.loadExpenseRecoverabilityDiagnostics(scopePayload),
  });

  const approvedActuals = workspace.approvedActuals || [];
  const approvedRules = workspace.approvedRules || [];
  const existingClassifications = workspace.existingClassifications || [];

  const rows = useMemo(() => {
    const result = [];
    const classificationByExpenseId = new Map();
    const approvedRuleById = new Map(approvedRules.map((rule) => [rule.id, rule]));
    const rulesByLeaseId = new Map();
    const usedRuleIds = new Set();
    const candidateLeases = scopedLeases.length > 0 ? scopedLeases : leases.filter((lease) => leaseCoversYear(lease, scopeYear));

    for (const classification of existingClassifications) {
      const expenseId = classification.expense_id || classification.actual_expense_id;
      if (expenseId && !classificationByExpenseId.has(expenseId)) {
        classificationByExpenseId.set(expenseId, classification);
      }
    }

    for (const rule of approvedRules) {
      const leaseId = rule.rule_set?.lease_id || rule.lease_id;
      const list = rulesByLeaseId.get(leaseId) || [];
      list.push(rule);
      rulesByLeaseId.set(leaseId, list);
    }

    for (const expense of approvedActuals) {
      const classificationRecord = classificationByExpenseId.get(expense.id) || null;
      const persistedRuleId =
        classificationRecord?.lease_expense_rule_id ||
        classificationRecord?.linked_expense_rule_id ||
        classificationRecord?.recovery_rule_id ||
        expense.linked_expense_rule_id ||
        expense.recovery_rule_id ||
        null;
      let matchedRule = persistedRuleId ? approvedRuleById.get(persistedRuleId) || null : null;
      let matchedLease = matchedRule ? leaseById.get(matchedRule.lease_id || matchedRule.rule_set?.lease_id) || null : null;
      let match = null;

      if (!matchedRule) {
        match = expenseService.matchActualExpenseToLeaseRule(expense, {
          leases: candidateLeases,
          rulesByLeaseId,
        });
        matchedRule = match?.rule || null;
        matchedLease = match?.lease || matchedLease;
      }

      const actualAmount = toNumber(expense.amount);
      const hasMatchedRule = Boolean(matchedRule);
      if (matchedRule?.id) usedRuleIds.add(matchedRule.id);

      const recoverabilityResult = hasMatchedRule
        ? normalizeText(
            classificationRecord?.recoverability_result ||
            classificationRecord?.recovery_status ||
            expense.recoverability_result ||
            expense.recovery_status ||
            match?.recoverability_result ||
            "needs_review"
          )
        : "needs_review";
      const classificationStatus = hasMatchedRule
        ? normalizeText(
            classificationRecord?.classification_status ||
            (recoverabilityResult === "conditional"
              ? "conditional"
              : recoverabilityResult === "excluded" || recoverabilityResult === "non_recoverable"
                ? "excluded"
                : "matched")
          )
        : "unmatched";
      const exceptionType = hasMatchedRule
        ? classificationRecord?.exception_type || null
        : "no_matching_rule";
      const camEligible = hasMatchedRule
        ? normalizeText(
            classificationRecord?.cam_eligible ||
            leaseExpenseRuleService.getCamEligibleDecision(matchedRule) ||
            "no"
          )
        : "no";
      const amountBuckets = hasMatchedRule
        ? {
            recoverable_amount: toNumber(classificationRecord?.recoverable_amount),
            non_recoverable_amount: toNumber(classificationRecord?.non_recoverable_amount),
            conditional_amount: toNumber(classificationRecord?.conditional_amount),
            excluded_amount: toNumber(classificationRecord?.excluded_amount),
          }
        : buildAmountBuckets(0, "needs_review");
      const lease = matchedLease || (expense.lease_id ? leaseById.get(expense.lease_id) || null : null);
      const property = propertyById.get(expense.property_id || lease?.property_id) || null;
      const building = buildingById.get(expense.building_id || lease?.building_id) || null;
      const unit = unitById.get(expense.unit_id || lease?.unit_id) || null;

      const row = {
        id: classificationRecord?.id || `${expense.id}:${matchedRule?.id || "unmatched"}`,
        rowType: hasMatchedRule ? "matched_classification" : "actual_missing_rule",
        actualExpenseId: expense.id,
        leaseExpenseRuleId: matchedRule?.id || null,
        classificationRecord,
        expense,
        rule: matchedRule,
        lease,
        property,
        building,
        unit,
        expenseDate: expense.expense_date || expense.date || expense.service_period_start || null,
        vendor: expense.vendor || expense.vendor_name || "-",
        tenantLabel: expense.tenant_name || lease?.tenant_name || "-",
        ruleLabel: matchedRule
          ? `${matchedRule.expense_category || matchedRule.category_name || "-"}${matchedRule.expense_subcategory ? ` / ${matchedRule.expense_subcategory}` : ""}`
          : "-",
        amount: actualAmount,
        financialAmount: actualAmount,
        recoverabilityResult: recoverabilityResult || "needs_review",
        classificationStatus,
        exceptionType,
        camEligible,
        recoverableAmount: hasMatchedRule ? (amountBuckets.recoverable_amount || (recoverabilityResult === "recoverable" ? actualAmount : 0)) : 0,
        nonRecoverableAmount: hasMatchedRule ? (amountBuckets.non_recoverable_amount || (recoverabilityResult === "non_recoverable" ? actualAmount : 0)) : 0,
        conditionalAmount: hasMatchedRule ? (amountBuckets.conditional_amount || (recoverabilityResult === "conditional" ? actualAmount : 0)) : 0,
        excludedAmount: hasMatchedRule ? (amountBuckets.excluded_amount || (recoverabilityResult === "excluded" ? actualAmount : 0)) : 0,
        sentToCam: Boolean(classificationRecord?.sent_to_cam),
        nextStep:
          classificationRecord?.next_step ||
          (hasMatchedRule
            ? (classificationStatus === "finalized" ? (camEligible === "yes" && recoverabilityResult === "recoverable" ? "Send to CAM" : "Ready for projection") : "Finalize row")
            : "Send to Expense Review"),
        message: hasMatchedRule
          ? (
              classificationRecord?.recovery_reason ||
              expense.recovery_reason ||
              match?.reason ||
              "Approved actual expense matched to an approved lease expense rule."
            )
          : "No approved lease expense rule matched this actual expense for the selected scope and period.",
      };

      row.canFinalize =
        row.rowType === "matched_classification" &&
        row.actualExpenseId &&
        row.classificationStatus !== "finalized";
      row.canSendToReview =
        Boolean(row.actualExpenseId) &&
        (row.rowType === "actual_missing_rule" ||
          row.recoverabilityResult === "needs_review" ||
          ["unmatched", "exception", "conditional"].includes(row.classificationStatus));
      row.canSendToCam =
        Boolean(row.actualExpenseId) &&
        Boolean(row.classificationRecord?.id) &&
        row.classificationStatus === "finalized" &&
        row.recoverabilityResult === "recoverable" &&
        row.camEligible === "yes" &&
        row.amount > 0 &&
        !row.sentToCam;
      result.push(row);
    }

    for (const rule of approvedRules) {
      if (usedRuleIds.has(rule.id)) continue;
      const lease = leaseById.get(rule.rule_set?.lease_id || rule.lease_id) || null;
      const property = propertyById.get(rule.property_id || rule.rule_set?.property_id || lease?.property_id) || null;
      const building = buildingById.get(rule.building_id || lease?.building_id) || null;
      const unit = unitById.get(rule.unit_id || lease?.unit_id) || null;

      result.push({
        id: `coverage-gap:${rule.id}`,
        rowType: "rule_missing_actual",
        actualExpenseId: null,
        leaseExpenseRuleId: rule.id,
        classificationRecord: null,
        expense: null,
        rule,
        lease,
        property,
        building,
        unit,
        expenseDate: null,
        vendor: "-",
        tenantLabel: lease?.tenant_name || "-",
        ruleLabel: `${rule.expense_category || rule.category_name || "-"}${rule.expense_subcategory ? ` / ${rule.expense_subcategory}` : ""}`,
        amount: null,
        financialAmount: 0,
        recoverabilityResult: normalizeText(leaseExpenseRuleService.getRecoverableDecision(rule)) === "yes"
          ? "recoverable"
          : normalizeText(leaseExpenseRuleService.getRecoverableDecision(rule)) === "conditional"
            ? "conditional"
            : normalizeText(rule?.is_excluded) === "true"
              ? "excluded"
              : "non_recoverable",
        classificationStatus: "coverage_gap",
        exceptionType: null,
        camEligible: "no",
        recoverableAmount: 0,
        nonRecoverableAmount: 0,
        conditionalAmount: 0,
        excludedAmount: 0,
        sentToCam: false,
        nextStep: "Add/Import Expense",
        message: "Approved lease rule exists, but no actual expense found for this period.",
        canFinalize: false,
        canSendToReview: false,
        canSendToCam: false,
      });
    }

    return result;
  }, [approvedActuals, approvedRules, existingClassifications, scopedLeases, leases, leaseById, propertyById, buildingById, unitById, scopeYear]);

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (activeTab === "matched") return row.rowType === "matched_classification";
      if (activeTab === "recoverable") return row.rowType === "matched_classification" && row.recoverabilityResult === "recoverable";
      if (activeTab === "non_recoverable") return row.rowType === "matched_classification" && row.recoverabilityResult === "non_recoverable";
      if (activeTab === "conditional") return row.rowType === "matched_classification" && row.recoverabilityResult === "conditional";
      if (activeTab === "excluded") return row.rowType === "matched_classification" && row.recoverabilityResult === "excluded";
      if (activeTab === "actuals_missing_rules") return row.rowType === "actual_missing_rule";
      if (activeTab === "rules_missing_actuals") return row.rowType === "rule_missing_actual";
      if (activeTab === "needs_review") {
        return row.rowType === "actual_missing_rule" ||
          row.recoverabilityResult === "needs_review" ||
          ["unmatched", "exception", "conditional"].includes(row.classificationStatus) ||
          (row.exceptionType && row.exceptionType !== "none");
      }
      if (activeTab === "finalized") return row.rowType === "matched_classification" && row.classificationStatus === "finalized";
      if (activeTab === "sent_to_cam") return row.rowType === "matched_classification" && row.sentToCam;
      return true;
    }).filter((row) => {
      if (!search) return true;
      const haystack = [
        row.vendor,
        row.ruleLabel,
        row.tenantLabel,
        row.property?.property_name || row.property?.name,
        row.building?.building_name || row.building?.name,
        row.unit?.unit_number || row.unit?.unit_id_code,
        row.message,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(search.toLowerCase());
    });
  }, [rows, activeTab, search]);

  const counts = useMemo(() => ({
    all: rows.length,
    matched: rows.filter((row) => row.rowType === "matched_classification").length,
    recoverable: rows.filter((row) => row.rowType === "matched_classification" && row.recoverabilityResult === "recoverable").length,
    non_recoverable: rows.filter((row) => row.rowType === "matched_classification" && row.recoverabilityResult === "non_recoverable").length,
    conditional: rows.filter((row) => row.rowType === "matched_classification" && row.recoverabilityResult === "conditional").length,
    excluded: rows.filter((row) => row.rowType === "matched_classification" && row.recoverabilityResult === "excluded").length,
    actuals_missing_rules: rows.filter((row) => row.rowType === "actual_missing_rule").length,
    rules_missing_actuals: rows.filter((row) => row.rowType === "rule_missing_actual").length,
    needs_review: rows.filter((row) =>
      row.rowType === "actual_missing_rule" ||
      row.recoverabilityResult === "needs_review" ||
      ["unmatched", "exception", "conditional"].includes(row.classificationStatus) ||
      (row.exceptionType && row.exceptionType !== "none")
    ).length,
    finalized: rows.filter((row) => row.rowType === "matched_classification" && row.classificationStatus === "finalized").length,
    sent_to_cam: rows.filter((row) => row.rowType === "matched_classification" && row.sentToCam).length,
  }), [rows]);

  const totals = useMemo(() => {
    return rows.reduce((summary, row) => {
      if (row.rowType !== "matched_classification" || !row.actualExpenseId) return summary;
      const amount = row.financialAmount;
      if (row.recoverabilityResult === "recoverable") summary.recoverable += amount;
      if (row.recoverabilityResult === "non_recoverable") summary.nonRecoverable += amount;
      if (row.recoverabilityResult === "conditional") summary.conditional += amount;
      if (row.recoverabilityResult === "excluded") summary.excluded += amount;
      if (["yes", "conditional"].includes(row.camEligible)) summary.camEligible += amount;
      if (row.classificationStatus === "finalized") summary.finalized += amount;
      return summary;
    }, {
      recoverable: 0,
      nonRecoverable: 0,
      conditional: 0,
      excluded: 0,
      camEligible: 0,
      finalized: 0,
    });
  }, [rows]);

  const actionableFilteredIds = useMemo(
    () => filteredRows.filter((row) => row.actualExpenseId).map((row) => row.id),
    [filteredRows]
  );

  const runClassificationMutation = useMutation({
    mutationFn: () => expenseService.runExpenseClassification(scopePayload),
    onSuccess: () => {
      toast.success("Expense classification refreshed");
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-diagnostics"] });
      queryClient.invalidateQueries({ queryKey: ["Expense"] });
    },
    onError: (error) => toast.error(error?.message || "Classification run failed"),
  });

  const finalizeMutation = useMutation({
    mutationFn: async (ids) => {
      const targetRows = Array.from(ids)
        .map((id) => rows.find((row) => row.id === id))
        .filter((row) => row?.canFinalize);

      await Promise.all(
        targetRows.map((row) =>
          expenseService.finalizeExpenseClassification(
            row.classificationRecord || row.actualExpenseId,
            row.recoverabilityResult
          )
        )
      );
      return targetRows.length;
    },
    onSuccess: (count) => {
      toast.success(`Finalized ${count} classification row${count === 1 ? "" : "s"}`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-diagnostics"] });
      queryClient.invalidateQueries({ queryKey: ["Expense"] });
    },
    onError: (error) => toast.error(error?.message || "Finalize failed"),
  });

  const reviewMutation = useMutation({
    mutationFn: async (ids) => {
      const targetRows = Array.from(ids)
        .map((id) => rows.find((row) => row.id === id))
        .filter((row) => row?.canSendToReview);

      await Promise.all(
        targetRows.map((row) =>
          expenseService.sendExpenseClassificationToReview(
            row.classificationRecord || row.actualExpenseId
          )
        )
      );
      return targetRows.length;
    },
    onSuccess: (count) => {
      toast.success(`Sent ${count} row${count === 1 ? "" : "s"} to Expense Review`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-diagnostics"] });
      queryClient.invalidateQueries({ queryKey: ["Expense"] });
    },
    onError: (error) => toast.error(error?.message || "Could not send rows to review"),
  });

  const sendToCamMutation = useMutation({
    mutationFn: async (ids) => {
      const targetRows = Array.from(ids)
        .map((id) => rows.find((row) => row.id === id))
        .filter((row) => row?.canSendToCam);

      await Promise.all(
        targetRows.map((row) => expenseService.sendClassificationToCam(row.classificationRecord))
      );
      return targetRows.length;
    },
    onSuccess: (count) => {
      toast.success(`Sent ${count} classification row${count === 1 ? "" : "s"} to CAM`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-diagnostics"] });
      queryClient.invalidateQueries({ queryKey: ["Expense"] });
    },
    onError: (error) => toast.error(error?.message || "Could not send rows to CAM"),
  });

  const amountMutation = useMutation({
    mutationFn: async ({ actualExpenseId, amount }) =>
      expenseService.updateExpenseAmount(actualExpenseId, amount, {
        reason: "Manual amount correction from Expense Classification",
      }),
    onSuccess: () => {
      toast.success("Actual expense amount updated");
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-diagnostics"] });
      queryClient.invalidateQueries({ queryKey: ["Expense"] });
      queryClient.invalidateQueries({ queryKey: ["expense-review-classifications"] });
      queryClient.invalidateQueries({ queryKey: ["expense-projection-finalized"] });
    },
    onError: (error) => toast.error(error?.message || "Could not update amount"),
  });

  const isLoading = loadingLeases || loadingWorkspace;
  const currentYear = new Date().getFullYear();
  const yearOptions = [currentYear - 1, currentYear, currentYear + 1];
  const rawCounts = diagnostics?.raw_db_counts || {};
  const scopedCounts = diagnostics?.counts_after_scope_filters || {};
  const hiddenCounts = diagnostics?.hidden_by_filter_counts || {};
  const actingOrgId = getStoredActingOrgId();

  const toggleRow = (id) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = (checked) => {
    setSelectedIds(checked ? new Set(actionableFilteredIds) : new Set());
  };

  const promptForAmount = (row) => {
    if (!row?.actualExpenseId) return;
    const input = window.prompt(
      `Enter amount for ${row.vendor || row.ruleLabel || "this expense"}:`,
      row.amount != null ? String(row.amount) : "",
    );
    if (input == null) return;

    const cleaned = String(input).replace(/[$,\s]/g, "");
    const amount = Number(cleaned);
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error("Invalid amount");
      return;
    }

    amountMutation.mutate({ actualExpenseId: row.actualExpenseId, amount });
  };

  const actualEmptyState = useMemo(() => {
    if (!diagnostics) return null;
    if ((rawCounts.total_expenses_for_org || 0) === 0) {
      return "No actual expenses exist for this org/scope. Add or import expenses.";
    }
    if ((rawCounts.total_approved_actual_expenses_for_org || 0) === 0) {
      return "Actual expenses exist but are not approved. Approve them on Actual Expenses page.";
    }
    if (approvedActuals.length === 0) {
      return "Approved actual expenses exist outside the selected scope or period.";
    }
    return null;
  }, [diagnostics, rawCounts, approvedActuals.length]);

  const ruleEmptyState = useMemo(() => {
    if (!diagnostics) return null;
    if ((rawCounts.total_lease_expense_rules_for_org || 0) === 0) {
      return "No lease expense rules exist. Approve a lease abstract and extract rules.";
    }
    if ((rawCounts.total_lease_expense_rules_approved_for_org || 0) === 0) {
      return "Lease expense rules exist but are not approved. Approve them on Lease Expense Rules page.";
    }
    if (approvedRules.length === 0) {
      return "Approved lease rules exist outside selected scope. Adjust scope.";
    }
    return null;
  }, [diagnostics, rawCounts, approvedRules.length]);

  return (
    <div className="flex min-h-screen flex-col bg-slate-50/50 pb-20">
      <div className="border-b border-slate-800 bg-slate-900 text-white shadow-sm">
        <div className="mx-auto max-w-screen-xl px-6 py-4">
          <div className="mb-4 flex flex-col items-start justify-between gap-3 md:flex-row md:items-center">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-bold tracking-tight">Expense Recoverability</h1>
              <Badge variant="outline" className="hidden border-indigo-500/30 bg-white/10 text-xs font-normal text-indigo-200 sm:inline-flex">
                Classification Engine
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="h-8 border-white/10 bg-white/5 text-xs text-white hover:bg-white/10" onClick={() => navigate(createPageUrl("AddExpense"))}>
                <Plus className="mr-1.5 h-3 w-3" /> Add Expense
              </Button>
              <Button size="sm" variant="outline" className="h-8 border-white/10 bg-white/5 text-xs text-white hover:bg-white/10" onClick={() => navigate(createPageUrl("BulkImport"))}>
                <Upload className="mr-1.5 h-3 w-3" /> Bulk Import
              </Button>
              <Button size="sm" variant="outline" className="h-8 border-white/10 bg-white/5 text-xs text-white hover:bg-white/10" onClick={() => navigate(createPageUrl("LeaseExpenseRules"))}>
                <FileText className="mr-1.5 h-3 w-3" /> Lease Rules
              </Button>
              <Button size="sm" variant="outline" className="h-8 border-white/10 bg-white/5 text-xs text-white hover:bg-white/10" onClick={() => navigate(createPageUrl("ExpenseReview"))}>
                <CheckCircle className="mr-1.5 h-3 w-3" /> Expense Review
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs">
            <span className="mr-1 font-medium uppercase tracking-wider text-slate-400">Scope:</span>
            <select className="h-7 rounded border border-slate-700 bg-slate-800 px-2 text-slate-200 outline-none focus:ring-1 focus:ring-indigo-500" value={scopeProperty} onChange={(event) => setScopeProperty(event.target.value)}>
              <option value="all">All Properties</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.property_name || property.name}
                </option>
              ))}
            </select>
            <select className="h-7 rounded border border-slate-700 bg-slate-800 px-2 text-slate-200 outline-none focus:ring-1 focus:ring-indigo-500" value={scopeBuilding} onChange={(event) => setScopeBuilding(event.target.value)}>
              <option value="all">All Buildings</option>
              {buildings
                .filter((building) => scopeProperty === "all" || building.property_id === scopeProperty)
                .map((building) => (
                  <option key={building.id} value={building.id}>
                    {building.building_name || building.name}
                  </option>
                ))}
            </select>
            <select className="h-7 rounded border border-slate-700 bg-slate-800 px-2 text-slate-200 outline-none focus:ring-1 focus:ring-indigo-500" value={scopeUnit} onChange={(event) => setScopeUnit(event.target.value)}>
              <option value="all">All Units</option>
              {units
                .filter((unit) => scopeBuilding === "all" || unit.building_id === scopeBuilding)
                .map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.unit_number || unit.unit_id_code}
                  </option>
                ))}
            </select>
            <select className="h-7 rounded border border-slate-700 bg-slate-800 px-2 text-slate-200 outline-none focus:ring-1 focus:ring-indigo-500" value={scopeLease} onChange={(event) => setScopeLease(event.target.value)}>
              <option value="all">All Leases</option>
              {scopedLeases.map((lease) => (
                <option key={lease.id} value={lease.id}>
                  {lease.tenant_name || lease.id.slice(0, 8)}
                </option>
              ))}
            </select>
            <select className="h-7 rounded border border-slate-700 bg-slate-800 px-2 text-slate-200 outline-none focus:ring-1 focus:ring-indigo-500" value={scopeTenant} onChange={(event) => setScopeTenant(event.target.value)}>
              <option value="all">All Tenants</option>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name || tenant.tenant_name || tenant.id?.slice?.(0, 8) || "Tenant"}
                </option>
              ))}
            </select>
            <select className="h-7 rounded border border-slate-700 bg-slate-800 px-2 text-slate-200 outline-none focus:ring-1 focus:ring-indigo-500" value={scopeYear} onChange={(event) => setScopeYear(event.target.value)}>
              <option value="all">All Years</option>
              {yearOptions.map((year) => (
                <option key={year} value={String(year)}>
                  FY {year}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="mx-auto mt-6 w-full max-w-screen-xl space-y-6 px-6">
        {!isLoading && approvedActuals.length === 0 && actualEmptyState && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-amber-900">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div className="flex-1">
              <p className="text-sm font-semibold">Actual Expense Input</p>
              <p className="mt-1 text-xs text-amber-700">{actualEmptyState}</p>
            </div>
            <Button size="sm" variant="outline" className="h-8 border-amber-300 bg-white text-xs text-amber-900" onClick={() => navigate(createPageUrl("Expenses"))}>
              Actual Expenses
            </Button>
          </div>
        )}

        {!isLoading && approvedRules.length === 0 && ruleEmptyState && (
          <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-5 py-4 text-rose-900">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
            <div className="flex-1">
              <p className="text-sm font-semibold">Lease Rule Input</p>
              <p className="mt-1 text-xs text-rose-700">{ruleEmptyState}</p>
            </div>
            <Button size="sm" variant="outline" className="h-8 border-rose-300 bg-white text-xs text-rose-900" onClick={() => navigate(createPageUrl("LeaseExpenseRules"))}>
              Lease Rules
            </Button>
          </div>
        )}

        {import.meta.env.DEV && diagnostics && (
          <Card className="border-dashed border-slate-300 bg-slate-50">
            <CardContent className="space-y-3 p-4 text-xs text-slate-700">
              <div className="flex items-center justify-between gap-3">
                <p className="font-semibold uppercase tracking-wider text-slate-500">Recoverability Diagnostics</p>
                <p className="text-slate-500">Open DevTools for matching `console.table` output.</p>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <div><span className="font-semibold">User:</span> {user?.id || diagnostics.current_user_id || "-"}</div>
                <div><span className="font-semibold">Current Org:</span> {user?.org_id || diagnostics.current_org_id || "-"}</div>
                <div><span className="font-semibold">Acting Org:</span> {actingOrgId || diagnostics.acting_org_id || "-"}</div>
                <div><span className="font-semibold">Resolved Org:</span> {resolvedOrgId || diagnostics.resolved_org_id || "-"}</div>
                <div><span className="font-semibold">Role:</span> {user?._raw_role || user?.role || diagnostics.role || "-"}</div>
                <div><span className="font-semibold">Property:</span> {scopeProperty}</div>
                <div><span className="font-semibold">Building:</span> {scopeBuilding}</div>
                <div><span className="font-semibold">Unit:</span> {scopeUnit}</div>
                <div><span className="font-semibold">Lease:</span> {scopeLease}</div>
                <div><span className="font-semibold">Tenant:</span> {scopeTenant}</div>
                <div><span className="font-semibold">Fiscal Year:</span> {scopeYear}</div>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="rounded border bg-white p-3">
                  <p className="mb-2 font-semibold text-slate-500">Raw DB Counts</p>
                  <p>Total rules: {rawCounts.total_lease_expense_rules_for_org || 0}</p>
                  <p>Approved rules: {rawCounts.total_lease_expense_rules_approved_for_org || 0}</p>
                  <p>Needs review rules: {rawCounts.total_lease_expense_rules_needs_review_for_org || 0}</p>
                  <p>Rejected / N/A rules: {rawCounts.total_lease_expense_rules_rejected_or_na_for_org || 0}</p>
                  <p>Total actuals: {rawCounts.total_expenses_for_org || 0}</p>
                  <p>Approved actuals: {rawCounts.total_approved_actual_expenses_for_org || 0}</p>
                  <p>Pending actuals: {rawCounts.total_pending_actual_expenses_for_org || 0}</p>
                  <p>Classification rows: {rawCounts.total_expense_classification_rows_for_org || 0}</p>
                </div>
                <div className="rounded border bg-white p-3">
                  <p className="mb-2 font-semibold text-slate-500">Counts After Scope</p>
                  <p>Rules by property: {scopedCounts.lease_rules_matching_selected_property || 0}</p>
                  <p>Rules by building: {scopedCounts.lease_rules_matching_selected_building || 0}</p>
                  <p>Rules by unit: {scopedCounts.lease_rules_matching_selected_unit || 0}</p>
                  <p>Rules by lease: {scopedCounts.lease_rules_matching_selected_lease || 0}</p>
                  <p>Actuals by property: {scopedCounts.actuals_matching_selected_property || 0}</p>
                  <p>Actuals by building: {scopedCounts.actuals_matching_selected_building || 0}</p>
                  <p>Actuals by unit: {scopedCounts.actuals_matching_selected_unit || 0}</p>
                  <p>Actuals by lease: {scopedCounts.actuals_matching_selected_lease || 0}</p>
                  <p>Actuals by fiscal year: {scopedCounts.actuals_matching_selected_fiscal_year || 0}</p>
                </div>
                <div className="rounded border bg-white p-3">
                  <p className="mb-2 font-semibold text-slate-500">Hidden By Filters</p>
                  <p>Rules hidden by approval: {hiddenCounts.rules_hidden_by_approval_status || 0}</p>
                  <p>Rules hidden by scope: {hiddenCounts.rules_hidden_by_property_building_unit_scope || 0}</p>
                  <p>Rules hidden by lease: {hiddenCounts.rules_hidden_by_lease_id || 0}</p>
                  <p>Actuals hidden by approval: {hiddenCounts.actuals_hidden_by_approval_status || 0}</p>
                  <p>Actuals hidden by scope: {hiddenCounts.actuals_hidden_by_property_building_unit_scope || 0}</p>
                  <p>Actuals hidden by fiscal year: {hiddenCounts.actuals_hidden_by_date_fiscal_year || 0}</p>
                  <p>Actuals hidden by org: {hiddenCounts.actuals_hidden_by_org_id || 0}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          {[
            { label: "Approved Actual Expenses", value: approvedActuals.length, color: "border-t-slate-400" },
            { label: "Approved Lease Rules", value: approvedRules.length, color: "border-t-slate-400" },
            { label: "Matched", value: counts.matched, color: "border-t-emerald-500" },
            { label: "Actuals Missing Rules", value: counts.actuals_missing_rules, color: "border-t-rose-500" },
            { label: "Rules Missing Actuals", value: counts.rules_missing_actuals, color: "border-t-blue-500" },
            { label: "Recoverable Costs", value: fmt(totals.recoverable), color: "border-t-emerald-500" },
            { label: "Non-Recoverable Costs", value: fmt(totals.nonRecoverable), color: "border-t-rose-500" },
            { label: "Conditional Costs", value: fmt(totals.conditional), color: "border-t-amber-500" },
            { label: "Excluded Costs", value: fmt(totals.excluded), color: "border-t-slate-500" },
            { label: "CAM Eligible Costs", value: fmt(totals.camEligible), color: "border-t-blue-500" },
            { label: "Finalized Costs", value: fmt(totals.finalized), color: "border-t-indigo-500" },
          ].map((card) => (
            <Card key={card.label} className={`border-t-4 shadow-sm ${card.color}`}>
              <CardContent className="p-4">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">{card.label}</p>
                <p className="text-xl font-bold text-slate-800">{card.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Input
              placeholder="Search vendor, tenant, rule, property..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-9 w-80 text-sm"
            />
            {isLoading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="h-9 border-slate-300 text-xs" onClick={() => runClassificationMutation.mutate()} disabled={runClassificationMutation.isPending}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Run Classification
            </Button>
            <Button size="sm" variant="outline" className="h-9 border-indigo-200 text-xs text-indigo-700 hover:bg-indigo-50" onClick={() => finalizeMutation.mutate(selectedIds)} disabled={finalizeMutation.isPending || selectedIds.size === 0}>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              Finalize ({selectedIds.size})
            </Button>
            <Button size="sm" variant="outline" className="h-9 border-amber-200 text-xs text-amber-700 hover:bg-amber-50" onClick={() => reviewMutation.mutate(selectedIds)} disabled={reviewMutation.isPending || selectedIds.size === 0}>
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              Send to Review ({selectedIds.size})
            </Button>
            <Button size="sm" className="h-9 bg-blue-600 text-xs hover:bg-blue-700" onClick={() => sendToCamMutation.mutate(selectedIds)} disabled={sendToCamMutation.isPending || selectedIds.size === 0}>
              <ArrowRightCircle className="mr-1.5 h-3.5 w-3.5" />
              Send to CAM ({selectedIds.size})
            </Button>
          </div>
        </div>

        <Card className="overflow-hidden rounded-xl border-0 bg-white shadow-md">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="border-b bg-slate-50 px-4 pt-3">
              <TabsList className="h-auto flex-wrap gap-1 bg-transparent pb-3">
                {[
                  { value: "all", label: `All (${counts.all})` },
                  { value: "matched", label: `Matched (${counts.matched})` },
                  { value: "recoverable", label: `Recoverable (${counts.recoverable})` },
                  { value: "non_recoverable", label: `Non-Recoverable (${counts.non_recoverable})` },
                  { value: "conditional", label: `Conditional (${counts.conditional})` },
                  { value: "excluded", label: `Excluded (${counts.excluded})` },
                  { value: "actuals_missing_rules", label: `Actuals Missing Rules (${counts.actuals_missing_rules})` },
                  { value: "rules_missing_actuals", label: `Rules Missing Actuals (${counts.rules_missing_actuals})` },
                  { value: "needs_review", label: `Needs Review / Exceptions (${counts.needs_review})` },
                  { value: "finalized", label: `Finalized (${counts.finalized})` },
                  { value: "sent_to_cam", label: `Sent to CAM (${counts.sent_to_cam})` },
                ].map((tab) => (
                  <TabsTrigger
                    key={tab.value}
                    value={tab.value}
                    className="rounded-full border border-transparent px-3 py-1 text-xs font-medium data-[state=active]:border-slate-200 data-[state=active]:bg-white data-[state=active]:text-indigo-700 data-[state=active]:shadow-sm"
                  >
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            <TabsContent value={activeTab} className="m-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-slate-50">
                    <TableRow>
                      <TableHead className="w-10 text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          checked={actionableFilteredIds.length > 0 && selectedIds.size === actionableFilteredIds.length}
                          onChange={(event) => toggleAll(event.target.checked)}
                        />
                      </TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Row Type</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Expense Date</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Vendor</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Property / Building / Unit</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Lease / Tenant</TableHead>
                      <TableHead className="text-[10px] text-right font-bold uppercase text-slate-500">Actual Amount</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Approved Rule</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Recoverability</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">CAM</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Status</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Message</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      <TableRow>
                        <TableCell colSpan={13} className="py-16 text-center">
                          <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-300" />
                          <p className="mt-2 text-sm text-slate-400">Loading approved actuals, approved rules, and classification rows...</p>
                        </TableCell>
                      </TableRow>
                    ) : filteredRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={13} className="py-16 text-center">
                          <FileText className="mx-auto mb-3 h-10 w-10 text-slate-200" />
                          <p className="text-sm text-slate-400">No rows in this view.</p>
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredRows.map((row) => {
                        const isSelected = selectedIds.has(row.id);
                        const propertyLabel = row.property?.property_name || row.property?.name || "-";
                        const buildingLabel = row.building?.building_name || row.building?.name || "-";
                        const unitLabel = row.unit?.unit_number || row.unit?.unit_id_code || "-";

                        return (
                          <TableRow key={row.id} className="group border-b-slate-100 transition-colors hover:bg-indigo-50/30">
                            <TableCell className="text-center">
                              <input
                                type="checkbox"
                                disabled={!row.actualExpenseId}
                                className="h-4 w-4 cursor-pointer rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                                checked={isSelected}
                                onChange={() => toggleRow(row.id)}
                              />
                            </TableCell>
                            <TableCell className="text-xs font-medium text-slate-800">{rowTypeLabel(row.rowType)}</TableCell>
                            <TableCell className="text-xs text-slate-500">{row.expenseDate || "-"}</TableCell>
                            <TableCell className="text-xs text-slate-500">{row.vendor}</TableCell>
                            <TableCell className="text-xs text-slate-500">
                              <div>{propertyLabel}</div>
                              <div className="text-[11px] text-slate-400">{buildingLabel} / {unitLabel}</div>
                            </TableCell>
                            <TableCell className="text-xs text-slate-500">
                              <div>{row.lease?.tenant_name || "-"}</div>
                              <div className="text-[11px] text-slate-400">{row.tenantLabel}</div>
                            </TableCell>
                            <TableCell className="text-right text-sm font-medium text-slate-700">
                              {row.actualExpenseId ? fmt(row.amount) : <span className="text-slate-300">-</span>}
                            </TableCell>
                            <TableCell className="text-xs text-slate-600">{row.ruleLabel}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className={`border text-[10px] uppercase ${recoverabilityBadge(row.recoverabilityResult)}`}>
                                {humanize(row.recoverabilityResult)}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className={`border text-[10px] uppercase ${row.camEligible === "yes" ? "bg-blue-50 text-blue-700 border-blue-200" : row.camEligible === "conditional" ? "bg-sky-50 text-sky-700 border-sky-200" : "bg-slate-100 text-slate-500 border-slate-200"}`}>
                                {humanize(row.camEligible)}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className={`border text-[10px] uppercase ${statusBadge(row.classificationStatus)}`}>
                                {humanize(row.classificationStatus)}
                              </Badge>
                              {row.sentToCam ? <p className="mt-1 text-[11px] text-blue-600">Sent to CAM</p> : null}
                            </TableCell>
                            <TableCell className="max-w-[320px] text-xs text-slate-600">
                              <p>{row.message}</p>
                              <p className="mt-1 text-[11px] text-slate-400">Next: {row.nextStep}</p>
                            </TableCell>
                            <TableCell className="pr-4 text-right">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-slate-100">
                                    <MoreHorizontal className="h-4 w-4 text-slate-500" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-48">
                                  {row.canFinalize && (
                                    <DropdownMenuItem onClick={() => finalizeMutation.mutate(new Set([row.id]))}>
                                      <Check className="mr-2 h-4 w-4 text-indigo-600" />
                                      Finalize Row
                                    </DropdownMenuItem>
                                  )}
                                  {row.canSendToReview && (
                                    <DropdownMenuItem onClick={() => reviewMutation.mutate(new Set([row.id]))}>
                                      <FileText className="mr-2 h-4 w-4 text-amber-600" />
                                      Send to Review
                                    </DropdownMenuItem>
                                  )}
                                  {row.canSendToCam && (
                                    <DropdownMenuItem onClick={() => sendToCamMutation.mutate(new Set([row.id]))}>
                                      <ArrowRightCircle className="mr-2 h-4 w-4 text-blue-600" />
                                      Send to CAM
                                    </DropdownMenuItem>
                                  )}
                                  {row.rowType === "rule_missing_actual" && (
                                    <DropdownMenuItem onClick={() => navigate(createPageUrl("AddExpense"))}>
                                      <Plus className="mr-2 h-4 w-4 text-slate-500" />
                                      Add / Import Expense
                                    </DropdownMenuItem>
                                  )}
                                  {row.actualExpenseId && (
                                    <DropdownMenuItem onClick={() => promptForAmount(row)}>
                                      <FileText className="mr-2 h-4 w-4 text-emerald-600" />
                                      {row.amount ? "Edit Amount" : "Set Amount"}
                                    </DropdownMenuItem>
                                  )}
                                  {row.actualExpenseId && (
                                    <DropdownMenuItem onClick={() => navigate(createPageUrl("Expenses"))}>
                                      <FileText className="mr-2 h-4 w-4 text-slate-500" />
                                      View Actual Expense
                                    </DropdownMenuItem>
                                  )}
                                  {row.rule?.lease_id && (
                                    <DropdownMenuItem onClick={() => navigate(createPageUrl("LeaseExpenseRules"))}>
                                      <FileText className="mr-2 h-4 w-4 text-slate-500" />
                                      View Lease Rule
                                    </DropdownMenuItem>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          </Tabs>
        </Card>

        <div className="flex flex-wrap gap-4 border-t pt-4 text-xs text-slate-500">
          <span className="flex items-center gap-1.5"><ArrowRightCircle className="h-3.5 w-3.5 text-blue-500" /> <strong>CAM:</strong> Only finalized matched rows with actual amounts and CAM eligibility can be sent.</span>
          <span className="flex items-center gap-1.5"><RefreshCw className="h-3.5 w-3.5 text-emerald-500" /> <strong>Projection:</strong> Finalized classification rows feed Expense Projection.</span>
          <span className="flex items-center gap-1.5"><CheckCircle className="h-3.5 w-3.5 text-indigo-500" /> <strong>Review:</strong> Unmatched actuals and conditional / exception rows go to Expense Review.</span>
        </div>
      </div>
    </div>
  );
}
