/**
 * LeaseExpenseRules - portfolio-wide view of lease expense rules extracted
 * from approved leases. The single-lease editor remains
 * LeaseExpenseClassification; this page is the cross-lease audit and
 * approval surface backed by the existing rule-set tables.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Loader2,
  Receipt,
  RefreshCw,
} from "lucide-react";
import EditRuleModal from "@/components/lease-expense/EditRuleModal";
import RuleDetailDrawer from "@/components/lease-expense/RuleDetailDrawer";
import RuleTableRow from "@/components/lease-expense/RuleTableRow";
import StatCard from "@/components/lease-expense/StatCard";
import PageHeader from "@/components/PageHeader";
import ScopeSelector from "@/components/ScopeSelector";
import useOrgQuery from "@/hooks/useOrgQuery";
import {
  buildHierarchyScope,
  getScopeSubtitle,
  matchesHierarchyScope,
} from "@/lib/hierarchyScope";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";




import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";


import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import {
  approveLeaseExpenseRule,
  createRuleReviewIdempotencyKey,
  markLeaseExpenseRuleNotApplicable,
  rejectLeaseExpenseRule,
} from "@/services/leaseExpenseRuleWorkflowService";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { createNotificationsForEvent } from "@/services/notificationService";
import { createPageUrl } from "@/utils";

const RULE_PATCH_KEYS = [
  "expense_category",
  "expense_subcategory",
  "included_in_base_rent",
  "operational_responsibility",
  "payment_treatment",
  "recoverable_from_tenant",
  "cam_eligible",
  "recovery_method",
  "allocation_basis",
  "cap_type",
  "cap_percent",
  "cap_amount",
  "admin_fee_applicable",
  "admin_fee_percent",
  "gross_up_applicable",
  "gross_up_percent",
  "reconciliation_required",
  "notes",
];

import {
  toNullableNumber,
  fromBooleanString,
  buildRuleEditForm,
  isApprovedRule,
  getPolicyStatus,
  getContractStatus,
  isLeaseDerivedRule,
  isCoverageGapRule,
  getRuleValidation,
  buildRuleHierarchyPatch,
  getLeaseBuildingId,
  buildDisplayRows,
  dedupeDisplayRows,
  calculateRuleCounts,
} from '@/components/lease-expense/utils/leaseExpenseRulesHelpers';
import {
  buildExpenseFindingCoverageRows,
  calculateFindingCoverageCounts,
} from '@/components/lease-expense/utils/expenseFindingCoverage';

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function isApprovedLeaseForExpenseRuleSync(lease) {
  const abstractStatus = normalizeStatus(lease?.abstract_status);
  const status = normalizeStatus(lease?.status);
  return (
    abstractStatus === "approved" ||
    status === "approved" ||
    status === "budget_ready" ||
    Boolean(lease?.abstract_approved_at)
  );
}

export default function LeaseExpenseRules() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [displayMode, setDisplayMode] = useState("lease");
  const [search, setSearch] = useState(() => new URLSearchParams(location.search).get("lease") || "");
  const leaseIdParam = useMemo(() => new URLSearchParams(location.search).get("lease_id") || null, [location.search]);
  const highlightedRuleId = useMemo(() => new URLSearchParams(location.search).get("rule_id") || null, [location.search]);
  const [editingRuleContext, setEditingRuleContext] = useState(null);
  const [detailContext, setDetailContext] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [selectedRuleIds, setSelectedRuleIds] = useState(() => new Set());

  const { data: leases = [], isAdmin } = useOrgQuery("Lease");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");

  const { data: categories = [] } = useQuery({
    queryKey: ["expense-categories"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expense_categories")
        .select("id, category_name, subcategory_name, normalized_key");
      if (error) {
        console.warn("[LeaseExpenseRules] categories query failed:", error.message);
        return [];
      }
      return data || [];
    },
  });

  const scope = useMemo(
    () =>
      buildHierarchyScope({
        search: location.search,
        portfolios,
        properties,
        buildings,
        units,
      }),
    [location.search, portfolios, properties, buildings, units]
  );

  const [scopeProperty, setScopeProperty] = useState(scope.propertyId || "all");
  const [scopeBuilding, setScopeBuilding] = useState(scope.buildingId || "all");
  const [scopeUnit, setScopeUnit] = useState(scope.unitId || "all");

  useEffect(() => {
    setScopeProperty(scope.propertyId || "all");
    setScopeBuilding(scope.buildingId || "all");
    setScopeUnit(scope.unitId || "all");
  }, [scope.propertyId, scope.buildingId, scope.unitId]);

  const scopedLeases = useMemo(
    () =>
      leases.filter((lease) =>
        matchesHierarchyScope(lease, scope, { propertyKey: "property_id", unitKey: "unit_id" }),
      ),
    [leases, scope]
  );

  const selectorFilteredLeases = scopedLeases.filter((lease) => {
    const buildingId = getLeaseBuildingId(lease, scope);
    if (scopeProperty !== "all" && lease.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all" && buildingId !== scopeBuilding) return false;
    if (scopeUnit !== "all" && lease.unit_id !== scopeUnit) return false;
    return true;
  });

  const approvedSelectorFilteredLeases = selectorFilteredLeases.filter(
    isApprovedLeaseForExpenseRuleSync,
  );
  const approvedLeaseIdSet = new Set(
    approvedSelectorFilteredLeases.map((lease) => lease.id),
  );
  const leaseIds = leaseIdParam
    ? approvedLeaseIdSet.has(leaseIdParam) ? [leaseIdParam] : []
    : approvedSelectorFilteredLeases.map((lease) => lease.id);



  const {
    data: serverRuleSets = [],
    isLoading: isLoadingRuleSets,
    error: ruleSetLoadError,
  } = useQuery({
    queryKey: ["lease-expense-rule-sets", leaseIds],
    queryFn: () => leaseExpenseRuleService.loadRuleSets(leaseIds),
    enabled: leaseIds.length > 0,
  });

  const ruleSetsByLease = useMemo(() => {
    const merged = [];
    const scopeIdSet = new Set(leaseIds);
    const hasExplicitSelectorScope = scopeProperty !== "all" || scopeBuilding !== "all" || scopeUnit !== "all";

    if (hasExplicitSelectorScope && scopeIdSet.size === 0) {
      return [];
    }
    
    // Server-loaded persisted rows are the source of truth for actionable rules.
    const persistedLeaseIdsWithRules = new Set();
    for (const entry of serverRuleSets) {
      if (scopeIdSet.size > 0 && !scopeIdSet.has(entry.leaseId)) continue;
      if (entry.rules && entry.rules.length > 0) persistedLeaseIdsWithRules.add(entry.leaseId);
      merged.push(entry);
    }

    const finalMerged = merged.filter((m) => m.rules && m.rules.length > 0);
    console.log("[LeaseExpenseRules] all leases in scope:", leases.map(l => ({ id: l.id, name: l.tenant_name || l.name, abstract_status: l.abstract_status })));
    console.log("[LeaseExpenseRules] merged ruleSetsByLease:", {
      server_entries: serverRuleSets?.length || 0,
      after_scope_filter: finalMerged.length,
    });
    return finalMerged;
  }, [serverRuleSets, leaseIds, scopeProperty, scopeBuilding, scopeUnit, selectorFilteredLeases]);

  const isLoading = isLoadingRuleSets;



  const isUuid = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  const leaseById = useMemo(() => {
    const map = new Map();
    for (const lease of leases) map.set(lease.id, lease);
    return map;
  }, [leases]);

  const categoryById = useMemo(() => {
    const map = new Map();
    for (const category of categories) map.set(category.id, category);
    return map;
  }, [categories]);

  const allDisplayRows = useMemo(
    () => buildDisplayRows(ruleSetsByLease, leaseById, categoryById, scope.propertyById),
    [ruleSetsByLease, leaseById, categoryById, scope]
  );

  // Read-only "CAM Policy" status per rule (Ready/Pending/Blocked/Superseded)
  // -- purely a display of the EXISTING materialize_lease_recovery_policy
  // outcome (auto-triggered on approve), never a second materializer and
  // never a write. Two small, additive queries: which rules already have a
  // materialized policy, and which of their leases have premises on file
  // (materialization's own real precondition -- see
  // prepare-cam-automatically.ts) so a genuinely-blocked rule reads
  // differently from one that's merely still catching up.
  const approvedRuleIds = useMemo(
    () => [...new Set(allDisplayRows.map(({ rule }) => rule?.id).filter((id) => isUuid(id)))],
    [allDisplayRows],
  );
  const { data: camPolicies = [] } = useQuery({
    queryKey: ["lease-expense-rule-cam-policies", approvedRuleIds.join(",")],
    enabled: approvedRuleIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("lease_recovery_policies")
        .select("id, source_rule_id, status, created_at, source_rule_hash, materializer_version")
        .in("source_rule_id", approvedRuleIds)
        .order("created_at", { ascending: false });
      if (error) return [];
      return data || [];
    },
  });
  const policiesBySourceRuleId = useMemo(() => {
    const map = new Map();
    for (const policy of camPolicies) {
      if (!map.has(policy.source_rule_id)) map.set(policy.source_rule_id, []);
      map.get(policy.source_rule_id).push(policy);
    }
    return map;
  }, [camPolicies]);

  const { data: leasesWithPremises = new Set() } = useQuery({
    queryKey: ["lease-expense-rule-premises-check", leaseIds.join(",")],
    enabled: leaseIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("lease_premises")
        .select("lease_id")
        .in("lease_id", leaseIds)
        .neq("status", "superseded");
      if (error) return new Set();
      return new Set((data || []).map((p) => p.lease_id));
    },
  });

  const leaseDerivedRows = useMemo(
    () => dedupeDisplayRows(allDisplayRows.filter(({ rule }) => isLeaseDerivedRule(rule))),
    [allDisplayRows],
  );

  const allFindingRows = useMemo(
    () => buildExpenseFindingCoverageRows({
      leases: approvedSelectorFilteredLeases,
      ruleRows: allDisplayRows,
      propertyById: scope.propertyById,
    }),
    [approvedSelectorFilteredLeases, allDisplayRows, scope.propertyById],
  );

  const coverageGapRows = useMemo(() => {
    const persistedGaps = allDisplayRows.filter(({ rule }) => isCoverageGapRule(rule));
    const evidenceOnlyFindings = allFindingRows.filter(({ rule }) => rule?._findingOnly);
    return dedupeDisplayRows([...persistedGaps, ...evidenceOnlyFindings]);
  }, [allDisplayRows, allFindingRows]);

  const flattenedRows = displayMode === "gaps"
    ? coverageGapRows
    : displayMode === "findings"
      ? allFindingRows
      : leaseDerivedRows;

  // Dev-only diagnostic: print scope / filter / hide counts so we can see why
  // a rule that exists in the DB might not be appearing in the table. Logged
  // once per scope or filter change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const allLeaseIds = leases.map((l) => l.id);
    const scopedLeaseIds = selectorFilteredLeases.map((l) => l.id);
    const rulesByLeaseId = new Map();
    for (const entry of ruleSetsByLease) rulesByLeaseId.set(entry.leaseId, entry.rules?.length || 0);
    const totalRulesInScope = flattenedRows.length;
    const hiddenByStatusFilter = statusFilter === "all" ? 0 : flattenedRows.length - flattenedRows.filter(({ rule }) => {
      const contractStatus = getContractStatus(rule).value;
      if (statusFilter === "needs_review") return contractStatus === "needs_review";
      if (statusFilter === "approved") return contractStatus === "approved";
      if (statusFilter === "rejected") return contractStatus === "rejected";
      return true;
    }).length;
    console.group("[LeaseExpenseRules] diagnostic");
    console.log("leases in org:", allLeaseIds.length);
    console.log("leases in scope:", scopedLeaseIds.length);
    console.log("selected scope:", { property: scopeProperty, building: scopeBuilding, unit: scopeUnit });
    console.log("rule_sets loaded:", ruleSetsByLease.length);
    console.log("rules per lease (in scope):", Object.fromEntries(rulesByLeaseId));
    console.log("total rules in flatten:", totalRulesInScope);
    console.log("status filter:", statusFilter, "→ hidden by filter:", hiddenByStatusFilter);
    console.log("search:", search || "(none)");
    console.groupEnd();
  }, [ruleSetsByLease, flattenedRows, statusFilter, search, scopeProperty, scopeBuilding, scopeUnit, leases, selectorFilteredLeases]);

  const filteredRows = useMemo(() => flattenedRows.filter(({ rule, lease }) => {
    if (search) {
      const haystack = [
        lease?.tenant_name,
        rule.category_name,
        rule.subcategory_name,
        rule.expense_category,
        rule.expense_subcategory,
        rule.responsibility,
        rule.recovery_method,
        rule.allocation_basis,
        rule.exact_source_text,
        rule.notes,
        rule.source,
        rule._coverage?.contractStatus,
        rule._coverage?.expenseTreatment,
        rule._coverage?.camParticipation,
        rule._coverage?.materialization,
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      if (!haystack.some((value) => value.includes(search.toLowerCase()))) return false;
    }

    const contractStatus = getContractStatus(rule).value;
    if (statusFilter === "all") return true;
    if (statusFilter === "needs_review") return contractStatus === "needs_review";
    if (statusFilter === "approved") return contractStatus === "approved";
    if (statusFilter === "rejected") return contractStatus === "rejected";
    return true;
  }), [flattenedRows, search, statusFilter]);

  const counts = useMemo(() => calculateRuleCounts(flattenedRows), [flattenedRows]);
  const coverageSummary = useMemo(() => calculateFindingCoverageCounts(allFindingRows), [allFindingRows]);

  const selectableRuleIds = useMemo(
    () =>
      filteredRows
        .filter(({ rule }) => isUuid(rule?.id) && !isApprovedRule(rule))
        .map(({ rule }) => rule.id),
    [filteredRows],
  );

  const selectedVisibleCount = useMemo(
    () => selectableRuleIds.filter((id) => selectedRuleIds.has(id)).length,
    [selectableRuleIds, selectedRuleIds],
  );

  const allVisibleSelectableSelected =
    selectableRuleIds.length > 0 && selectedVisibleCount === selectableRuleIds.length;

  useEffect(() => {
    setSelectedRuleIds((current) => {
      const selectable = new Set(selectableRuleIds);
      const next = new Set([...current].filter((id) => selectable.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [selectableRuleIds]);

  const persistedLeaseIdsWithRules = useMemo(() => {
    const ids = new Set();
    for (const entry of serverRuleSets || []) {
      if (entry?.leaseId && (entry.rules || []).length > 0) ids.add(entry.leaseId);
    }
    return ids;
  }, [serverRuleSets]);

  const approvedLeasesMissingRules = useMemo(
    () =>
      selectorFilteredLeases
        .filter((lease) => !leaseIdParam || lease.id === leaseIdParam)
        .filter(isApprovedLeaseForExpenseRuleSync)
        .filter((lease) => !persistedLeaseIdsWithRules.has(lease.id)),
    [selectorFilteredLeases, leaseIdParam, persistedLeaseIdsWithRules],
  );

  const openRuleEditor = (context) => {
    setEditingRuleContext(context);
    setEditForm(buildRuleEditForm(context.rule));
  };

  const closeRuleEditor = () => {
    setEditingRuleContext(null);
    setEditForm(null);
  };

  const updateRuleMutation = useMutation({
    mutationFn: async ({ ruleId, leaseId, patch }) => {
      if (!isUuid(ruleId) || String(ruleId).startsWith("workflow-rule-")) {
        throw new Error("Cannot update an unsaved rule. Sync approved rules first.");
      }
      // Only the 18 business fields the rule-editor dialog actually edits are
      // sent to the RPC -- hierarchy fields (buildRuleHierarchyPatch) just
      // re-stamp already-unchanged values and aren't in the RPC's whitelist.
      const businessPatch = Object.fromEntries(
        Object.entries(patch).filter(([key]) => RULE_PATCH_KEYS.includes(key)),
      );
      const result = await invokeEdgeFunction("update-lease-expense-rule", {
        rule_id: ruleId,
        lease_id: leaseId,
        patch: businessPatch,
      });
      return result?.rule;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lease-expense-rule-sets"] });
      queryClient.invalidateQueries({ queryKey: ["expense-classification-rule-sets"] });
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
      queryClient.invalidateQueries({ queryKey: ["expense-recoverability-diagnostics"] });
    },
    onError: (error) => toast.error(error?.message || "Could not update rule"),
  });

  const invalidateRuleWorkflowQueries = () => {
    queryClient.invalidateQueries({ queryKey: ["lease-expense-rule-sets"] });
    queryClient.invalidateQueries({ queryKey: ["expense-classification-rule-sets"] });
    queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
    queryClient.invalidateQueries({ queryKey: ["expense-recoverability-diagnostics"] });
  };

  const syncApprovedLeaseRulesMutation = useMutation({
    mutationFn: async () => {
      const candidates = approvedLeasesMissingRules;
      if (candidates.length === 0) {
        return { checked: 0, repaired: 0, rules: 0, failed: [], empty: [] };
      }

      const summary = {
        checked: candidates.length,
        repaired: 0,
        rules: 0,
        failed: [],
        empty: [],
      };

      for (const lease of candidates) {
        try {
          const persisted = await leaseExpenseRuleService.syncApprovedLeaseExpenseRules({
            leaseId: lease.id,
          });

          const persistedCount = Number(persisted?.rules_persisted || 0);

          if (persistedCount > 0) {
            summary.repaired += 1;
            summary.rules += persistedCount;
          } else {
            summary.empty.push({
              lease: lease?.tenant_name || lease?.name || lease.id,
              reason: persisted?.reason || persisted?.status || "no_rules_generated",
              source_file_found: persisted?.source_file_found ?? null,
              workflow_found: persisted?.workflow_found ?? null,
              workflow_clauses_found: persisted?.workflow_clauses_found ?? null,
              rules_generated: persisted?.rules_generated ?? 0,
              expense_rule_source: persisted?.expense_rule_source ?? null,
            });
          }
        } catch (error) {
          summary.failed.push({
            lease: lease?.tenant_name || lease?.name || lease.id,
            message: error?.message || "Unknown error",
          });
        }
      }

      return summary;
    },
    onSuccess: (summary) => {
      invalidateRuleWorkflowQueries();
      queryClient.invalidateQueries({ queryKey: ["Expense"] });
      queryClient.invalidateQueries({ queryKey: ["leases"] });

      if (summary.rules > 0) {
        toast.success(
          `Synced ${summary.rules} lease expense rule${summary.rules === 1 ? "" : "s"} from ${summary.repaired} approved lease${summary.repaired === 1 ? "" : "s"}.`,
        );
      } else if (summary.checked === 0) {
        toast.info("No approved leases in this scope need expense-rule sync.");
      } else {
        const missingSources = summary.empty.filter((item) => item.reason === "approved_lease_source_not_found").length;
        const requiresReextraction = summary.empty.filter(
          (item) => item.reason === "approved_lease_reextraction_required",
        ).length;
        const message = summary.empty.length > 0 && missingSources === summary.empty.length
          ? "No rules were created because the approved leases are not linked to their source documents."
          : summary.empty.length > 0 && requiresReextraction === summary.empty.length
            ? "These approved leases use an older extraction contract. Re-extract them to generate canonical LLM expense rules."
          : summary.empty.length > 0
            ? "No source-backed expense/CAM clauses could be generated. Review the per-lease diagnostics in the console."
            : "Approved lease expense-rule synchronization failed. Review the error details in the console.";
        toast.warning(
          message,
        );
        console.warn("[LeaseExpenseRules] approved lease rule sync produced no rows:", summary.empty);
      }

      if (summary.failed.length > 0) {
        const firstFailure = summary.failed[0]?.message;
        toast.error(
          firstFailure
            ? `${summary.failed.length} lease${summary.failed.length === 1 ? "" : "s"} could not be synced: ${firstFailure}`
            : `${summary.failed.length} lease${summary.failed.length === 1 ? "" : "s"} could not be synced. Check console logs for details.`,
        );
        console.warn("[LeaseExpenseRules] approved lease rule sync failures:", summary.failed);
      }
    },
    onError: (error) => toast.error(error?.message || "Could not sync approved lease expense rules"),
  });

  const ruleReviewMutation = useMutation({
    mutationFn: async ({ action, ruleId, reason }) => {
      const idempotencyKey = createRuleReviewIdempotencyKey(ruleId, action);
      if (action === "approve") {
        return approveLeaseExpenseRule({ ruleId, reason, idempotencyKey });
      }
      if (action === "reject") {
        return rejectLeaseExpenseRule({ ruleId, reason, idempotencyKey });
      }
      return markLeaseExpenseRuleNotApplicable({ ruleId, reason, idempotencyKey });
    },
    onSuccess: (_result, variables) => {
      invalidateRuleWorkflowQueries();
      const eventByAction = {
        approve: "lease_rule.approved",
        reject: "lease_rule.rejected",
        not_applicable: "lease_rule.rejected",
      };
      const eventType = eventByAction[variables?.action];
      if (eventType) notifyRuleEvent(eventType, variables.ruleId, `lease_expense_rule_${variables.action}`);
    },
    onError: (error) => toast.error(error?.message || "Could not review rule"),
  });

  const bulkApproveRulesMutation = useMutation({
    mutationFn: async () => {
      const selected = new Set(selectedRuleIds);
      const targets = filteredRows.filter(({ rule }) => selected.has(rule?.id));
      const summary = { approved: 0, skipped: [], failed: [] };

      for (const { rule, lease } of targets) {
        try {
          const persistedRule = await ensurePersistedRule(rule, lease);
          const now = new Date().toISOString();
          const approvalPreview = {
            ...persistedRule,
            review_status: "approved",
            approval_status: "approved",
            approved_by: persistedRule.approved_by || null,
            approved_at: now,
            updated_at: now,
          };
          const validation = getRuleValidation(approvalPreview);
          if (!validation.canApprove) {
            summary.skipped.push({
              ruleId: persistedRule.id,
              reason: validation.approvalBlockers[0] || "Rule is missing required approval evidence.",
            });
            continue;
          }

          await approveLeaseExpenseRule({
            ruleId: persistedRule.id,
            reason: "Bulk approved from Lease Expense Rules review",
            idempotencyKey: createRuleReviewIdempotencyKey(persistedRule.id, "approve"),
          });
          summary.approved += 1;
        } catch (error) {
          summary.failed.push({
            ruleId: rule?.id,
            message: error?.message || "Could not approve rule",
          });
        }
      }

      return summary;
    },
    onSuccess: (summary) => {
      invalidateRuleWorkflowQueries();
      setSelectedRuleIds(new Set());

      if (summary.approved > 0) {
        toast.success(`Approved ${summary.approved} lease expense rule${summary.approved === 1 ? "" : "s"}.`);
      }
      if (summary.skipped.length > 0) {
        toast.warning(`${summary.skipped.length} selected rule${summary.skipped.length === 1 ? "" : "s"} need edits before approval.`);
        console.warn("[LeaseExpenseRules] bulk approve skipped rules:", summary.skipped);
      }
      if (summary.failed.length > 0) {
        const firstFailure = summary.failed[0]?.message;
        toast.error(
          firstFailure
            ? `${summary.failed.length} selected rule${summary.failed.length === 1 ? "" : "s"} failed: ${firstFailure}`
            : `${summary.failed.length} selected rule${summary.failed.length === 1 ? "" : "s"} failed. Check console logs for details.`,
        );
        console.warn("[LeaseExpenseRules] bulk approve failed rules:", summary.failed);
      }
    },
    onError: (error) => toast.error(error?.message || "Could not approve selected rules"),
  });

  const ensurePersistedRule = async (rule, lease) => {
    if (isUuid(rule?.id)) {
      return rule;
    }

    const leaseName = lease?.tenant_name || lease?.name || "this lease";
    toast.error(`Expense rules for ${leaseName} are not persisted yet. Use Sync Approved Rules, then review the saved rows.`);
    throw new Error("Expense rule is not persisted");
  };

  const notifyRuleEvent = (eventType, ruleId, source) => {
    const context = allDisplayRows.find(({ rule }) => rule?.id === ruleId) || {};
    const { rule, lease, property, category } = context;
    createNotificationsForEvent({
      org_id: rule?.org_id || lease?.org_id || property?.org_id,
      event_type: eventType,
      entity_type: "lease_expense_rule",
      entity_id: ruleId,
      entity_label: category?.name || rule?.expense_category || rule?.rule_type || "Lease Expense Rule",
      portfolio_id: property?.portfolio_id || null,
      property_id: rule?.property_id || lease?.property_id || property?.id || null,
      action_url: createPageUrl("LeaseExpenseRules"),
      metadata: {
        source,
        lease_name: lease?.tenant_name || lease?.name || null,
        property_name: property?.name || property?.property_name || null,
        rule_category: category?.name || rule?.expense_category || null,
        status: eventType.replace("lease_rule.", ""),
      },
    }).catch((error) => {
      console.warn("[LeaseExpenseRules] notification event failed:", error?.message || error);
    });
  };

  const approveRule = async (rawRule, lease) => {
    let rule;
    try {
      rule = await ensurePersistedRule(rawRule, lease);
    } catch {
      return;
    }

    const now = new Date().toISOString();
    const approvalPreview = {
      ...rule,
      review_status: "approved",
      approval_status: "approved",
      approved_by: rule.approved_by || null,
      approved_at: now,
      updated_at: now,
    };
    const validation = getRuleValidation(approvalPreview);
    if (!validation.canApprove) {
      toast.error(validation.approvalBlockers[0] || "This rule needs real lease evidence before approval.");
      return;
    }
    console.log("[Approve Rule clicked]", rule.id);
    await ruleReviewMutation.mutateAsync({
      action: "approve",
      ruleId: rule.id,
      reason: "Approved from Lease Expense Rules review",
    });
    toast.success("Rule approved");
  };

  const rejectRule = async (rawRule, lease) => {
    let rule;
    try {
      rule = await ensurePersistedRule(rawRule, lease);
    } catch {
      return;
    }
    return ruleReviewMutation.mutateAsync({
      action: "reject",
      ruleId: rule.id,
      reason: "Rejected from Lease Expense Rules review",
    }).then(() => {
      toast.success("Rule rejected");
    });
  };

  const markNARule = async (rawRule, lease) => {
    let rule;
    try {
      rule = await ensurePersistedRule(rawRule, lease);
    } catch {
      return;
    }
    return ruleReviewMutation.mutateAsync({
      action: "not_applicable",
      ruleId: rule.id,
      reason: "Marked not applicable from Lease Expense Rules review",
    }).then(() => toast.success("Rule marked N/A"));
  };

  const toggleRuleSelection = (ruleId, checked) => {
    if (!ruleId) return;
    setSelectedRuleIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(ruleId);
      } else {
        next.delete(ruleId);
      }
      return next;
    });
  };

  const toggleAllVisibleRules = (checked) => {
    setSelectedRuleIds((current) => {
      const next = new Set(current);
      for (const ruleId of selectableRuleIds) {
        if (checked) {
          next.add(ruleId);
        } else {
          next.delete(ruleId);
        }
      }
      return next;
    });
  };

  const saveRuleEdits = async () => {
    if (!editingRuleContext?.rule || !editForm) return;
    const patch = {
      ...buildRuleHierarchyPatch(editingRuleContext.lease),
      expense_category: editForm.category_name || null,
      expense_subcategory: editForm.expense_subcategory || null,
      included_in_base_rent: fromBooleanString(editForm.included_in_base_rent),
      operational_responsibility: editForm.responsibility || null,
      payment_treatment: editForm.payment_treatment || "not_applicable",
      recoverable_from_tenant: editForm.recoverable_from_tenant || "no",
      cam_eligible: editForm.cam_eligible || "no",
      recovery_method: editForm.recovery_method || "not_applicable",
      allocation_basis: editForm.allocation_basis === "none" ? null : editForm.allocation_basis,
      cap_type: editForm.cap_type || null,
      cap_percent: toNullableNumber(editForm.cap_percent),
      cap_amount: toNullableNumber(editForm.cap_amount),
      admin_fee_applicable: fromBooleanString(editForm.admin_fee_applicable),
      admin_fee_percent: toNullableNumber(editForm.admin_fee_percent),
      gross_up_applicable: fromBooleanString(editForm.gross_up_applicable),
      gross_up_percent: toNullableNumber(editForm.gross_up_percent),
      reconciliation_required: fromBooleanString(editForm.reconciliation_required),
      notes: editForm.notes || null,
      updated_at: new Date().toISOString(),
    };
    await updateRuleMutation.mutateAsync({
      ruleId: editingRuleContext.rule.id,
      leaseId: editingRuleContext.lease?.id || editingRuleContext.rule.lease_id,
      patch,
    });
    toast.success("Rule details updated");
    closeRuleEditor();
  };

  const subtitle = getScopeSubtitle(scope, {
    default: displayMode === "gaps"
      ? `${filteredRows.length} coverage gap${filteredRows.length === 1 ? "" : "s"} / not materialized`
      : displayMode === "findings"
        ? `${filteredRows.length} expense-related finding${filteredRows.length === 1 ? "" : "s"} accounted for`
        : `${filteredRows.length} normalized lease expense rule${filteredRows.length === 1 ? "" : "s"}`,
  });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Receipt}
        title="Lease Expense Rules"
        subtitle={subtitle}
        iconColor="from-amber-500 to-orange-600"
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => syncApprovedLeaseRulesMutation.mutate()}
          disabled={isLoadingRuleSets || syncApprovedLeaseRulesMutation.isPending || approvedLeasesMissingRules.length === 0}
          title={
            approvedLeasesMissingRules.length === 0
              ? "No approved leases in this scope are missing persisted expense rules."
              : "Create lease expense rule rows for approved leases that do not have them yet."
          }
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${syncApprovedLeaseRulesMutation.isPending ? "animate-spin" : ""}`} />
          Sync Approved Rules
          {approvedLeasesMissingRules.length > 0 ? ` (${approvedLeasesMissingRules.length})` : ""}
        </Button>
      </PageHeader>

      {leaseIdParam && (
        <div className="flex items-center gap-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
          Showing expense rules for one lease only —{" "}
          <Link to={createPageUrl("LeaseExpenseRules")} className="underline">
            View all leases
          </Link>
        </div>
      )}

      <Card className="border-blue-200 bg-blue-50">
        <CardContent className="flex items-start gap-2 p-4 text-sm text-blue-800">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div>
            <p className="font-medium">Rules vs. Actuals</p>
            <p className="text-xs">
              Lease expense rules come from the lease document. Actual expense dollars come from
              invoices, imports, or accounting integrations - see{" "}
              <Link to={createPageUrl("Expenses")} className="underline">
                Actual Expenses
              </Link>
              . This page separates evidence findings, contract approval, CAM participation, and actual-expense expectation.
            </p>
          </div>
        </CardContent>
      </Card>

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

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        <StatCard label="All Findings" value={coverageSummary.all} />
        <StatCard label="Actionable Rules" value={coverageSummary.rule_candidates} accent="border-l-amber-500 bg-amber-50" />
        <StatCard label="Contract Approved" value={coverageSummary.contract_approved} accent="border-l-emerald-500 bg-emerald-50" />
        <StatCard label="CAM Eligible" value={coverageSummary.cam_enabled} accent="border-l-blue-500 bg-blue-50" />
        <StatCard label="Landlord Expense Expected" value={coverageSummary.actual_expected} accent="border-l-purple-500 bg-purple-50" />
        <StatCard label="Evidence Only" value={coverageSummary.evidence_only} accent="border-l-slate-400 bg-slate-50" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="max-w-sm"
          placeholder="Search tenant, category, clause..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Tabs value={statusFilter} onValueChange={setStatusFilter}>
          <TabsList className="bg-white border">
            <TabsTrigger value="all" className="text-xs">All ({counts.all})</TabsTrigger>
            <TabsTrigger value="needs_review" className="text-xs">Needs Review ({counts.needs_review})</TabsTrigger>
            <TabsTrigger value="approved" className="text-xs">Approved ({counts.approved})</TabsTrigger>
            <TabsTrigger value="rejected" className="text-xs">Rejected ({counts.rejected})</TabsTrigger>
          </TabsList>
        </Tabs>
        <Tabs value={displayMode} onValueChange={setDisplayMode}>
          <TabsList className="bg-white border">
            <TabsTrigger value="findings" className="text-xs">All Findings ({allFindingRows.length})</TabsTrigger>
            <TabsTrigger value="lease" className="text-xs">Actionable Rules ({leaseDerivedRows.length})</TabsTrigger>
            <TabsTrigger value="gaps" className="text-xs">Evidence Only ({coverageGapRows.length})</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto flex items-center gap-2">
          {selectedRuleIds.size > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSelectedRuleIds(new Set())}
              disabled={bulkApproveRulesMutation.isPending}
            >
              Clear ({selectedRuleIds.size})
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={() => bulkApproveRulesMutation.mutate()}
            disabled={selectedRuleIds.size === 0 || bulkApproveRulesMutation.isPending}
          >
            {bulkApproveRulesMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Approve Selected ({selectedRuleIds.size})
          </Button>
        </div>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Tenant / Lease</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Category</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Treatment</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Applies When</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Amount / Share / Formula</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">CAM</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Landlord Expense Expected</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Contract Status</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Evidence</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">
                  <div className="flex items-center justify-end gap-2">
                    <span>Actions</span>
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      checked={allVisibleSelectableSelected}
                      disabled={selectableRuleIds.length === 0 || bulkApproveRulesMutation.isPending}
                      onChange={(event) => toggleAllVisibleRules(event.target.checked)}
                      aria-label="Select all visible lease expense rules"
                    />
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-12 text-center">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" />
                  </TableCell>
                </TableRow>
              ) : filteredRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-12 text-center text-sm text-slate-400">
                    <div className="mx-auto flex max-w-2xl flex-col items-center gap-3">
                      {ruleSetLoadError ? (
                        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-left text-red-700">
                          <p className="font-medium">Could not load lease expense rules.</p>
                          <p className="mt-1 text-xs">
                            {ruleSetLoadError?.message || "The server rule-list function failed. Check function deployment and page access."}
                          </p>
                        </div>
                      ) : (
                        <p>
                          {displayMode === "gaps"
                          ? "No coverage gaps in this view."
                          : approvedLeasesMissingRules.length > 0
                            ? `${approvedLeasesMissingRules.length} approved lease${approvedLeasesMissingRules.length === 1 ? "" : "s"} in this scope have no persisted expense rules yet.`
                            : "No lease-derived expense rules in this view. Sync approved leases or review coverage gaps for missing rule evidence."}
                        </p>
                      )}
                      {!ruleSetLoadError && displayMode !== "gaps" && approvedLeasesMissingRules.length > 0 && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => syncApprovedLeaseRulesMutation.mutate()}
                          disabled={syncApprovedLeaseRulesMutation.isPending}
                        >
                          <RefreshCw className={`mr-2 h-4 w-4 ${syncApprovedLeaseRulesMutation.isPending ? "animate-spin" : ""}`} />
                          Sync approved lease expense rules
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filteredRows.map(({ rule, ruleSet, lease, property, category }) => (
                  <RuleTableRow
                    key={rule.id}
                    rule={rule}
                    ruleSet={ruleSet}
                    lease={lease}
                    property={property}
                    category={category}
                    displayMode={displayMode}
                    isUpdating={updateRuleMutation.isPending || bulkApproveRulesMutation.isPending}
                    isSelected={selectedRuleIds.has(rule.id)}
                    canSelect={isUuid(rule?.id) && !isApprovedRule(rule)}
                    camPolicyStatus={rule?._findingOnly ? null : getPolicyStatus(rule, policiesBySourceRuleId.get(rule.id) || [], leasesWithPremises.has(lease?.id))}
                    isHighlighted={rule.id === highlightedRuleId}
                    onSelectChange={(checked) => toggleRuleSelection(rule.id, checked)}
                    onApprove={(r, l) => approveRule(r, l)}
                    onReject={(r, l) => rejectRule(r, l)}
                    onMarkNA={(r, l) => markNARule(r, l)}
                    onEdit={(context) => openRuleEditor(context)}
                    onOpenDetail={(context) => setDetailContext(context)}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <p className="text-xs text-slate-500">
        Looking for actual expense rows (invoices, imports, vendor bills)? Go to{" "}
        <Link to={createPageUrl("Expenses")} className="underline">Actual Expenses</Link>.
      </p>

      <EditRuleModal
        context={editingRuleContext}
        form={editForm}
        setForm={setEditForm}
        isSaving={updateRuleMutation.isPending}
        onClose={closeRuleEditor}
        onSave={saveRuleEdits}
      />

      <RuleDetailDrawer
        context={detailContext}
        onOpenChange={() => setDetailContext(null)}
      />
    </div>
  );
}
