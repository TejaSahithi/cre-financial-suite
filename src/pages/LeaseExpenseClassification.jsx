import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRightCircle,
  Check,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

import useOrgQuery from "@/hooks/useOrgQuery";
import useOrgId from "@/hooks/useOrgId";
import { buildHierarchyScope, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { expenseService } from "@/services/expenseService";
import { resolveExpenseClassificationCondition } from "@/services/expenseClassificationWorkflowService";
import { supabase } from "@/services/supabaseClient";
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import { useAuth } from "@/lib/AuthContext";
import { getStoredActingOrgId } from "@/lib/actingOrg";
import { createPageUrl } from "@/utils";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import PageHeader from "@/components/PageHeader";
import ClassificationDebugPanel from "@/components/lease-expense/ClassificationDebugPanel";

import {
  humanize,
  leaseCoversYear,
  isAutomaticCamReadyRow,
  buildClassificationRows,
  getCamPublicationReadiness,
  getCamInputDecision,
} from "@/components/lease-expense/utils/buildClassificationRows";
import { resolveMatchStatus } from "@/components/lease-expense/utils/leaseExpenseRulesHelpers";

function fmt(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value) || 0);
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
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

// Badge color per CAM Input Decision state (see getCamInputDecision in
// buildClassificationRows.js, the single source of truth for the label).
const CAM_INPUT_DECISION_CLASSNAME = {
  ready_to_send: "border-emerald-200 bg-emerald-50 text-emerald-700",
  conditional_review_required: "border-amber-200 bg-amber-50 text-amber-700",
  needs_category: "border-amber-200 bg-amber-50 text-amber-700",
  needs_service_period: "border-amber-200 bg-amber-50 text-amber-700",
  needs_scope: "border-amber-200 bg-amber-50 text-amber-700",
  needs_direct_tenant: "border-amber-200 bg-amber-50 text-amber-700",
  not_cam_eligible: "border-rose-200 bg-rose-50 text-rose-700",
  published_to_cam: "border-blue-200 bg-blue-50 text-blue-700",
  superseded: "border-slate-300 bg-slate-100 text-slate-700",
  withdrawn: "border-slate-300 bg-slate-100 text-slate-700",
  needs_review: "border-amber-200 bg-amber-50 text-amber-700",
};

function camInputDecisionClassName(state) {
  return `border ${CAM_INPUT_DECISION_CLASSNAME[state] || CAM_INPUT_DECISION_CLASSNAME.needs_review}`;
}

const MATCH_STATUS_TONE_CLASSNAME = {
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  red: "border-rose-200 bg-rose-50 text-rose-700",
  slate: "border-slate-300 bg-slate-100 text-slate-600",
};

function matchStatusBadgeClassName(tone) {
  return MATCH_STATUS_TONE_CLASSNAME[tone] || MATCH_STATUS_TONE_CLASSNAME.slate;
}

function rowTypeLabel(rowType) {
  if (rowType === "matched_classification") return "Matched";
  if (rowType === "actual_missing_rule") return "Actual Missing Rule";
  if (rowType === "rule_missing_actual") return "Contract Rule - No Actual";
  return humanize(rowType);
}
function compactParams(params) {
  return Object.fromEntries(
    Object.entries(params || {}).filter(([, value]) => value !== null && value !== undefined && value !== "" && value !== "all")
  );
}

function expenseContextParams(row, extras = {}) {
  const rule = row?.rule || {};
  const lease = row?.lease || {};
  return compactParams({
    property: row?.property?.id || lease.property_id,
    building: row?.building?.id || lease.building_id,
    unit: row?.unit?.id || lease.unit_id,
    lease_id: lease.id || rule.lease_id,
    tenant_id: lease.tenant_id || row?.tenantResolution?.tenant?.id,
    category: rule.expense_category || rule.category_name,
    subcategory: rule.expense_subcategory || rule.subcategory_name,
    description: row?.ruleLabel && row.ruleLabel !== "-" ? row.ruleLabel : undefined,
    rule_id: rule.id || row?.leaseExpenseRuleId,
    ...extras,
  });
}

export default function LeaseExpenseClassification() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { orgId: resolvedOrgId } = useOrgId();
  const actingOrgId = getStoredActingOrgId();
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
  const [activeTab, setActiveTab] = useState("actual_expenses");
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [linkExpenseRow, setLinkExpenseRow] = useState(null);
  const [selectedExistingExpenseId, setSelectedExistingExpenseId] = useState("");

  const { data: leases = [], isLoading: loadingLeases } = useOrgQuery("Lease", {}, { allowSuperAdminGlobal: true });
  const { data: tenants = [] } = useOrgQuery("Tenant", {}, { allowSuperAdminGlobal: true });
  const { data: properties = [] } = useOrgQuery("Property", {}, { allowSuperAdminGlobal: true });
  const { data: buildings = [] } = useOrgQuery("Building", {}, { allowSuperAdminGlobal: true });
  const { data: units = [] } = useOrgQuery("Unit", {}, { allowSuperAdminGlobal: true });

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
  // Tenant index for the centralized tenant resolver (src/lib/tenantResolver.js).
  const tenantById = useMemo(() => new Map((tenants || []).map((tenant) => [tenant.id, tenant])), [tenants]);
  const propertyById = useMemo(() => new Map(properties.map((property) => [property.id, property])), [properties]);
  const buildingById = useMemo(() => new Map(buildings.map((building) => [building.id, building])), [buildings]);
  const unitById = useMemo(() => new Map(units.map((unit) => [unit.id, unit])), [units]);

  const selectedLease = useMemo(() => {
    if (scopeLease !== "all") return leaseById.get(scopeLease) || null;
    return scopedLeases.length === 1 ? scopedLeases[0] : null;
  }, [scopeLease, leaseById, scopedLeases]);

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

  const orgScopeKey = resolvedOrgId ?? actingOrgId ?? user?.org_id ?? "__global__";
  const queriesEnabled = resolvedOrgId !== undefined;

  const {
    data: workspace = {
      approvedRules: [],
      approvedActuals: [],
      existingClassifications: [],
      ruleExclusions: {},
      actualExclusions: {},
      summary: {},
    },
    isLoading: loadingWorkspace,
  } = useQuery({
    queryKey: ["expense-recoverability-workspace", orgScopeKey, scopeProperty, scopeBuilding, scopeUnit, scopeLease, scopeTenant, scopeYear],
    queryFn: () => expenseService.loadExpenseRecoverabilityScope(scopePayload),
    enabled: queriesEnabled,
  });

  const { data: diagnostics = null } = useQuery({
    queryKey: ["expense-recoverability-diagnostics", orgScopeKey, scopeProperty, scopeBuilding, scopeUnit, scopeLease, scopeTenant, scopeYear],
    queryFn: () => expenseService.loadExpenseRecoverabilityDiagnostics(scopePayload),
    enabled: import.meta.env.DEV && queriesEnabled,
  });

  const approvedActuals = workspace.approvedActuals || [];
  const approvedRules = workspace.approvedRules || [];
  const existingClassifications = workspace.existingClassifications || [];
  const ruleExclusions = workspace.ruleExclusions || {};
  const actualExclusions = workspace.actualExclusions || {};
  const workspaceSummary = workspace.summary || {};
  const hasUnlinkedExpenses = workspace.hasUnlinkedExpenses || false;
  const unlinkedActualsCount = workspace.unlinkedActualsCount || 0;
  const [showClassificationDebug, setShowClassificationDebug] = useState(false);
  const linkableActualExpenses = useMemo(() => {
    if (!linkExpenseRow) return [];
    const row = linkExpenseRow;
    return approvedActuals.filter((expense) => {
      if (!expense?.id) return false;
      if (row.property?.id && expense.property_id && expense.property_id !== row.property.id) return false;
      if (row.building?.id && expense.building_id && expense.building_id !== row.building.id) return false;
      if (row.unit?.id && expense.unit_id && expense.unit_id !== row.unit.id) return false;
      if (row.lease?.id && expense.lease_id && expense.lease_id !== row.lease.id) return false;
      if (row.rule?.id && [expense.recovery_rule_id, expense.linked_expense_rule_id].includes(row.rule.id)) return false;
      return true;
    });
  }, [approvedActuals, linkExpenseRow]);

  // Read-only signal for the "Superseded / Withdrawn" status: withdraw_cam_expense_input
  // resets the classification back to classification_status='matched' with
  // sent_to_cam=false (see 20269900000005_cam_publication_rpcs.sql), which
  // looks identical to "never sent" unless the withdrawn cam_expense_inputs
  // row itself is checked. Small, additive, read-only query -- no change to
  // the withdraw/publish RPCs themselves.
  const classificationIdsInScope = useMemo(
    () => existingClassifications.map((c) => c.id).filter(Boolean),
    [existingClassifications],
  );
  const { data: camPublicationStatusByClassificationId = new Map() } = useQuery({
    queryKey: ["cam-publication-status-by-classification-id", classificationIdsInScope.join(",")],
    enabled: classificationIdsInScope.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cam_expense_inputs")
        .select("classification_result_id, publication_status, status")
        .in("classification_result_id", classificationIdsInScope)
        .in("publication_status", ["published", "withdrawn", "superseded"]);
      if (error) return new Map();
      return new Map((data || []).map((r) => [r.classification_result_id, r.publication_status]));
    },
  });

  const rows = useMemo(() => {
    return buildClassificationRows({
      approvedActuals,
      approvedRules,
      existingClassifications,
      scopedLeases,
      leases,
      leaseById,
      propertyById,
      buildingById,
      unitById,
      tenantById,
      scopeYear
    });
  }, [approvedActuals, approvedRules, existingClassifications, scopedLeases, leases, leaseById, propertyById, buildingById, unitById, tenantById, scopeYear]);

  // Single source of truth for each row's CAM Input Decision (used by the
  // badge, the tabs below, and the counts) -- computed once per row instead
  // of re-deriving it separately in three places.
  const rowDecisions = useMemo(() => {
    const map = new Map();
    for (const row of rows) {
      const publicationStatus = camPublicationStatusByClassificationId.get(row.classificationRecord?.id) || null;
      const readiness = getCamPublicationReadiness(row, { publicationStatus });
      map.set(row.id, { readiness, decision: getCamInputDecision(row, { readiness, publicationStatus }) });
    }
    return map;
  }, [rows, camPublicationStatusByClassificationId]);

  const canSendRowToCam = (row) => rowDecisions.get(row?.id)?.decision?.state === "ready_to_send";

  // Target 5-tab structure: Coverage Gaps (approved lease rules with no
  // actual expense yet) are a separate population, never mixed into the
  // actual-expense grid. The other tabs are filtered views of the
  // one-row-per-approved-actual-expense population.
  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      const isCoverageGap = row.rowType === "rule_missing_actual";
      if (activeTab === "coverage_gaps") return isCoverageGap;
      if (isCoverageGap) return false;

      const state = rowDecisions.get(row.id)?.decision.state;
      if (activeTab === "published_to_cam") return state === "published_to_cam";
      if (activeTab === "excluded") return state === "not_cam_eligible";
      if (activeTab === "needs_review") return state !== "ready_to_send" && state !== "not_cam_eligible" && state !== "published_to_cam";
      return true; // actual_expenses (default/master view)
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
  }, [rows, rowDecisions, activeTab, search]);

  const counts = useMemo(() => {
    const actualExpenseRows = rows.filter((row) => row.rowType !== "rule_missing_actual");
    const stateOf = (row) => rowDecisions.get(row.id)?.decision.state;
    return {
      actual_expenses: actualExpenseRows.length,
      published_to_cam: actualExpenseRows.filter((row) => stateOf(row) === "published_to_cam").length,
      excluded: actualExpenseRows.filter((row) => stateOf(row) === "not_cam_eligible").length,
      needs_review: actualExpenseRows.filter((row) => {
        const state = stateOf(row);
        return state !== "ready_to_send" && state !== "not_cam_eligible" && state !== "published_to_cam";
      }).length,
      coverage_gaps: rows.filter((row) => row.rowType === "rule_missing_actual").length,
    };
  }, [rows, rowDecisions]);

  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 15;

  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, search, scopeProperty, scopeBuilding, scopeUnit, scopeLease, scopeTenant, scopeYear]);

  const totalPages = Math.ceil(filteredRows.length / pageSize) || 1;
  const paginatedRows = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, currentPage]);

  const totals = useMemo(() => {
    return rows.reduce((summary, row) => {
      const amount = row.financialAmount;
      if (row.actualExpenseId) {
        summary.approvedActualTotal += amount;
      }
      if (row.rowType === "actual_missing_rule" && row.actualExpenseId) {
        summary.unmatchedActualTotal += amount;
      }
      if (row.rowType === "rule_missing_actual") {
        summary.rulesMissingActualCount += 1;
        summary.ruleGapAmount += amount;
      }
      if (row.rowType !== "matched_classification" || !row.actualExpenseId) return summary;
      const decisionState = rowDecisions.get(row.id)?.decision?.state;
      summary.matchedActualTotal += amount;
      if (decisionState === "ready_to_send" || decisionState === "published_to_cam") summary.recoverable += amount;
      if (decisionState === "not_cam_eligible") summary.excluded += amount;
      if (decisionState === "conditional_review_required") summary.conditional += amount;
      if (row.camEligible === "conditional") summary.conditionalCamEligible += amount;
      if (row.classificationStatus === "finalized") {
        summary.finalized += amount;
        if (decisionState === "ready_to_send" || decisionState === "published_to_cam") {
          summary.finalizedCamEligible += amount;
        }
      }
      if (decisionState === "ready_to_send") summary.camReady += amount;
      if (decisionState === "published_to_cam") summary.sentToCam += amount;
      return summary;
    }, {
      approvedActualTotal: 0,
      matchedActualTotal: 0,
      unmatchedActualTotal: 0,
      rulesMissingActualCount: 0,
      ruleGapAmount: 0,
      recoverable: 0,
      nonRecoverable: 0,
      conditional: 0,
      excluded: 0,
      camEligible: 0,
      conditionalCamEligible: 0,
      finalized: 0,
      finalizedCamEligible: 0,
      camReady: 0,
      sentToCam: 0,
    });
  }, [rows, rowDecisions]);

  const actionableFilteredIds = useMemo(
    () => filteredRows.filter((row) => row.actualExpenseId).map((row) => row.id),
    [filteredRows]
  );

  const selectedActionCounts = useMemo(() => {
    const selectedRows = [...selectedIds]
      .map((id) => rows.find((row) => row.id === id))
      .filter(Boolean);
    return {
      finalize: selectedRows.filter((row) => row.canFinalize).length,
      review: selectedRows.filter((row) => row.canSendToReview).length,
      cam: selectedRows.filter((row) => canSendRowToCam(row)).length,
    };
  }, [rows, rowDecisions, selectedIds]);

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
        targetRows.map((row) => {
          const recoveryStatus = ["recoverable", "non_recoverable", "conditional", "excluded"].includes(row.recoverabilityResult)
            ? row.recoverabilityResult
            : "recoverable";
          return expenseService.finalizeExpenseClassification(
            row.classificationRecord || row.actualExpenseId,
            recoveryStatus
          );
        })
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
        .filter((row) => canSendRowToCam(row));

      const requiresManualReason = targetRows.some((row) => !isAutomaticCamReadyRow(row));
      let manualReason = "";
      if (requiresManualReason) {
        manualReason = window.prompt("Enter the review reason for sending these actual expenses to CAM:") || "";
        if (!manualReason.trim()) {
          throw new Error("A reason is required to manually send an actual expense to CAM.");
        }
      }

      await Promise.all(
        targetRows.map(async (row) => {
          const manualCamEligible =
            row.rowType === "actual_missing_rule" && !row.rule && row.camEligible === "no"
              ? "needs_review"
              : row.camEligible;
          const classificationInput = {
            ...(row.classificationRecord || {}),
            org_id: row.expense?.org_id,
            expense_id: row.actualExpenseId,
            actual_expense_id: row.actualExpenseId,
            lease_expense_rule_id: row.leaseExpenseRuleId,
            property_id: row.expense?.property_id || row.property?.id,
            building_id: row.expense?.building_id || row.building?.id,
            unit_id: row.expense?.unit_id || row.unit?.id,
            lease_id: row.lease?.id,
            tenant_id: row.lease?.tenant_id,
            expense_category_id:
              row.expenseCategoryId ||
              row.classificationRecord?.expense_category_id ||
              row.rule?.expense_category_id ||
              null,
            category: row.expense?.category,
            amount: row.amount,
            recoverability_result: row.recoverabilityResult,
            recovery_status: row.recoverabilityResult,
            cam_eligible: manualCamEligible,
            cam_status: row.camStatus || "needs_review",
            cam_source: "none",
            cam_input_type: "actual_expense",
            classification_status: row.classificationStatus,
          };
          return expenseService.sendClassificationToCam(classificationInput, { reason: manualReason });
        })
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

  const linkExistingExpenseMutation = useMutation({
    mutationFn: async ({ row, expenseId }) => expenseService.linkActualExpenseToLeaseRule({ expenseId, rule: row.rule }),
    onSuccess: () => {
      toast.success("Actual expense linked to lease rule");
      setLinkExpenseRow(null);
      setSelectedExistingExpenseId("");
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-diagnostics"] });
      queryClient.invalidateQueries({ queryKey: ["Expense"] });
      queryClient.invalidateQueries({ queryKey: ["expense-dashboard-classifications"] });
    },
    onError: (error) => toast.error(error?.message || "Could not link actual expense"),
  });
  const markNoExpenseMutation = useMutation({
    mutationFn: async (row) => {
      if (!row?.rule?.id) throw new Error("Select a valid rule coverage gap.");
      const reason = window.prompt("Reason for confirming no expense this period:", "Confirmed by property accounting");
      if (!reason || !reason.trim()) throw new Error("A reason is required to confirm no expense.");
      return expenseService.recordCoverageGapResolution({
        ruleId: row.rule.id,
        period: scopeYear === "all" ? new Date().getFullYear().toString() : scopeYear.toString(),
        resolution: "no_expense_this_period",
        reason: reason.trim(),
      });
    },
    onSuccess: () => {
      toast.success("Coverage gap resolved: 'No Expense This Period' recorded as audit evidence (no $0 financial row created)");
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-diagnostics"] });
    },
    onError: (error) => toast.error(error?.message || "Could not record gap resolution"),
  });

  const withdrawFromCamMutation = useMutation({
    mutationFn: async (row) => {
      const reason = window.prompt(
        `Enter a reason for withdrawing "${row.vendor || row.ruleLabel || "this expense"}" from CAM. The published version is kept (never deleted); republishing after re-finalizing will create a new version.`,
      );
      if (!reason || !reason.trim()) {
        throw new Error("A reason is required to withdraw a published CAM input.");
      }
      return expenseService.withdrawClassificationFromCam(row.classificationRecord, reason.trim());
    },
    onSuccess: (result) => {
      const staleCount = result?.stale_snapshot_count || 0;
      const restatementCount = result?.restatement_required_snapshot_count || 0;
      const extra = [
        staleCount ? `${staleCount} CAM snapshot(s) marked stale` : null,
        restatementCount ? `${restatementCount} locked snapshot(s) flagged for restatement` : null,
      ].filter(Boolean).join(", ");
      toast.success(`Withdrawn from CAM${extra ? ` - ${extra}` : ""}`);
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-diagnostics"] });
    },
    onError: (error) => toast.error(error?.message || "Could not withdraw from CAM"),
  });

  // The only reachable way to close out a conditional row -- previously
  // nothing in the app could ever flip condition_resolved, so a genuinely
  // conditional expense was permanently stuck and could never reach CAM
  // (Send to CAM's server-side gate rejects it forever otherwise).
  const resolveConditionMutation = useMutation({
    mutationFn: async (row) => {
      const wantsRecoverable = window.confirm(
        `Resolve the condition on "${row.vendor || row.ruleLabel || "this expense"}".\n\nOK = Recoverable (becomes CAM-eligible)\nCancel = Not Recoverable (stays out of CAM)`,
      );
      const resolution = wantsRecoverable ? "recoverable" : "non_recoverable";
      const reason = window.prompt(`Reason for marking this expense ${resolution.replace("_", " ")}:`);
      if (!reason || !reason.trim()) {
        throw new Error("A reason is required to resolve a conditional expense.");
      }
      return resolveExpenseClassificationCondition({ classificationId: row.classificationRecord.id, resolution, reason: reason.trim() });
    },
    onSuccess: () => {
      toast.success("Condition resolved");
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-diagnostics"] });
    },
    onError: (error) => toast.error(error?.message || "Could not resolve condition"),
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

  const manualOverrideMutation = useMutation({
    mutationFn: async ({ classificationId, payload }) => {
      return expenseService.markManualOverride(classificationId, payload);
    },
    onSuccess: () => {
      toast.success("Manual override applied");
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-diagnostics"] });
    },
    onError: (error) => toast.error(error?.message || "Could not apply manual override"),
  });

  const publishRuleMutation = useMutation({
    mutationFn: async (ruleId) => {
      return expenseService.publishRuleToCamSetup(ruleId);
    },
    onSuccess: () => {
      toast.success("Published rule to CAM setup");
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-diagnostics"] });
    },
    onError: (error) => toast.error(error?.message || "Could not publish rule"),
  });

  const isLoading = loadingLeases || loadingWorkspace;
  const yearOptions = [2021, 2022, 2023, 2024, 2025, 2026, 2027];
  const rawCounts = diagnostics?.raw_db_counts || {};
  const scopedCounts = diagnostics?.counts_after_scope_filters || {};
  const hiddenCounts = diagnostics?.hidden_by_filter_counts || {};

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

  const promptForOverride = (row) => {
    if (!row?.classificationRecord?.id) return;
    const reason = window.prompt("Enter manual override reason:");
    if (!reason) return;
    
    manualOverrideMutation.mutate({
      classificationId: row.classificationRecord.id,
      payload: {
        override_reason: reason,
        override_type: "cam_eligibility",
        override_previous_value: { cam_eligible: row.camEligible, recoverability_result: row.recoverabilityResult },
        override_new_value: { cam_eligible: "yes", recoverability_result: "recoverable" },
      }
    });
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
    <div className="p-6 space-y-6">
      <PageHeader icon={CheckCircle} title="Expense Recoverability" subtitle="Classification Engine">
        {/* Carry scope (property/building/unit + lease_id) so the Exception Queue is auto-filtered to this lease instead of showing all-org exceptions. */}
        <Button size="sm" variant="outline" onClick={() => navigate(createPageUrl("ExpenseReview", {
          property: selectedLease?.property_id,
          building: selectedLease?.building_id,
          unit: selectedLease?.unit_id,
          lease_id: selectedLease?.id,
        }))}>
          <CheckCircle className="mr-1.5 h-4 w-4" /> Expense Review
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-3 text-xs">
            <span className="mr-1 font-medium uppercase tracking-wider text-slate-500">Scope:</span>
            <select className="h-9 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 outline-none focus:ring-1 focus:ring-[var(--accent)]" value={scopeProperty} onChange={(event) => setScopeProperty(event.target.value)}>
              <option value="all">All Properties</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.property_name || property.name}
                </option>
              ))}
            </select>
            <select className="h-9 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 outline-none focus:ring-1 focus:ring-[var(--accent)]" value={scopeBuilding} onChange={(event) => setScopeBuilding(event.target.value)}>
              <option value="all">All Buildings</option>
              {buildings
                .filter((building) => scopeProperty === "all" || building.property_id === scopeProperty)
                .map((building) => (
                  <option key={building.id} value={building.id}>
                    {building.building_name || building.name}
                  </option>
                ))}
            </select>
            <select className="h-9 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 outline-none focus:ring-1 focus:ring-[var(--accent)]" value={scopeUnit} onChange={(event) => setScopeUnit(event.target.value)}>
              <option value="all">All Units</option>
              {units
                .filter((unit) => scopeBuilding === "all" || unit.building_id === scopeBuilding)
                .map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.unit_number || unit.unit_id_code}
                  </option>
                ))}
            </select>
            <select className="h-9 min-w-[220px] rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 outline-none focus:ring-1 focus:ring-[var(--accent)]" value={scopeLease} onChange={(event) => setScopeLease(event.target.value)}>
              <option value="all">All Leases</option>
              {scopedLeases.map((lease) => (
                <option key={lease.id} value={lease.id}>
                  {lease.tenant_name || lease.id.slice(0, 8)}
                </option>
              ))}
            </select>
            <select className="h-9 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 outline-none focus:ring-1 focus:ring-[var(--accent)]" value={scopeTenant} onChange={(event) => setScopeTenant(event.target.value)}>
              <option value="all">All Tenants</option>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name || tenant.tenant_name || tenant.id?.slice?.(0, 8) || "Tenant"}
                </option>
              ))}
            </select>
            <select className="h-9 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 outline-none focus:ring-1 focus:ring-[var(--accent)]" value={scopeYear} onChange={(event) => setScopeYear(event.target.value)}>
              <option value="all">All Years</option>
              {yearOptions.map((year) => (
                <option key={year} value={String(year)}>
                  FY {year}
                </option>
              ))}
            </select>
        </CardContent>
      </Card>

      <div className="w-full space-y-6">
        {!isLoading && approvedActuals.length === 0 && actualEmptyState && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-amber-900">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div className="flex-1">
              <p className="text-sm font-semibold">Actual Expense Input</p>
              <p className="mt-1 text-xs text-amber-700">{actualEmptyState}</p>
            </div>
            <Button size="sm" variant="outline" className="h-8 border-amber-300 bg-white text-xs text-amber-900" onClick={() => navigate(createPageUrl("Expenses", {
  property: selectedLease?.property_id,
  building: selectedLease?.building_id,
  unit: selectedLease?.unit_id,
  lease_id: selectedLease?.id,
}))}>
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

        {!isLoading && hasUnlinkedExpenses && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-amber-900">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
            <div className="flex-1">
              <p className="text-sm font-semibold">Some Expenses Are Not Linked to a Lease</p>
              <p className="mt-1 text-xs text-amber-700">
                {unlinkedActualsCount} approved expense{unlinkedActualsCount === 1 ? '' : 's'} have no lease linked.
                These cannot be automatically matched to lease rules. Open each expense on the{' '}
                <button
                  className="font-semibold underline"
                  onClick={() => navigate(createPageUrl("Expenses"))}
                >
                  Actual Expenses
                </button>
                {' '}page and set the Lease field to enable matching.
              </p>
            </div>
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

        <div className="flex items-center justify-end">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[11px] text-slate-600 hover:text-slate-900"
            onClick={() => setShowClassificationDebug((prev) => !prev)}
          >
            {showClassificationDebug ? "Hide" : "Show"} classification diagnostics
          </Button>
        </div>

        {showClassificationDebug && (
          <ClassificationDebugPanel
            ruleExclusions={ruleExclusions}
            actualExclusions={actualExclusions}
            summary={workspaceSummary}
            counts={counts}
            existingClassifications={existingClassifications}
          />
        )}



        <Card className="border-slate-200 bg-white shadow-sm">
          <CardContent className="p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Classification Trace</p>
                <p className="text-sm font-semibold text-slate-900">Approved actuals to lease rules to CAM-ready costs</p>
              </div>
              <Badge className="bg-slate-100 text-slate-700">
                {counts.published_to_cam} sent to CAM
              </Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Total Approved Actuals</p>
                <p className="mt-1 text-lg font-bold text-slate-900">{fmt(totals.approvedActualTotal)}</p>
                <p className="mt-1 text-xs text-slate-500">{approvedActuals.length} approved expense row(s)</p>
              </div>
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">Matched To Rules</p>
                <p className="mt-1 text-lg font-bold text-emerald-900">{fmt(totals.matchedActualTotal)}</p>
                <p className="mt-1 text-xs text-emerald-700">{rows.filter((row) => row.rowType === "matched_classification").length} matched classification row(s)</p>
              </div>
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700">Needs Decision</p>
                <p className="mt-1 text-lg font-bold text-amber-900">{fmt(totals.unmatchedActualTotal + totals.conditional + totals.ruleGapAmount)}</p>
                <p className="mt-1 text-xs text-amber-700">
                  {rows.filter((row) => row.rowType === "actual_missing_rule").length} actual gap(s), {totals.rulesMissingActualCount} rule gap(s)
                </p>
              </div>
              <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-blue-700">CAM Ready Basis</p>
                <p className="mt-1 text-lg font-bold text-blue-900">{fmt(totals.camReady)}</p>
                <p className="mt-1 text-xs text-blue-700">
                  {fmt(totals.sentToCam)} already sent to CAM
                </p>
              </div>
            </div>
            <div className="mt-3 grid gap-2 text-xs text-slate-600 md:grid-cols-3">
              <div className="rounded-md border border-slate-200 p-2">
                Recoverable: <span className="font-semibold text-slate-900">{fmt(totals.recoverable)}</span>
              </div>
              <div className="rounded-md border border-slate-200 p-2">
                Non-recoverable / excluded: <span className="font-semibold text-slate-900">{fmt(totals.nonRecoverable + totals.excluded)}</span>
              </div>
              <div className="rounded-md border border-slate-200 p-2">
                Conditional CAM: <span className="font-semibold text-slate-900">{fmt(totals.conditionalCamEligible)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

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
            <Button size="sm" variant="outline" className="h-9 border-indigo-200 text-xs text-indigo-700 hover:bg-indigo-50" onClick={() => finalizeMutation.mutate(selectedIds)} disabled={finalizeMutation.isPending || selectedActionCounts.finalize === 0}>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              Finalize ({selectedActionCounts.finalize})
            </Button>
            <Button size="sm" variant="outline" className="h-9 border-amber-200 text-xs text-amber-700 hover:bg-amber-50" onClick={() => reviewMutation.mutate(selectedIds)} disabled={reviewMutation.isPending || selectedActionCounts.review === 0}>
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              Send to Review ({selectedActionCounts.review})
            </Button>
            <Button size="sm" className="h-9 bg-blue-600 text-xs hover:bg-blue-700" onClick={() => sendToCamMutation.mutate(selectedIds)} disabled={sendToCamMutation.isPending || selectedActionCounts.cam === 0}>
              <ArrowRightCircle className="mr-1.5 h-3.5 w-3.5" />
              Send to CAM ({selectedActionCounts.cam})
            </Button>
          </div>
        </div>

        {/* Summary bar: approved rules, approved expenses, matched, unmatched */}
        <div className="mb-3 grid grid-cols-4 gap-2 text-center text-xs">
          {[
            { label: "Approved Rules", value: approvedRules.length, colorBg: "bg-slate-50", colorText: "text-slate-900" },
            { label: "Approved Expenses", value: approvedActuals.length, colorBg: "bg-slate-50", colorText: "text-slate-900" },
            { label: "Matched", value: rows.filter(r => r.rowType === "matched_classification").length, colorBg: "bg-emerald-50", colorText: "text-emerald-700" },
            { label: "Unmatched", value: rows.filter(r => r.rowType === "actual_missing_rule" || r.rowType === "rule_missing_actual").length, colorBg: "bg-amber-50", colorText: "text-amber-700" },
          ].map(({ label, value, colorBg, colorText }) => (
            <div key={label} className={`rounded-lg ${colorBg} p-2.5 shadow-sm`}>
              <div className={`text-lg font-bold ${colorText}`}>{value}</div>
              <div className="text-slate-700">{label}</div>
            </div>
          ))}
        </div>

        <Card className="overflow-hidden rounded-xl border-0 bg-white shadow-md">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="border-b bg-slate-50 px-4 pt-3">
              <TabsList className="h-auto flex-wrap gap-1 bg-transparent pb-3">
                {[
                  { value: "actual_expenses", label: `Actual Expenses (${counts.actual_expenses})` },
                  { value: "needs_review", label: `Needs Review (${counts.needs_review})` },
                  { value: "published_to_cam", label: `Published to CAM (${counts.published_to_cam})` },
                  { value: "coverage_gaps", label: `Coverage Gaps (${counts.coverage_gaps})` },
                  { value: "excluded", label: `Excluded (${counts.excluded})` },
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
              {activeTab === "published_to_cam" && (
                <div className="m-4 flex items-center justify-between rounded-xl border border-blue-200 bg-blue-50/80 p-4 text-blue-900 shadow-sm">
                  <div className="flex items-center gap-3">
                    <ArrowRightCircle className="h-5 w-5 text-blue-600" />
                    <div>
                      <p className="text-sm font-semibold">Published CAM Inputs</p>
                      <p className="text-xs text-blue-700">All expenses and contractual rules published here actively feed into the CAM calculation module.</p>
                    </div>
                  </div>
                  <Button size="sm" className="bg-blue-600 text-xs text-white hover:bg-blue-700" onClick={() => navigate(createPageUrl("CAMSetup"))}>
                    Open CAM Module <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
              {activeTab === "coverage_gaps" && (
                <div className="m-4 rounded-xl border border-amber-200 bg-amber-50/80 p-4 text-amber-900 shadow-sm">
                  <p className="text-sm font-semibold">Coverage Gaps - Approved Recovery Rules Without Actual Expenses</p>
                  <p className="text-xs text-amber-700">These lease rules were approved and materialized, but no matching actual expense has been posted for this period yet. They never appear in the Actual Expenses grid.</p>
                </div>
              )}
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
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Expense Date</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Vendor</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Property / Building / Unit</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Lease / Tenant</TableHead>
                      <TableHead className="text-[10px] text-right font-bold uppercase text-slate-500">Actual Amount</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Category</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Service Period</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">CAM Input Decision</TableHead>
                      <TableHead className="text-[10px] font-bold uppercase text-slate-500">Next Step</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      <TableRow>
                        <TableCell colSpan={11} className="py-16 text-center">
                          <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-300" />
                          <p className="mt-2 text-sm text-slate-400">Loading approved actuals, approved rules, and classification rows...</p>
                        </TableCell>
                      </TableRow>
                    ) : filteredRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={11} className="py-16 text-center">
                          <FileText className="mx-auto mb-3 h-10 w-10 text-slate-200" />
                          <p className="text-sm text-slate-400">No rows in this view.</p>
                        </TableCell>
                      </TableRow>
                    ) : (
                      paginatedRows.map((row) => {
                        const isSelected = selectedIds.has(row.id);
                        const hasActualExpense = Boolean(row.actualExpenseId);
                        const propertyLabel = row.property?.property_name || row.property?.name || "-";
                        const buildingLabel = row.building?.building_name || row.building?.name || "-";
                        const unitLabel = row.unit?.unit_number || row.unit?.unit_id_code || "-";
                        const expenseDateLabel = hasActualExpense ? row.expenseDate || "-" : "No actual posted";
                        const vendorLabel = hasActualExpense ? row.vendor || "-" : "Lease rule only";
                        const canPublishContractRuleForCam =
                          row.rowType === "rule_missing_actual" &&
                          row.rule &&
                          leaseExpenseRuleService.isRuleCamPublishable(row.rule);
                        const { readiness, decision: camInputDecision } = rowDecisions.get(row.id) || { readiness: getCamPublicationReadiness(row), decision: getCamInputDecision(row) };
                        const expenseApprovalStatus = hasActualExpense
                          ? normalizeText(row.expense?.approval_status || row.expense?.approved_status) || "pending"
                          : null;

                        const categoryDisplayName =
                          row.expense?.category ||
                          row.ruleCategory ||
                          row.expenseCategory ||
                          (row.ruleLabel && row.ruleLabel !== "ACTUAL MISSING RULE" && row.ruleLabel !== "Actual Missing Rule" ? row.ruleLabel : null) ||
                          "General Expense";
                        const servicePeriodLabel =
                          row.servicePeriodStart && row.servicePeriodEnd
                            ? `${row.servicePeriodStart} - ${row.servicePeriodEnd}`
                            : "-";
                        const sendToCamBlockedReason =
                          camInputDecision.state !== "ready_to_send" && row.actualExpenseId && camInputDecision.state !== "published_to_cam" && readiness.blockers.length > 0
                            ? `Blocked: ${readiness.blockers.join(", ")}`
                            : null;
                        const nextStepLabel = (() => {
                          if (camInputDecision.state === "ready_to_send") return "Send to CAM";
                          if (camInputDecision.state === "published_to_cam") return "Published to CAM";
                          if (camInputDecision.state === "not_cam_eligible") return "Excluded from CAM";
                          if (camInputDecision.state === "conditional_review_required") return "Resolve conditional rule";
                          return row.nextStep;
                        })();

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
                            <TableCell className={`text-xs font-medium ${hasActualExpense ? "text-slate-800" : "text-slate-600"}`}>
                              {expenseDateLabel}
                            </TableCell>
                            <TableCell className={`text-xs font-medium ${hasActualExpense ? "text-slate-800" : "text-slate-600"}`}>
                              {vendorLabel}
                            </TableCell>
                            <TableCell className="text-xs font-medium text-slate-800">
                              <div>{propertyLabel}</div>
                              <div className="text-[11px] font-medium text-slate-700">{buildingLabel} / {unitLabel}</div>
                            </TableCell>
                            <TableCell className="text-xs font-medium text-slate-800">
                              {row.tenantResolution?.tenant?.name ? (
                                <div title={`Resolved via ${row.tenantResolution.source}`}>
                                  {row.tenantResolution.tenant.name}
                                </div>
                              ) : (
                                <div
                                  className="text-slate-700"
                                  title={
                                    row.tenantResolution?.reasonText
                                      ? `No tenant linked: ${row.tenantResolution.reasonText}`
                                      : "No tenant linked"
                                  }
                                >
                                  - <span className="text-amber-500">!</span>
                                </div>
                              )}
                              {row.lease?.tenant_name && row.tenantResolution?.tenant?.name !== row.lease.tenant_name && (
                                <div className="text-[11px] font-medium text-slate-700">via lease: {row.lease.tenant_name}</div>
                              )}
                              {(() => {
                                const matchStatus = resolveMatchStatus(row);
                                if (!matchStatus) return null;
                                return (
                                  <Badge
                                    variant="outline"
                                    className={`mt-1 border text-[9px] uppercase ${matchStatusBadgeClassName(matchStatus.tone)}`}
                                    title="Read-only: how this actual expense was matched to an approved lease recovery policy"
                                  >
                                    {matchStatus.label}
                                  </Badge>
                                );
                              })()}
                            </TableCell>
                            <TableCell className="text-right text-sm font-semibold text-slate-900">
                              {row.actualExpenseId ? (
                                fmt(row.amount)
                              ) : (
                                <span className="text-xs font-medium text-slate-500">No actual posted</span>
                              )}
                            </TableCell>
                            <TableCell className="max-w-[220px] text-xs font-medium text-slate-900">
                              <div className="font-semibold text-slate-800">{categoryDisplayName}</div>
                            </TableCell>
                            <TableCell className="text-xs font-medium text-slate-800">{servicePeriodLabel}</TableCell>
                            <TableCell
                              className="max-w-[220px]"
                              title={sendToCamBlockedReason || row.message}
                            >
                              <Badge variant="outline" className={`text-[10px] uppercase font-semibold ${camInputDecisionClassName(camInputDecision.state)}`}>
                                {camInputDecision.label}
                              </Badge>
                            </TableCell>
                            <TableCell className="max-w-[200px] text-[11px] font-medium text-slate-700" title={sendToCamBlockedReason || row.message}>
                              {nextStepLabel}
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
                                  {canSendRowToCam(row) && (
                                    <DropdownMenuItem onClick={() => sendToCamMutation.mutate(new Set([row.id]))}>
                                      <ArrowRightCircle className="mr-2 h-4 w-4 text-blue-600" />
                                      Send to CAM
                                    </DropdownMenuItem>
                                  )}
                                  {row.sentToCam && (
                                    <DropdownMenuItem onClick={() => withdrawFromCamMutation.mutate(row)}>
                                      <RefreshCw className="mr-2 h-4 w-4 text-amber-600" />
                                      Withdraw from CAM
                                    </DropdownMenuItem>
                                  )}
                                  {row.recoverabilityResult === "conditional" && row.classificationRecord?.id && !row.classificationRecord?.condition_resolved && (
                                    <DropdownMenuItem onClick={() => resolveConditionMutation.mutate(row)}>
                                      <AlertTriangle className="mr-2 h-4 w-4 text-amber-600" />
                                      Resolve Condition
                                    </DropdownMenuItem>
                                  )}
                                  {canPublishContractRuleForCam && (
                                    <DropdownMenuItem onClick={() => publishRuleMutation.mutate(row.rule?.id)}>
                                      <ArrowRightCircle className="mr-2 h-4 w-4 text-blue-600" />
                                      Enable Contract Rule for CAM
                                    </DropdownMenuItem>
                                  )}
                                  {row.rowType === "rule_missing_actual" && (
                                    <>
                                      <DropdownMenuItem onClick={() => { setLinkExpenseRow(row); setSelectedExistingExpenseId(""); }}>
                                        <Plus className="mr-2 h-4 w-4 text-blue-600" />
                                        Link Existing Expense
                                      </DropdownMenuItem>
                                      <DropdownMenuItem onClick={() => markNoExpenseMutation.mutate(row)}>
                                        <FileText className="mr-2 h-4 w-4 text-slate-500" />
                                        Mark No Expense This Period
                                      </DropdownMenuItem>
                                      <DropdownMenuItem onClick={() => navigate(createPageUrl("AddExpense", expenseContextParams(row, { mode: "manual" })))}>
                                        <Plus className="mr-2 h-4 w-4 text-slate-500" />
                                        Add Expense
                                      </DropdownMenuItem>
                                      <DropdownMenuItem onClick={() => navigate(createPageUrl("AddExpense", expenseContextParams(row, { mode: "invoice" })))}>
                                        <FileText className="mr-2 h-4 w-4 text-slate-500" />
                                        Import Expense File
                                      </DropdownMenuItem>
                                    </>
                                  )}
                                  {row.actualExpenseId && (
                                    <DropdownMenuItem onClick={() => promptForAmount(row)}>
                                      <FileText className="mr-2 h-4 w-4 text-emerald-600" />
                                      {row.amount ? "Edit Amount" : "Set Amount"}
                                    </DropdownMenuItem>
                                  )}
                                  {row.classificationRecord?.id && (
                                    <DropdownMenuItem onClick={() => promptForOverride(row)}>
                                      <FileText className="mr-2 h-4 w-4 text-amber-600" />
                                      Manual Override
                                    </DropdownMenuItem>
                                  )}
                                  {row.actualExpenseId && (
                                    <DropdownMenuItem onClick={() => navigate(createPageUrl("Expenses", expenseContextParams(row, { expense_id: row.actualExpenseId })))}>
                                      <FileText className="mr-2 h-4 w-4 text-slate-500" />
                                      View Actual Expense
                                    </DropdownMenuItem>
                                  )}
                                  {row.rule?.id && (
                                    <DropdownMenuItem onClick={() => navigate(createPageUrl("LeaseExpenseRules", expenseContextParams(row, { rule_id: row.rule.id })))}>
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

              {filteredRows.length > 0 && (
                <div className="flex items-center justify-between border-t bg-slate-50 px-4 py-3 text-xs text-slate-600">
                  <div>
                    Showing <span className="font-semibold text-slate-900">{Math.min((currentPage - 1) * pageSize + 1, filteredRows.length)}</span> to{" "}
                    <span className="font-semibold text-slate-900">{Math.min(currentPage * pageSize, filteredRows.length)}</span> of{" "}
                    <span className="font-semibold text-slate-900">{filteredRows.length}</span> expenses
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      disabled={currentPage === 1}
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="mr-1 h-3.5 w-3.5" /> Previous
                    </Button>
                    <span className="px-2 font-medium text-slate-700">
                      Page {currentPage} of {totalPages}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      disabled={currentPage >= totalPages}
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    >
                      Next <ChevronRight className="ml-1 h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </Card>

        <Dialog open={Boolean(linkExpenseRow)} onOpenChange={(open) => {
          if (!open) {
            setLinkExpenseRow(null);
            setSelectedExistingExpenseId("");
          }
        }}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Link Existing Actual Expense</DialogTitle>
              <DialogDescription>
                Select an approved actual expense in this scope and attach it to the lease expense rule. The expense amount is not changed.
              </DialogDescription>
            </DialogHeader>

            {linkableActualExpenses.length > 0 ? (
              <Select value={selectedExistingExpenseId} onValueChange={setSelectedExistingExpenseId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select actual expense" />
                </SelectTrigger>
                <SelectContent>
                  {linkableActualExpenses.map((expense) => (
                    <SelectItem key={expense.id} value={expense.id}>
                      {expense.vendor || expense.vendor_name || expense.category || "Actual expense"} - {expense.date || expense.expense_date || "No date"} - {fmt(expense.amount)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                No approved actual expenses are available in this scope. Add or import an expense with the rule context first.
              </div>
            )}

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={() => { setLinkExpenseRow(null); setSelectedExistingExpenseId(""); }}>
                Cancel
              </Button>
              {linkableActualExpenses.length === 0 ? (
                <Button
                  type="button"
                  onClick={() => navigate(createPageUrl("AddExpense", expenseContextParams(linkExpenseRow, { mode: "manual" })))}
                >
                  Add Expense
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={!selectedExistingExpenseId || linkExistingExpenseMutation.isPending}
                  onClick={() => linkExistingExpenseMutation.mutate({ row: linkExpenseRow, expenseId: selectedExistingExpenseId })}
                >
                  {linkExistingExpenseMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Link Expense
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <div className="flex flex-wrap gap-4 border-t pt-4 text-xs text-slate-500">
          <span className="flex items-center gap-1.5"><ArrowRightCircle className="h-3.5 w-3.5 text-blue-500" /> <strong>CAM:</strong> CAM Ready rows feed CAM calculation.</span>
          <span className="flex items-center gap-1.5"><RefreshCw className="h-3.5 w-3.5 text-emerald-500" /> <strong>Projection:</strong> Finalized classification rows feed Expense Projection.</span>
          <span className="flex items-center gap-1.5"><CheckCircle className="h-3.5 w-3.5 text-indigo-500" /> <strong>Review:</strong> Unmatched actuals and conditional / exception rows go to Expense Review.</span>
        </div>
      </div>
    </div>
  );
}
