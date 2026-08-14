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
  X,
  Info,
  FileUp,
  PenLine,
} from "lucide-react";
import { toast } from "sonner";

import ModuleLink from "@/components/ModuleLink";
import RoleGuard from "@/components/RoleGuard";
import AuditTrailPanel from "@/components/AuditTrailPanel";
import PageHeader from "@/components/PageHeader";
import ScopeSelector from "@/components/ScopeSelector";
import VendorSpendAnalysis from "@/components/expenses/VendorSpendAnalysis";
import useOrgQuery from "@/hooks/useOrgQuery";
import useExpenseCategories from "@/hooks/useExpenseCategories";
import { useAuth } from "@/lib/AuthContext";
import { buildHierarchyScope, getScopeSubtitle, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { ExpenseService } from "@/services/api";
import { expenseService } from "@/services/expenseService";
import {
  recordModuleApprovalAction,
  submitOrReuseModuleApprovalWorkflow,
} from "@/services/moduleApprovalWorkflowBridge";
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
import { deriveNormalizedContractModel } from "@/services/utils/ruleDecisionEngine";
import {
  PRIMARY_FILTERS,
  RECOVERY_FILTERS,
  expenseNeedsClassification,
  getAccountingStatus,
  getCanonicalCategoryLabel,
  getRawCategoryEvidence,
  hasCanonicalCategory,
  getRecoveryStatusFromClassification,
  selectCanonicalExpenseClassification,
} from "@/components/expenses/utils/actualExpensesUiContract";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

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

const STATUS_TONE = {
  amber: "bg-amber-100 text-amber-800",
  blue: "bg-blue-100 text-blue-700",
  emerald: "bg-emerald-100 text-emerald-700",
  red: "bg-red-100 text-red-700",
  slate: "bg-slate-100 text-slate-700",
};

function formatCurrency(value) {
  const amount = Number(value || 0);
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value) {
  if (!value) return "-";
  const parsed = normalizeExpenseDate(value);
  return parsed ? parsed.toLocaleDateString() : String(value);
}

function humanize(value) {
  return String(value || "-").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function DetailField({ label, value }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="text-sm text-slate-800">{value || "-"}</p>
    </div>
  );
}

function ActualExpenseDetailDrawer({ expense, open, onOpenChange }) {
  const classification = expense?._classificationRecord || null;
  const propertyPath = [expense?._property?.name, expense?._building?.name, expense?._unit?.unit_number || expense?._unit?.unit_id_code]
    .filter(Boolean)
    .join(" / ") || "-";
  const servicePeriod = [expense?.service_period_start || expense?.billing_period_start, expense?.service_period_end || expense?.billing_period_end]
    .filter(Boolean)
    .map(formatDate)
    .join(" - ") || "-";
  const transactionDate = expense?.transaction_date || expense?.expense_date || expense?.date;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{expense?.vendor_name || expense?.vendor || "Actual expense"}</SheetTitle>
          <SheetDescription>Accounting source record and read-only classification context.</SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          <section className="grid grid-cols-2 gap-4">
            <DetailField label="Invoice Number" value={expense?.invoice_number} />
            <DetailField label="Transaction Date" value={formatDate(transactionDate)} />
            <DetailField label="Service Period" value={servicePeriod} />
            <DetailField label="Amount" value={formatCurrency(expense?.amount)} />
          </section>

          <section className="grid grid-cols-2 gap-4">
            <DetailField label="Canonical Category" value={expense?._categoryLabel?.label} />
            <DetailField label="Subcategory" value={expense?._categoryLabel?.subcategory || expense?.expense_subcategory || expense?.subcategory} />
            <DetailField label="Raw Source Category" value={expense?.category || expense?.raw_category || expense?.imported_category} />
            <DetailField label="GL Code" value={expense?.gl_code || expense?.account_code} />
          </section>

          <section className="grid grid-cols-2 gap-4">
            <DetailField label="Vendor Details" value={expense?._vendorRecord?.name || expense?.vendor_name || expense?.vendor} />
            <DetailField label="Property / Building / Unit" value={propertyPath} />
            <DetailField label="Tenant / Lease Context" value={expense?._tenantLeaseLabel} />
            <DetailField label="Source" value={humanize(expense?.source_type || expense?.source)} />
          </section>

          <section className="space-y-3 rounded border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Attachments</p>
            {expense?.attachment_url ? (
              <a href={expense.attachment_url} target="_blank" rel="noreferrer" className="text-sm text-blue-600 underline">Open attachment</a>
            ) : (
              <p className="text-sm text-slate-500">No attachment linked.</p>
            )}
          </section>

          <section className="space-y-3 rounded border border-slate-200 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Approval Audit</p>
            <div className="grid grid-cols-2 gap-4">
              <DetailField label="Accounting Status" value={expense?._accountingStatus?.label} />
              <DetailField label="Approved At" value={formatDate(expense?.approved_at)} />
              <DetailField label="Approved By" value={expense?.approved_by} />
              <DetailField label="Notes" value={expense?.notes} />
            </div>
          </section>

          <section className="space-y-3 rounded border border-slate-200 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Classification History</p>
            <div className="grid grid-cols-2 gap-4">
              <DetailField label="Recovery Status" value={expense?._recoveryStatus?.label} />
              <DetailField label="Classification Status" value={humanize(classification?.classification_status)} />
              <DetailField label="Rule Source" value={humanize(classification?.rule_source)} />
              <DetailField label="Classified At" value={formatDate(classification?.classified_at)} />
              <DetailField label="Recovery Reason" value={classification?.recovery_reason || classification?.notes} />
              <DetailField label="CAM Status" value={humanize(classification?.cam_status)} />
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function Expenses() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [recoveryFilter, setRecoveryFilter] = useState("all");
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");
  const [selectedExpenseIds, setSelectedExpenseIds] = useState([]);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [showAddExpenseMethod, setShowAddExpenseMethod] = useState(false);
  const [detailExpense, setDetailExpense] = useState(null);
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
  const { data: expenseCategories = [] } = useExpenseCategories();

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

  const getPropertyName = (propertyId) => scope.propertyById.get(propertyId)?.name || "-";

  const updateScopeParams = ({ property = scopeProperty, building = scopeBuilding, unit = scopeUnit }) => {
    const params = new URLSearchParams(location.search);
    if (property && property !== "all") params.set("property", property);
    else params.delete("property");

    if (building && building !== "all") params.set("building", building);
    else params.delete("building");

    if (unit && unit !== "all") params.set("unit", unit);
    else params.delete("unit");

    navigate(
      {
        pathname: location.pathname,
        search: params.toString() ? `?${params.toString()}` : "",
      },
      { replace: true }
    );
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

  const leaseIdParam = useMemo(() => new URLSearchParams(location.search).get("lease_id") || null, [location.search]);
  const highlightedExpenseId = useMemo(
    () => new URLSearchParams(location.search).get("expense_id") || new URLSearchParams(location.search).get("highlight") || null,
    [location.search]
  );

  const selectorScopedExpenses = scopedAllExpenses.filter((expense) => {
    const isLeaseImport = expense.source_type === "lease_import" || expense.source === "lease_import";
    if (isLeaseImport && expense.lease_id !== null) return false;
    if (scopeProperty !== "all" && expense.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all" && expense.building_id !== scopeBuilding) return false;
    if (scopeUnit !== "all" && expense.unit_id !== scopeUnit) return false;
    if (leaseIdParam && expense.lease_id !== leaseIdParam) return false;
    return true;
  });

  const selectorScopedExpenseIds = useMemo(
    () => selectorScopedExpenses.map((expense) => expense.id).filter(Boolean),
    [selectorScopedExpenses]
  );

  const { data: selectorScopedClassifications = [] } = useQuery({
    queryKey: ["expense-dashboard-classifications", selectorScopedExpenseIds.join("|")],
    queryFn: () => expenseService.listExpenseClassificationsForExpenses(selectorScopedExpenseIds),
    enabled: selectorScopedExpenseIds.length > 0,
  });

  const linkedRuleIds = useMemo(
    () =>
      selectorScopedClassifications
        .map((c) => c.lease_expense_rule_id || c.linked_expense_rule_id || c.recovery_rule_id)
        .filter(Boolean),
    [selectorScopedClassifications]
  );

  const { data: linkedClassificationRules = [] } = useQuery({
    queryKey: ["expense-dashboard-classification-rules", linkedRuleIds.slice().sort().join("|")],
    queryFn: () => expenseService.listLeaseExpenseRulesByIds(linkedRuleIds),
    enabled: linkedRuleIds.length > 0,
  });

  const linkedRuleById = useMemo(
    () => new Map(linkedClassificationRules.map((rule) => [rule.id, rule])),
    [linkedClassificationRules]
  );

  const classificationByExpenseId = useMemo(() => {
    const grouped = new Map();
    for (const classification of selectorScopedClassifications) {
      const expenseId = classification.expense_id || classification.actual_expense_id;
      if (!expenseId) continue;
      if (!grouped.has(expenseId)) grouped.set(expenseId, []);
      grouped.get(expenseId).push(classification);
    }
    return new Map(
      [...grouped.entries()].map(([expenseId, classifications]) => {
        const canonical = selectCanonicalExpenseClassification(classifications);
        if (!canonical) return [expenseId, canonical];
        // expense_classifications has no recovery_treatment column (see
        // expenseService.listLeaseExpenseRulesByIds) -- re-derive the
        // specific treatment from the linked rule so "Tenant Direct" shows
        // instead of the generic "Nonrecoverable" bucket recoverability_result
        // alone collapses it into.
        const ruleId = canonical.lease_expense_rule_id || canonical.linked_expense_rule_id || canonical.recovery_rule_id;
        const linkedRule = ruleId ? linkedRuleById.get(ruleId) : null;
        if (!linkedRule) return [expenseId, canonical];
        return [
          expenseId,
          { ...canonical, recovery_treatment: deriveNormalizedContractModel(linkedRule).recovery_treatment },
        ];
      })
    );
  }, [selectorScopedClassifications, linkedRuleById]);

  const tenantById = useMemo(() => new Map((tenants || []).map((tenant) => [tenant.id, tenant])), [tenants]);
  const unitById = useMemo(() => new Map((allUnits || []).map((unit) => [unit.id, unit])), [allUnits]);
  const categoryById = useMemo(() => new Map((expenseCategories || []).map((category) => [category.id, category])), [expenseCategories]);

  const displayedExpenses = useMemo(() => {
    return selectorScopedExpenses.map((expense) => {
      const unit = expense.unit_id ? unitById.get(expense.unit_id) || null : null;
      const building = expense.building_id
        ? scope.buildingById.get(expense.building_id) || null
        : unit?.building_id
          ? scope.buildingById.get(unit.building_id) || null
          : null;
      const property = expense.property_id
        ? scope.propertyById.get(expense.property_id) || null
        : building?.property_id
          ? scope.propertyById.get(building.property_id) || null
          : null;
      const matchedLease = resolveDisplayLeaseForExpense(expense, leases, unitById);
      const tenantResolution = resolveTenantForExpense(expense, { leases, leaseById: undefined, unitById, tenantById });
      const directTenant = tenantResolution.tenant || tenantById.get(expense.tenant_id) || tenantById.get(matchedLease?.tenant_id) || tenantById.get(unit?.tenant_id) || null;
      const tenantName =
        expense.tenant_name ||
        directTenant?.tenant_name ||
        directTenant?.name ||
        matchedLease?.tenant_name ||
        approvedLeaseFieldValue(matchedLease, ["tenant_name", "tenant", "tenant_legal_name", "lessee"]);
      const classification = classificationByExpenseId.get(expense.id) || null;
      const categoryLabel = getCanonicalCategoryLabel(expense, categoryById);
      const rawCategoryEvidence = getRawCategoryEvidence(expense);
      const accountingStatus = getAccountingStatus(expense);
      const recoveryStatus = hasCanonicalCategory(expense)
        ? getRecoveryStatusFromClassification(classification)
        : { value: "needs_review", label: "Needs Review", tone: "amber" };
      const matchedVendor = vendors.find(
        (vendor) => vendor.name?.toLowerCase() === expense.vendor?.toLowerCase() || vendor.id === expense.vendor_id
      ) || null;
      const leaseLabel = matchedLease?.id ? matchedLease.lease_name || matchedLease.name || "Lease #" + String(matchedLease.id).slice(0, 8) : null;
      const tenantLeaseLabel = tenantName ? [tenantName, leaseLabel].filter(Boolean).join(" / ") : "Shared property expense";

      return {
        ...expense,
        _property: property,
        _building: building,
        _unit: unit,
        _displayLease: matchedLease || null,
        _displayTenant: directTenant || null,
        _tenantName: tenantName || null,
        _tenantResolution: tenantResolution,
        _tenantLeaseLabel: tenantLeaseLabel,
        _classificationRecord: classification,
        _categoryLabel: categoryLabel,
        _rawCategoryEvidence: rawCategoryEvidence,
        _accountingStatus: accountingStatus,
        _recoveryStatus: recoveryStatus,
        _needsClassification: expenseNeedsClassification(expense, classification),
        _vendorRecord: matchedVendor,
      };
    });
  }, [categoryById, classificationByExpenseId, leases, scope.buildingById, scope.propertyById, selectorScopedExpenses, tenantById, unitById, vendors]);

  const filtered = displayedExpenses.filter((expense) => {
    const matchSearch =
      !search ||
      [
        expense._categoryLabel?.label,
        expense.expense_subcategory,
        expense.category,
        expense.vendor_name,
        expense.vendor,
        expense._property?.name,
        expense._building?.name,
        expense._unit?.unit_number,
        expense._tenantLeaseLabel,
        expense.description,
        expense.gl_code,
        expense.invoice_number,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search.toLowerCase()));

    const accountingStatus = expense._accountingStatus?.value;
    const recoveryStatus = expense._recoveryStatus?.value;
    const matchPrimary =
      filter === "all" ||
      (filter === "pending_approval" && accountingStatus === "pending") ||
      (filter === "approved" && accountingStatus === "approved") ||
      (filter === "rejected" && accountingStatus === "rejected") ||
      (filter === "needs_classification" && expense._needsClassification);
    const matchRecovery = recoveryFilter === "all" || recoveryStatus === recoveryFilter;
    return matchSearch && matchPrimary && matchRecovery;
  });

  const subtitleScope = getScopeSubtitle(scope, {
    default: `${displayedExpenses.length} actual expense records`,
    portfolio: (portfolio) => `${displayedExpenses.length} actual expense records in ${portfolio.name}`,
    property: (property) => `${displayedExpenses.length} actual expense records for ${property.name}`,
    building: (building) => `${displayedExpenses.length} actual expense records for ${building.name}`,
    unit: (unit) => `${displayedExpenses.length} actual expense records for ${unit.unit_number || unit.unit_id_code || "selected unit"}`,
    org: () => `${displayedExpenses.length} actual expense records in selected organization`,
  });

  const invalidateExpenseQueries = () => {
    queryClient.invalidateQueries({ queryKey: ["Expense"] });
    queryClient.invalidateQueries({ queryKey: ["expense-dashboard-classifications"] });
    queryClient.invalidateQueries({ queryKey: ["lease-expense-classifications"] });
    queryClient.invalidateQueries({ queryKey: ["expense-review-exceptions"] });
    queryClient.invalidateQueries({ queryKey: ["expense-projection-finalized"] });
    // Expense Classification (LeaseExpenseClassification.jsx) reads approved
    // actuals through its own "expense-recoverability-workspace"/-diagnostics
    // queries, keyed separately from "Expense" -- approving/rejecting here
    // never told that page's cache to refetch, so an approval made on this
    // page could sit invisible on Classification until something else
    // happened to remount/refetch it.
    queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
    queryClient.invalidateQueries({ queryKey: ["expense-recoverability-diagnostics"] });
  };

  const updateExpenseMutation = useMutation({
    mutationFn: async ({ id, patch }) => {
      const updated = await ExpenseService.update(id, patch);
      if (!updated) throw new Error("Update failed");
      return updated;
    },
    onSuccess: invalidateExpenseQueries,
    onError: (err) => toast.error(`Could not update expense: ${err?.message || "Unknown error"}`),
  });

  const approveExpense = (expense) => {
    updateExpenseMutation.mutate(
      {
        id: expense.id,
        patch: {
          approval_status: "approved",
          approved_status: "approved",
          review_status: "approved",
          approved_at: new Date().toISOString(),
        },
      },
      {
        onSuccess: async () => {
          try {
            await submitOrReuseModuleApprovalWorkflow({ workflowType: "expense", entity: expense, user, metadata: { source: "expenses_page_direct_approve" } });
            await recordModuleApprovalAction({ workflowType: "expense", entity: expense, user, action: "approve", metadata: { source: "expenses_page_direct_approve" } });
          } catch (error) {
            console.warn("[Expenses] Generic approval workflow sync failed:", error?.message || error);
          }
          toast.success("Expense approved");
        },
      },
    );
  };

  const rejectExpense = (expense) => {
    updateExpenseMutation.mutate(
      {
        id: expense.id,
        patch: {
          approval_status: "rejected",
          approved_status: "rejected",
          review_status: "rejected",
        },
      },
      {
        onSuccess: async () => {
          try {
            await submitOrReuseModuleApprovalWorkflow({ workflowType: "expense", entity: expense, user, metadata: { source: "expenses_page_direct_reject" } });
            await recordModuleApprovalAction({
              workflowType: "expense",
              entity: expense,
              user,
              action: "reject",
              comments: "Rejected from Actual Expenses.",
              rejectionReason: "Expense rejected during accounting review",
              metadata: { source: "expenses_page_direct_reject" },
            });
          } catch (error) {
            console.warn("[Expenses] Generic approval workflow sync failed:", error?.message || error);
          }
          toast.success("Expense rejected");
        },
      },
    );
  };

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
    onError: (err) => toast.error(`Failed to delete expense: ${err?.message || "Unknown error"}`),
  });

  const bulkApproveMutation = useMutation({
    mutationFn: async (ids) => {
      const approvedAt = new Date().toISOString();
      await Promise.all(
        ids.map((id) => ExpenseService.update(id, {
          approval_status: "approved",
          approved_status: "approved",
          review_status: "approved",
          approved_at: approvedAt,
        })),
      );
      return ids.length;
    },
    onSuccess: (count) => {
      invalidateExpenseQueries();
      setSelectedExpenseIds([]);
      toast.success(`${count} expense${count === 1 ? "" : "s"} approved.`);
    },
    onError: (err) => toast.error(`Bulk approve failed: ${err?.message || "Unknown error"}`),
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
    onError: (err) => toast.error(`Failed to delete selected expenses: ${err?.message || "Unknown error"}`),
  });

  const allFilteredSelected = filtered.length > 0 && filtered.every((expense) => selectedExpenseIds.includes(expense.id));

  const toggleExpenseSelection = (expenseId) => {
    setSelectedExpenseIds((prev) =>
      prev.includes(expenseId) ? prev.filter((id) => id !== expenseId) : [...prev, expenseId]
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
        Actual Expenses record real landlord costs from invoices, GL imports, and manual entries. Accounting approval confirms that the expense is valid. Expense Classification determines whether an approved expense is recoverable, direct, excluded, or eligible for CAM. Approved historical expenses also support budgeting and forecasting.
      </div>

      <ScopeSelector
        portfolios={scope.orgScopedPortfolios}
        properties={scope.scopedProperties}
        buildings={scope.scopedBuildings}
        units={scope.scopedUnits}
        selectedProperty={scopeProperty}
        selectedBuilding={scopeBuilding}
        selectedUnit={scopeUnit}
        onPropertyChange={handleScopePropertyChange}
        onBuildingChange={handleScopeBuildingChange}
        onUnitChange={handleScopeUnitChange}
        syncToUrl
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
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[240px] flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input placeholder="Search expenses..." className="h-9 pl-9 text-sm" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <div className="flex flex-wrap gap-1">
              {PRIMARY_FILTERS.map((item) => (
                <Button
                  key={item.value}
                  variant={filter === item.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilter(item.value)}
                  className={`text-xs ${filter === item.value ? "bg-blue-600" : ""}`}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1 border-l border-slate-200 pl-3">
              {RECOVERY_FILTERS.map((item) => (
                <Button
                  key={item.value}
                  variant={recoveryFilter === item.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => setRecoveryFilter(item.value)}
                  className={`text-xs ${recoveryFilter === item.value ? "bg-slate-700" : ""}`}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            {selectedExpenseIds.length > 0 && (
              <>
                <span className="text-xs font-medium text-slate-500">{selectedExpenseIds.length} selected</span>
                <Button variant="outline" size="sm" onClick={() => setSelectedExpenseIds([])}>Clear</Button>
                <Button
                  size="sm"
                  className="bg-emerald-600 text-white hover:bg-emerald-700"
                  onClick={() => bulkApproveMutation.mutate(selectedExpenseIds)}
                  disabled={bulkApproveMutation.isPending}
                  title="Approve selected accounting expense records"
                >
                  <ClipboardCheck className="mr-1 h-4 w-4" />
                  {bulkApproveMutation.isPending ? "Approving..." : `Approve ${selectedExpenseIds.length}`}
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setShowBulkDelete(true)}>
                  <Trash2 className="mr-1 h-4 w-4" />
                  Delete Selected
                </Button>
              </>
            )}
          </div>

          <Card className="overflow-hidden border-slate-200/80">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-gradient-to-r from-slate-50 to-slate-100/50">
                    <TableHead className="text-[10px] font-bold tracking-wider">Date</TableHead>
                    <TableHead className="text-[10px] font-bold tracking-wider">Vendor</TableHead>
                    <TableHead className="text-[10px] font-bold tracking-wider">Property / Building / Unit</TableHead>
                    <TableHead className="text-[10px] font-bold tracking-wider">Tenant</TableHead>
                    <TableHead className="text-[10px] font-bold tracking-wider">Category</TableHead>
                    <TableHead className="text-[10px] font-bold tracking-wider">GL Code</TableHead>
                    <TableHead className="text-right text-[10px] font-bold tracking-wider">Amount</TableHead>
                    <TableHead className="text-[10px] font-bold tracking-wider">Accounting Status</TableHead>
                    <TableHead className="text-[10px] font-bold tracking-wider">Recovery Status</TableHead>
                    <TableHead className="text-[10px] font-bold tracking-wider">Source</TableHead>
                    <TableHead className="text-[10px] font-bold tracking-wider">
                      <div className="flex items-center justify-end gap-2">
                        <span>Actions</span>
                        <Checkbox
                          checked={allFilteredSelected}
                          onCheckedChange={toggleSelectAllFiltered}
                          aria-label="Select all filtered expenses"
                        />
                      </div>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={11} className="py-12 text-center">
                        <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" />
                      </TableCell>
                    </TableRow>
                  ) : filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={11} className="py-12 text-center text-sm text-slate-400">No expenses found</TableCell>
                    </TableRow>
                  ) : (
                    filtered.map((expense) => {
                      const accountingStatus = expense._accountingStatus;
                      const recoveryStatus = expense._recoveryStatus;
                      const propertyPath = [expense._property?.name || getPropertyName(expense.property_id), expense._building?.name, expense._unit?.unit_number || expense._unit?.unit_id_code]
                        .filter(Boolean)
                        .join(" / ");

                      return (
                        <TableRow key={expense.id} className={expense.id === highlightedExpenseId ? "bg-amber-50 ring-1 ring-amber-300" : "hover:bg-slate-50"}>
                          <TableCell className="whitespace-nowrap text-xs">
                            {formatDate(expense.expense_date || expense.date || expense.service_period_start)}
                          </TableCell>
                          <TableCell className="text-xs">
                            {(expense.vendor_name || expense.vendor) ? (
                              expense._vendorRecord ? (
                                <Link to={`/VendorProfile?id=${expense._vendorRecord.id}`} className="font-medium text-blue-600 hover:underline" onClick={(event) => event.stopPropagation()}>
                                  {expense.vendor_name || expense.vendor}
                                </Link>
                              ) : (
                                <span>{expense.vendor_name || expense.vendor}</span>
                              )
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          <TableCell className="max-w-[220px] text-xs text-slate-700">{propertyPath || "-"}</TableCell>
                          <TableCell className="max-w-[190px] text-xs text-slate-700">
                            {expense._tenantName ? (
                              <span title={`Resolved via ${expense._tenantResolution?.source || "record"}`}>{expense._tenantLeaseLabel}</span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-slate-500" title="Shared property expense; no tenant or lease required">
                                Shared property expense
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="max-w-[180px] text-xs">
                            <div className={expense._categoryLabel?.value === "needs_category" ? "font-semibold text-amber-700" : "font-medium text-slate-900"}>
                              {expense._categoryLabel?.label}
                            </div>
                            {expense._categoryLabel?.value === "needs_category" ? (
                              <div className="mt-0.5 text-[11px] text-slate-500">
                                {expense._rawCategoryEvidence ? `Raw source: ${expense._rawCategoryEvidence}` : "No source category provided"}
                              </div>
                            ) : (
                              (expense._categoryLabel?.subcategory || expense.expense_subcategory) && (
                                <div className="mt-0.5 text-[11px] text-slate-500">
                                  {expense._categoryLabel?.subcategory || expense.expense_subcategory}
                                </div>
                              )
                            )}
                          </TableCell>
                          <TableCell className="text-[10px] font-mono text-slate-500">{expense.gl_code || expense.account_code || "-"}</TableCell>
                          <TableCell className="text-right text-xs font-mono font-semibold tabular-nums">{formatCurrency(expense.amount)}</TableCell>
                          <TableCell>
                            <Badge className={`text-[10px] ${STATUS_TONE[accountingStatus.tone] || STATUS_TONE.slate}`}>{accountingStatus.label}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge className={`text-[10px] ${STATUS_TONE[recoveryStatus.tone] || STATUS_TONE.slate}`}>{recoveryStatus.label}</Badge>
                          </TableCell>
                          <TableCell className="text-[10px] capitalize text-slate-500">{humanize(expense.source_type || expense.source)}</TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              <Checkbox
                                checked={selectedExpenseIds.includes(expense.id)}
                                onCheckedChange={() => toggleExpenseSelection(expense.id)}
                                aria-label={`Select expense ${expense.id}`}
                              />
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setDetailExpense(expense)} aria-label="View expense details">
                                <Info className="h-3.5 w-3.5 text-slate-500" />
                              </Button>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Actions">
                                    <MoreVertical className="h-3.5 w-3.5" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-52">
                                  <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-slate-500">Accounting</DropdownMenuLabel>
                                  <DropdownMenuItem
                                    onClick={() => approveExpense(expense)}
                                    disabled={accountingStatus.value === "approved" || updateExpenseMutation.isPending}
                                    className="text-emerald-700 focus:text-emerald-800"
                                  >
                                    <ClipboardCheck className="mr-2 h-3.5 w-3.5" />
                                    {accountingStatus.value === "approved" ? "Already approved" : "Approve expense"}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => rejectExpense(expense)}
                                    disabled={accountingStatus.value === "rejected" || updateExpenseMutation.isPending}
                                    className="text-red-700 focus:text-red-800"
                                  >
                                    <X className="mr-2 h-3.5 w-3.5" />
                                    {accountingStatus.value === "rejected" ? "Already rejected" : "Reject expense"}
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem asChild>
                                    <Link to={createPageUrl("AddExpense", { id: expense.id }) + location.search.replace("?", "&")}>
                                      <Pencil className="mr-2 h-3.5 w-3.5" /> Edit details
                                    </Link>
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => setDeleteTarget(expense)} className="text-red-600 focus:text-red-700">
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
            </div>
          </Card>
          <div className="text-right text-xs text-slate-400">
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

      <ActualExpenseDetailDrawer
        expense={detailExpense}
        open={Boolean(detailExpense)}
        onOpenChange={(open) => { if (!open) setDetailExpense(null); }}
      />

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
