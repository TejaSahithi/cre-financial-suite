import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Upload,
  Search,
  Loader2,
  Pencil,
  Trash2,
  BookOpen,
  Receipt,
  Download,
  ClipboardCheck,
  MoreVertical,
  Check,
  X,
  CircleDollarSign,
  HelpCircle,
  FileUp,
  PenLine,
} from "lucide-react";
import { toast } from "sonner";

import PipelineActions, { EXPENSE_ACTIONS } from "@/components/PipelineActions";
import ModuleLink from "@/components/ModuleLink";
import RoleGuard from "@/components/RoleGuard";
import AuditTrailPanel from "@/components/AuditTrailPanel";
import PageHeader from "@/components/PageHeader";
import ScopeSelector from "@/components/ScopeSelector";
import VendorSpendAnalysis from "@/components/expenses/VendorSpendAnalysis";
import useOrgQuery from "@/hooks/useOrgQuery";
import { buildHierarchyScope, getScopeSubtitle, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { ExpenseService } from "@/services/api";
import { expenseService } from "@/services/expenseService";
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createPageUrl, downloadCSV } from "@/utils";
import DeleteConfirmDialog from "@/components/DeleteConfirmDialog";
import { resolveTenantForExpense } from "@/lib/tenantResolver";
import { approvedLeaseFieldValue } from "@/lib/approvedLeaseSnapshot";
import { getEffectiveApprovalStatus } from "@/lib/ruleStatus";

function normalizeExpenseDate(value) {
  if (!value) return null;
  const raw = String(value);
  const parsed = raw.length === 10 ? new Date(`${raw}T00:00:00`) : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isDisplayActiveLease(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return true;
  return ["approved", "active", "executed", "budget_ready", "signed"].includes(normalized);
}

function leaseFieldValue(lease, keys) {
  return approvedLeaseFieldValue(lease, keys) || null;
}

function leaseOverlapsExpense(expense, lease) {
  const expenseDate = normalizeExpenseDate(
    expense?.expense_date || expense?.date || expense?.service_period_start || expense?.billing_period_start
  );
  if (!expenseDate) return true;

  const leaseStart = normalizeExpenseDate(
    leaseFieldValue(lease, ["start_date", "commencement_date", "lease_start", "lease_start_date", "rent_commencement_date"])
  );
  const leaseEnd = normalizeExpenseDate(
    leaseFieldValue(lease, ["end_date", "expiration_date", "lease_end", "lease_end_date"])
  );
  if (leaseStart && expenseDate < leaseStart) return false;
  if (leaseEnd && expenseDate > leaseEnd) return false;
  return true;
}
function resolveDisplayLeaseForExpense(expense, leases = [], unitsById = new Map()) {
  if (expense?.lease_id) {
    return leases.find((lease) => lease.id === expense.lease_id) || null;
  }

  const unit = expense?.unit_id ? unitsById.get(expense.unit_id) : null;
  if (unit?.lease_id) {
    const unitLease = leases.find((lease) => lease.id === unit.lease_id);
    if (unitLease && leaseOverlapsExpense(expense, unitLease)) return unitLease;
  }
  if (unit?.tenant_id) {
    const unitTenantLease = leases
      .filter((lease) => lease.tenant_id === unit.tenant_id && leaseOverlapsExpense(expense, lease))
      .sort((left, right) => {
        const leftUnitMatch = left?.unit_id === expense?.unit_id ? 1 : 0;
        const rightUnitMatch = right?.unit_id === expense?.unit_id ? 1 : 0;
        return rightUnitMatch - leftUnitMatch;
      })[0];
    if (unitTenantLease) return unitTenantLease;
  }

  const candidates = (leases || [])
    .filter((lease) => {
      if (!isDisplayActiveLease(lease?.status)) return false;
      if (expense?.property_id && lease?.property_id !== expense.property_id) return false;
      if (expense?.building_id && lease?.building_id && lease.building_id !== expense.building_id) return false;
      if (expense?.unit_id && lease?.unit_id && lease.unit_id !== expense.unit_id) return false;
      return leaseOverlapsExpense(expense, lease);
    })
    .sort((left, right) => {
      const leftScore =
        (left?.unit_id === expense?.unit_id ? 100 : 0) +
        (left?.building_id === expense?.building_id ? 50 : 0) +
        (left?.property_id === expense?.property_id ? 25 : 0);
      const rightScore =
        (right?.unit_id === expense?.unit_id ? 100 : 0) +
        (right?.building_id === expense?.building_id ? 50 : 0) +
        (right?.property_id === expense?.property_id ? 25 : 0);
      return rightScore - leftScore;
    });

  return candidates.length === 1 ? candidates[0] : candidates[0] || null;
}

export default function Expenses() {
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");
  const [selectedExpenseIds, setSelectedExpenseIds] = useState([]);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [showAddExpenseMethod, setShowAddExpenseMethod] = useState(false);
  const queryClient = useQueryClient();

  const { data: expenses = [], isLoading } = useOrgQuery("Expense");
  const { data: budgets = [] } = useOrgQuery("Budget");
  const { data: leases = [] } = useOrgQuery("Lease");
  const { data: tenants = [] } = useOrgQuery("Tenant");
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

  const openAddExpense = (mode) => {
    const params = new URLSearchParams(location.search);
    params.set("mode", mode);
    setShowAddExpenseMethod(false);
    navigate(`${createPageUrl("AddExpense")}?${params.toString()}`);
  };

  const scopedAllExpenses = expenses.filter((expense) =>
    matchesHierarchyScope(expense, scope, {
      portfolioKey: "portfolio_id",
      propertyKey: "property_id",
      buildingKey: "building_id",
      unitKey: "unit_id",
    })
  );

  // Pick up an optional ?lease_id= from the URL so links from Lease
  // Review / Expense Classification land on this page already filtered
  // to the relevant lease. Without this, scope was being lost during
  // cross-page navigation (audit Pass 5 finding).
  const leaseIdParam = useMemo(
    () => new URLSearchParams(location.search).get("lease_id") || null,
    [location.search],
  );
  const highlightedExpenseId = useMemo(
    () => new URLSearchParams(location.search).get("expense_id") || new URLSearchParams(location.search).get("highlight") || null,
    [location.search],
  );
  const selectorScopedAllExpenses = scopedAllExpenses.filter((expense) => {
    if (scopeProperty !== "all" && expense.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all" && expense.building_id !== scopeBuilding) return false;
    if (scopeUnit !== "all" && expense.unit_id !== scopeUnit) return false;
    if (leaseIdParam && expense.lease_id !== leaseIdParam) return false;
    return true;
  });

  const selectorScopedExpenses = selectorScopedAllExpenses.filter(
    (expense) => {
      const isLeaseImport = expense.source_type === "lease_import" || expense.source === "lease_import";
      // Hide lease imports only if they are actively attached to a lease.
      // Orphaned imports should be visible so they can be bulk deleted.
      return !isLeaseImport || expense.lease_id === null;
    }
  );
  const selectorScopedExpenseIds = useMemo(
    () => selectorScopedExpenses.map((expense) => expense.id).filter(Boolean),
    [selectorScopedExpenses]
  );

  const updateScopeParams = ({ property = scopeProperty, building = scopeBuilding, unit = scopeUnit }) => {
    const params = new URLSearchParams(location.search);
    if (property && property !== "all") params.set("property", property);
    else params.delete("property");

    if (building && building !== "all") params.set("building", building);
    else params.delete("building");

    if (unit && unit !== "all") params.set("unit", unit);
    else params.delete("unit");

    navigate({
      pathname: location.pathname,
      search: params.toString() ? `?${params.toString()}` : "",
    }, { replace: true });
  };

  const handleScopePropertyChange = (value) => {
    setScopeProperty(value);
    setScopeBuilding("all");
    setScopeUnit("all");
    updateScopeParams({ property: value, building: "all", unit: "all" });
  };

  const handleScopeBuildingChange = (value) => {
    setScopeBuilding(value);
    setScopeUnit("all");
    updateScopeParams({ property: scopeProperty, building: value, unit: "all" });
  };

  const handleScopeUnitChange = (value) => {
    setScopeUnit(value);
    updateScopeParams({ property: scopeProperty, building: scopeBuilding, unit: value });
  };
  const selectedPropertyId = scopeProperty !== "all" ? scopeProperty : scope.propertyId || null;
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

  const { data: selectorScopedClassifications = [] } = useQuery({
    queryKey: ["expense-dashboard-classifications", selectorScopedExpenseIds.join("|")],
    queryFn: () => expenseService.listExpenseClassificationsForExpenses(selectorScopedExpenseIds),
    enabled: selectorScopedExpenseIds.length > 0,
  });

  const classificationByExpenseId = useMemo(
    () =>
      new Map(
        selectorScopedClassifications
          .map((classification) => [classification.expense_id || classification.actual_expense_id, classification])
          .filter(([expenseId]) => Boolean(expenseId))
      ),
    [selectorScopedClassifications]
  );

  const tenantById = useMemo(
    () => new Map((tenants || []).map((tenant) => [tenant.id, tenant])),
    [tenants]
  );
  const unitById = useMemo(
    () => new Map((allUnits || []).map((unit) => [unit.id, unit])),
    [allUnits]
  );

  const displayedExpenses = useMemo(() => {
    return selectorScopedExpenses.map((expense) => {
      const unit = expense.unit_id ? unitById.get(expense.unit_id) || null : null;
      const matchedLease = resolveDisplayLeaseForExpense(expense, leases, unitById);
      const directTenant =
        tenantById.get(expense.tenant_id) ||
        tenantById.get(matchedLease?.tenant_id) ||
        tenantById.get(unit?.tenant_id) ||
        null;
      const linkedExpense = matchedLease
        ? {
            ...expense,
            lease_id: expense.lease_id || matchedLease.id || null,
            tenant_id: expense.tenant_id || matchedLease.tenant_id || unit?.tenant_id || null,
            tenant_name:
              expense.tenant_name ||
              matchedLease.tenant_name ||
              approvedLeaseFieldValue(matchedLease, ["tenant_name", "tenant", "tenant_legal_name", "lessee"]) ||
              directTenant?.tenant_name ||
              directTenant?.name ||
              null,
            property_id: expense.property_id || matchedLease.property_id || null,
            building_id: expense.building_id || matchedLease.building_id || null,
            unit_id: expense.unit_id || matchedLease.unit_id || null,
          }
        : {
            ...expense,
            tenant_id: expense.tenant_id || unit?.tenant_id || null,
            tenant_name:
              expense.tenant_name ||
              directTenant?.tenant_name ||
              directTenant?.name ||
              null,
          };
      const classification = classificationByExpenseId.get(expense.id);
      if (!classification) return linkedExpense;

      const expenseWorkflowUpdatedAt = Date.parse(
        linkedExpense.classification_updated_at || linkedExpense.updated_at || ""
      );
      const classificationUpdatedAt = Date.parse(
        classification.updated_at ||
        classification.classified_at ||
        classification.reviewed_at ||
        classification.approved_at ||
        classification.finalized_at ||
        ""
      );
      const preferBaseWorkflow =
        Number.isFinite(expenseWorkflowUpdatedAt) &&
        (!Number.isFinite(classificationUpdatedAt) || expenseWorkflowUpdatedAt > classificationUpdatedAt);

      const effectiveRecovery =
        (preferBaseWorkflow
          ? (linkedExpense.recoverability_result || linkedExpense.recovery_status || linkedExpense.classification)
          : (classification.recoverability_result || classification.recovery_status)) ||
        linkedExpense.recovery_status ||
        linkedExpense.classification ||
        "needs_review";

      return {
        ...linkedExpense,
        recovery_status: preferBaseWorkflow
          ? (linkedExpense.recovery_status || linkedExpense.recoverability_result || effectiveRecovery)
          : (classification.recovery_status || effectiveRecovery),
        recoverability_result: preferBaseWorkflow
          ? (linkedExpense.recoverability_result || linkedExpense.recovery_status || effectiveRecovery)
          : (classification.recoverability_result || effectiveRecovery),
        classification: effectiveRecovery === "excluded" ? "non_recoverable" : effectiveRecovery,
        approval_status: preferBaseWorkflow
          ? (getEffectiveApprovalStatus(linkedExpense) || getEffectiveApprovalStatus(classification))
          : (getEffectiveApprovalStatus(classification) || getEffectiveApprovalStatus(linkedExpense)),
        approved_status: preferBaseWorkflow
          ? (getEffectiveApprovalStatus(linkedExpense) || getEffectiveApprovalStatus(classification))
          : (getEffectiveApprovalStatus(classification) || getEffectiveApprovalStatus(linkedExpense)),
        rule_source: preferBaseWorkflow
          ? (linkedExpense.rule_source || classification.rule_source)
          : (classification.rule_source || linkedExpense.rule_source),
        classification_status: preferBaseWorkflow
          ? (linkedExpense.classification_status || classification.classification_status)
          : (classification.classification_status || linkedExpense.classification_status),
        confidence_score: preferBaseWorkflow
          ? (linkedExpense.confidence_score ?? classification.confidence_score)
          : (classification.confidence_score ?? linkedExpense.confidence_score),
        recovery_reason: preferBaseWorkflow
          ? (linkedExpense.recovery_reason || classification.recovery_reason)
          : (classification.recovery_reason || linkedExpense.recovery_reason),
        cam_eligible: preferBaseWorkflow
          ? (linkedExpense.cam_eligible || classification.cam_eligible)
          : (classification.cam_eligible || linkedExpense.cam_eligible),
        recovery_method: preferBaseWorkflow
          ? (linkedExpense.recovery_method || classification.recovery_method)
          : (classification.recovery_method || linkedExpense.recovery_method),
        approved_at: preferBaseWorkflow
          ? (linkedExpense.approved_at || classification.approved_at)
          : (classification.approved_at || linkedExpense.approved_at),
        reviewed_at: preferBaseWorkflow
          ? (linkedExpense.reviewed_at || classification.reviewed_at)
          : (classification.reviewed_at || linkedExpense.reviewed_at),
        finalized_at: preferBaseWorkflow
          ? (linkedExpense.finalized_at || classification.finalized_at)
          : (classification.finalized_at || linkedExpense.finalized_at),
      };
    });
  }, [classificationByExpenseId, leases, selectorScopedExpenses, tenantById, unitById]);

  const displayedExpenseById = useMemo(
    () => new Map(displayedExpenses.map((expense) => [expense.id, expense])),
    [displayedExpenses]
  );

  const invalidateExpenseWorkflowQueries = () => {
    queryClient.invalidateQueries({ queryKey: ["Expense"] });
    queryClient.invalidateQueries({ queryKey: ["expense-dashboard-classifications"] });
    queryClient.invalidateQueries({ queryKey: ["lease-expense-classifications"] });
    queryClient.invalidateQueries({ queryKey: ["expense-review-exceptions"] });
    queryClient.invalidateQueries({ queryKey: ["expense-projection-finalized"] });
  };

  const { data: selectorScopedRuleSets = [] } = useQuery({
    queryKey: ["expense-dashboard-rule-sets", selectorScopedLeaseIds.join("|")],
    queryFn: () => leaseExpenseRuleService.loadRuleSets(selectorScopedLeaseIds),
    enabled: selectorScopedLeaseIds.length > 0,
  });

  const classColors = {
    recoverable: "bg-emerald-100 text-emerald-700",
    non_recoverable: "bg-red-100 text-red-700",
    conditional: "bg-amber-100 text-amber-700",
    excluded: "bg-slate-200 text-slate-700",
    needs_review: "bg-amber-100 text-amber-700",
  };

  const scopedRuleSummary = useMemo(() => {
    const allRules = selectorScopedRuleSets.flatMap((entry) => entry.rules || []);
    const groupedRules = leaseExpenseRuleService.groupRulesByRecoveryStatus(allRules);
    const approvedRuleLeaseIds = new Set(
      allRules
        .filter((rule) => {
          const approval = String(rule?.approval_status || "").trim().toLowerCase();
          const review = String(rule?.review_status || "").trim().toLowerCase();
          const status = String(rule?.status || "").trim().toLowerCase();
          const rowStatus = String(rule?.row_status || "").trim().toLowerCase();
          return (
            approval === "approved" ||
            review === "approved" ||
            review === "reviewed" ||
            status === "approved" ||
            rowStatus === "mapped" ||
            rowStatus === "manually_added"
          );
        })
        .map((rule) => rule.lease_id || rule.rule_set?.lease_id)
        .filter(Boolean)
    );
    return {
      total: allRules.length,
      approvedRuleSets: approvedRuleLeaseIds.size,
      draftRuleSets: Math.max(selectorScopedLeaseIds.length - approvedRuleLeaseIds.size, 0),
      recoverable: groupedRules.recoverable.length,
      nonRecoverable: groupedRules.nonRecoverable.length,
      conditional: groupedRules.conditional.length,
      needsReview: groupedRules.needsReview.length,
    };
  }, [selectorScopedLeaseIds.length, selectorScopedRuleSets]);

  const filtered = displayedExpenses.filter((expense) => {
    const property = expense.property_id ? scope.propertyById.get(expense.property_id) ?? null : null;
    const building = expense.building_id ? scope.buildingById.get(expense.building_id) ?? null : null;
    const unit = expense.unit_id ? scope.unitById.get(expense.unit_id) ?? null : null;

    const matchSearch =
      !search ||
      [expense.category, expense.vendor, property?.name, building?.name, unit?.unit_number, expense.description]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search.toLowerCase()));
    const matchFilter =
      filter === "all" ||
      expense.classification === filter ||
      expense.recovery_status === filter;
    return matchSearch && matchFilter;
  });

  const subtitleScope = getScopeSubtitle(scope, {
    default: `${displayedExpenses.length} expense records · Classification and recovery tracking`,
    portfolio: (portfolio) => `${displayedExpenses.length} expense records in ${portfolio.name}`,
    property: (property) => `${displayedExpenses.length} expense records for ${property.name}`,
    building: (building) => `${displayedExpenses.length} expense records for ${building.name}`,
    unit: (unit) => `${displayedExpenses.length} expense records for ${unit.unit_number || unit.unit_id_code || "selected unit"}`,
    org: () => `${displayedExpenses.length} expense records in selected organization`,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      await expenseService.deleteExpensesWorkflow([id]);
      return id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries();
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
      const result = await expenseService.deleteExpensesWorkflow(ids);
      return result?.deleted_count ?? ids.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries();
      setSelectedExpenseIds([]);
      setShowBulkDelete(false);
      toast.success(`${count} expense record${count === 1 ? "" : "s"} deleted successfully`);
    },
    onError: (err) => {
      toast.error(`Failed to delete selected expenses: ${err?.message || "Unknown error"}`);
    },
  });

  // ── Inline edit mutations (recovery / approval / amount) ───────────────
  // Lets the reviewer set recovery_status + approved_status from the row
  // dropdown without leaving the page. Approved actuals are what flow into
  // Expense Classification's "Run Classification" step alongside approved
  // lease_expense_rules.
  const updateExpenseMutation = useMutation({
    mutationFn: async ({ expense, id, patch }) => {
      const hasReviewFields =
        patch &&
        (patch.recovery_status !== undefined || patch.approved_status !== undefined);
      const hasAmountUpdate = patch && patch.amount !== undefined;
      const updated = hasReviewFields
        ? await expenseService.reviewExpense(expense || id, {
            recoveryStatus: patch.recovery_status,
            approvedStatus: patch.approved_status,
            ruleSource: patch.rule_source || "manual",
            reason: patch.recovery_reason || "Manual review update from Actual Expenses",
          })
        : hasAmountUpdate
          ? await expenseService.updateExpenseAmount(id, patch.amount, {
              reason: patch.recovery_reason || "Manual amount correction from Actual Expenses",
            })
          : await ExpenseService.update(id, patch);
      if (!updated) throw new Error("Update failed");
      return updated;
    },
    onSuccess: () => {
      invalidateExpenseWorkflowQueries();
    },
    onError: (err) => {
      toast.error(`Could not update expense: ${err?.message || "Unknown error"}`);
    },
  });

  // Single-row helpers
  const setRecoveryStatus = (expense, recoveryStatus) => {
    const classification = recoveryStatus === "excluded" ? "non_recoverable" : recoveryStatus;
    updateExpenseMutation.mutate(
      {
        id: expense.id,
        expense,
        patch: {
          recovery_status: recoveryStatus,
          classification,
          approved_status: getEffectiveApprovalStatus(expense) === "approved" ? "approved" : undefined,
          rule_source: "manual",
          recovery_reason: "Manual review update from Actual Expenses",
        },
      },
      { onSuccess: () => toast.success(`Marked ${String(recoveryStatus).replace("_", " ")}`) },
    );
  };

  const approveExpense = (expense) => {
    updateExpenseMutation.mutate(
      {
        id: expense.id,
        expense,
        patch: {
          recovery_status: expense.recovery_status || expense.recoverability_result || expense.classification || "needs_review",
          approved_status: "approved",
          rule_source: expense.rule_source || "manual",
          recovery_reason: expense.recovery_reason || "Manually approved from Actual Expenses",
        },
      },
      { onSuccess: () => toast.success("Expense approved") },
    );
  };

  const promptForAmount = (expense) => {
    const input = window.prompt(
      `Enter amount for ${expense.vendor || expense.category || "this expense"}:`,
      expense.amount != null ? String(expense.amount) : "",
    );
    if (input == null) return;
    const cleaned = String(input).replace(/[$,\s]/g, "");
    const amount = Number(cleaned);
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error("Invalid amount");
      return;
    }
    updateExpenseMutation.mutate(
      { id: expense.id, patch: { amount } },
      { onSuccess: () => toast.success(`Amount set to $${amount.toLocaleString()}`) },
    );
  };

  // Bulk approve for selected rows
  const bulkApproveMutation = useMutation({
    mutationFn: async (ids) => {
      await Promise.all(
        ids.map((id) =>
          expenseService.reviewExpense(displayedExpenseById.get(id) || id, {
            approvedStatus: "approved",
            ruleSource: (displayedExpenseById.get(id)?.rule_source || "manual"),
            reason: "Bulk approved from Actual Expenses",
          })
        ),
      );
      return ids.length;
    },
    onSuccess: (count) => {
      invalidateExpenseWorkflowQueries();
      setSelectedExpenseIds([]);
      toast.success(`${count} expense${count === 1 ? "" : "s"} approved.`);
    },
    onError: (err) => toast.error(`Bulk approve failed: ${err?.message || "Unknown error"}`),
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
      <PageHeader icon={Receipt} title="Actual Expenses" subtitle={subtitleScope} iconColor="from-red-500 to-rose-600">
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
            <Button
              size="sm"
              className="bg-gradient-to-r from-red-500 to-rose-600 shadow-sm"
              onClick={() => setShowAddExpenseMethod(true)}
            >
              <Plus className="w-4 h-4 mr-1" />
              Add Expense
            </Button>
          </RoleGuard>
        </div>
      </PageHeader>

      <Dialog open={showAddExpenseMethod} onOpenChange={setShowAddExpenseMethod}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>How would you like to add the expense?</DialogTitle>
            <DialogDescription>
              Both options open the same Add Expense form. Invoice upload extracts and prefills the fields for review.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 pt-2">
            <button
              type="button"
              onClick={() => openAddExpense("manual")}
              className="rounded-xl border-2 border-slate-200 p-5 text-left transition-colors hover:border-blue-400 hover:bg-blue-50"
            >
              <PenLine className="mb-3 h-6 w-6 text-blue-600" />
              <p className="font-semibold text-slate-900">Manual entry</p>
              <p className="mt-1 text-xs text-slate-500">Enter the expense details yourself.</p>
            </button>
            <button
              type="button"
              onClick={() => openAddExpense("invoice")}
              className="rounded-xl border-2 border-slate-200 p-5 text-left transition-colors hover:border-emerald-400 hover:bg-emerald-50"
            >
              <FileUp className="mb-3 h-6 w-6 text-emerald-600" />
              <p className="font-semibold text-slate-900">Invoice upload</p>
              <p className="mt-1 text-xs text-slate-500">Extract the invoice and prefill the form.</p>
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
        <span className="font-medium">Actual Expenses</span> come from invoices, bulk imports, and
        vendor bills.{" "}
        <Link to={createPageUrl("LeaseExpenseRules")} className="underline">
          Lease Expense Rules
        </Link>{" "}
        (responsibility / recovery method / caps) are extracted from approved lease documents and
        live on a separate page. Approved expense rows feed CAM and Budget.
      </div>

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
        onPropertyChange={handleScopePropertyChange}
        onBuildingChange={handleScopeBuildingChange}
        onUnitChange={handleScopeUnitChange}
      />




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
              {["all", "recoverable", "non_recoverable", "conditional", "excluded", "needs_review"].map((value) => (
                <Button
                  key={value}
                  variant={filter === value ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilter(value)}
                  className={`text-xs capitalize ${filter === value ? "bg-blue-600" : ""}`}
                >
                  {value === "all" ? "All" : value.replaceAll("_", "-")}
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
                  size="sm"
                  className="bg-emerald-600 text-white hover:bg-emerald-700"
                  onClick={() => bulkApproveMutation.mutate(selectedExpenseIds)}
                  disabled={bulkApproveMutation.isPending}
                  title="Mark selected expenses as approved so they flow into Expense Classification"
                >
                  <ClipboardCheck className="w-4 h-4 mr-1" />
                  {bulkApproveMutation.isPending ? "Approving…" : `Approve ${selectedExpenseIds.length}`}
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
                  <TableHead className="text-[10px] font-bold tracking-wider">TENANT</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">CATEGORY</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">SUBCATEGORY</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">GL CODE</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">VENDOR</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider text-right">AMOUNT</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">RECOVERY</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">APPROVAL</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider">SOURCE</TableHead>
                  <TableHead className="text-[10px] font-bold tracking-wider w-20"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                      <TableCell colSpan={15} className="text-center py-12">
                        <Loader2 className="w-5 h-5 animate-spin mx-auto text-slate-400" />
                      </TableCell>
                    </TableRow>
                  ) : filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={15} className="text-center py-12 text-sm text-slate-400">
                        {scopedRuleSummary.total > 0
                          ? "No expense rows found yet. Lease rules are ready above; upload actual expenses or review the extracted rule set."
                          : "No expenses found"}
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
                    // Centralized tenant resolver. Use the page's already-built
                    // index maps for cheaper lookup.
                    const tenantResolution = resolveTenantForExpense(expense, {
                      leases,
                      leaseById: undefined, // resolver builds its own from `leases`
                      unitById,
                      tenantById,
                    });

                    return (
                      <TableRow key={expense.id} className={expense.id === highlightedExpenseId ? "bg-amber-50 ring-1 ring-amber-300" : "hover:bg-slate-50"}>
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
                        <TableCell className="text-xs text-slate-600">
                          {tenantResolution.tenant?.name ? (
                            <span
                              title={`Resolved via ${tenantResolution.source}`}
                              className="text-slate-700"
                            >
                              {tenantResolution.tenant.name}
                            </span>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 text-slate-400"
                              title={
                                tenantResolution.reasonText
                                  ? `No tenant linked: ${tenantResolution.reasonText}`
                                  : "No tenant linked"
                              }
                            >
                              —
                              <HelpCircle className="h-3 w-3 text-amber-500" aria-label="tenant unresolved" />
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs font-medium capitalize">{expense.category?.replace(/_/g, " ")}</TableCell>
                        <TableCell className="text-xs text-slate-600">{expense.expense_subcategory || "—"}</TableCell>
                        <TableCell className="text-[10px] font-mono text-slate-500">{expense.gl_code || "—"}</TableCell>
                        <TableCell className="text-xs">
                          {(expense.vendor_name || expense.vendor) ? (
                            matchedVendor ? (
                              <Link to={`/VendorProfile?id=${matchedVendor.id}`} className="text-blue-600 hover:underline font-medium" onClick={(event) => event.stopPropagation()}>
                                {expense.vendor_name || expense.vendor}
                              </Link>
                            ) : (
                              <span>{expense.vendor_name || expense.vendor}</span>
                            )
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-right text-xs font-mono font-semibold tabular-nums">${(expense.amount || 0).toLocaleString()}</TableCell>
                        <TableCell>
                          <Badge className={`${classColors[expense.recovery_status || expense.classification] || "bg-slate-100 text-slate-700"} text-[8px] uppercase`}>
                            {(expense.recovery_status || expense.classification || "needs_review").replace("_", "-")}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-[10px] text-slate-500">{getEffectiveApprovalStatus(expense) || "draft"}</TableCell>

                        <TableCell className="text-[10px] text-slate-400 capitalize">{expense.source_type || expense.source}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" title="Actions">
                                  <MoreVertical className="h-3 w-3" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-56">
                                <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-slate-500">
                                  Set recovery
                                </DropdownMenuLabel>
                                <DropdownMenuItem onClick={() => setRecoveryStatus(expense, "recoverable")}>
                                  <Check className="mr-2 h-3.5 w-3.5 text-emerald-600" /> Recoverable
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setRecoveryStatus(expense, "non_recoverable")}>
                                  <X className="mr-2 h-3.5 w-3.5 text-rose-600" /> Non-Recoverable
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setRecoveryStatus(expense, "conditional")}>
                                  <HelpCircle className="mr-2 h-3.5 w-3.5 text-amber-600" /> Conditional
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setRecoveryStatus(expense, "excluded")}>
                                  <X className="mr-2 h-3.5 w-3.5 text-slate-500" /> Excluded
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setRecoveryStatus(expense, "needs_review")}>
                                  <HelpCircle className="mr-2 h-3.5 w-3.5 text-slate-500" /> Needs Review
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() => approveExpense(expense)}
                                  disabled={getEffectiveApprovalStatus(expense) === "approved"}
                                  className="text-emerald-700 focus:text-emerald-800"
                                >
                                  <ClipboardCheck className="mr-2 h-3.5 w-3.5" />
                                  {getEffectiveApprovalStatus(expense) === "approved" ? "Already approved" : "Approve expense"}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => promptForAmount(expense)}>
                                  <CircleDollarSign className="mr-2 h-3.5 w-3.5" />
                                  {expense.amount ? "Edit amount" : "Set amount"}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem asChild>
                                  <Link to={createPageUrl("AddExpense", { id: expense.id }) + location.search.replace("?", "&")}>
                                    <Pencil className="mr-2 h-3.5 w-3.5" /> Edit details
                                  </Link>
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => setDeleteTarget(expense)}
                                  className="text-red-600 focus:text-red-700"
                                >
                                  <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
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
            {filtered.length} of {displayedExpenses.length} expenses
          </div>
        </TabsContent>

        <TabsContent value="vendor_spend">
          <VendorSpendAnalysis expenses={displayedExpenses} vendors={vendors} budgets={budgets} />
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
