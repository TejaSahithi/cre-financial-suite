/**
 * LeaseExpenseRules - portfolio-wide view of lease expense rules extracted
 * from approved leases. The single-lease editor remains
 * LeaseExpenseClassification; this page is the cross-lease audit and
 * approval surface backed by the existing rule-set tables.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Loader2,
  MinusCircle,
  MoreVertical,
  Pencil,
  Receipt,
  X,
} from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import { leaseRulePipelineService } from "@/services/leaseRulePipelineService";
import { supabase } from "@/services/supabaseClient";
import { createPageUrl } from "@/utils";

const ROW_STATUS_STYLE = {
  mapped: "bg-emerald-100 text-emerald-700",
  manually_added: "bg-blue-100 text-blue-700",
  needs_review: "bg-amber-100 text-amber-800",
  uncertain: "bg-amber-100 text-amber-800",
  unmapped: "bg-slate-100 text-slate-700",
  missing_value: "bg-red-100 text-red-700",
};

const ROW_STATUS_LABEL = {
  mapped: "Approved",
  manually_added: "Manually Added",
  needs_review: "Needs Review",
  uncertain: "Uncertain",
  unmapped: "Unmapped",
  missing_value: "Missing Value",
};

const PAYMENT_TREATMENT_OPTIONS = [
  "included_in_base_rent",
  "separately_billed",
  "tenant_direct_contract",
  "reimbursable",
  "not_applicable",
];

const TRI_STATE_OPTIONS = ["yes", "no", "conditional"];

const RECOVERY_METHOD_OPTIONS = [
  "not_applicable",
  "pass_through",
  "pro_rata_share",
  "fixed_amount",
  "capped_amount",
  "included_in_base_rent",
];

const ALLOCATION_OPTIONS = [
  "none",
  "pro_rata_share",
  "square_footage",
  "usage",
  "fixed",
  "direct",
];

function toNullableNumber(value) {
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBooleanString(value) {
  return value ? "yes" : "no";
}

function fromBooleanString(value) {
  return value === "yes";
}

function buildRuleEditForm(rule) {
  return {
    category_name: rule?.category_name || rule?.expense_category || "",
    expense_subcategory: rule?.expense_subcategory || rule?.subcategory_name || "",
    included_in_base_rent: toBooleanString(Boolean(rule?.included_in_base_rent)),
    responsibility: rule?.operational_responsibility || rule?.responsibility || "",
    payment_treatment: rule?.payment_treatment || "not_applicable",
    recoverable_from_tenant: rule?.recoverable_from_tenant || leaseExpenseRuleService.getRecoverableDecision(rule) || "no",
    cam_eligible: rule?.cam_eligible || "no",
    recovery_method: rule?.recovery_method || "not_applicable",
    allocation_basis: rule?.allocation_basis || "none",
    cap_type: rule?.cap_type || "",
    cap_percent: rule?.cap_percent == null ? "" : String(rule.cap_percent),
    cap_amount: rule?.cap_amount == null ? "" : String(rule.cap_amount),
    admin_fee_applicable: toBooleanString(Boolean(rule?.admin_fee_applicable)),
    admin_fee_percent: rule?.admin_fee_percent == null ? "" : String(rule.admin_fee_percent),
    gross_up_applicable: toBooleanString(Boolean(rule?.gross_up_applicable)),
    gross_up_percent: rule?.gross_up_percent == null ? "" : String(rule.gross_up_percent),
    reconciliation_required: toBooleanString(Boolean(rule?.reconciliation_required)),
    notes: rule?.notes || "",
  };
}

function isApprovedRule(rule) {
  return ["approved", "reviewed"].includes(String(rule?.review_status || "").toLowerCase());
}

function needsReviewRule(rule) {
  return !isApprovedRule(rule);
}

function getRecoverableDecision(rule) {
  return leaseExpenseRuleService.getRecoverableDecision(rule);
}

function getOperationalResponsibility(rule) {
  return leaseExpenseRuleService.getOperationalResponsibility(rule);
}

function getSourcePage(rule) {
  return leaseExpenseRuleService.getSourcePage(rule);
}

function getExactSourceText(rule) {
  return leaseExpenseRuleService.getExactSourceText(rule);
}

function getRuleValidation(rule) {
  return leaseExpenseRuleService.getRuleValidation(rule);
}

function buildRuleWorkflowPatch(rule, validation, overrides = {}) {
  return {
    included_in_base_rent: validation.includedInBaseRent,
    operational_responsibility: getOperationalResponsibility(rule),
    payment_treatment: validation.paymentTreatment,
    recoverable_from_tenant: validation.recoverableFromTenant,
    cam_eligible: validation.camEligible,
    recovery_method: validation.recoveryMethod,
    allocation_basis: validation.allocationBasis,
    source_page: validation.sourcePage,
    exact_source_text: validation.exactSourceText || null,
    ...overrides,
  };
}

function humanizeToken(value) {
  const text = String(value || "").replace(/[_-]+/g, " ").trim();
  if (!text) return "-";
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTriState(value) {
  if (!value) return "-";
  if (value === "yes") return "Yes";
  if (value === "no") return "No";
  if (value === "conditional") return "Conditional";
  return humanizeToken(value);
}

function formatConfidence(value) {
  if (value == null) return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${Math.round(numeric <= 1 ? numeric * 100 : numeric)}%`;
}

function truncate(value, length = 140) {
  const text = String(value || "");
  if (!text) return "-";
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

function isApprovedWorkflowValue(value) {
  return String(value || "").toLowerCase() === "approved";
}

function pickPreferredRuleSet(ruleSets = []) {
  const approvedRuleSet = ruleSets.find((ruleSet) =>
    isApprovedWorkflowValue(ruleSet?.status) ||
    isApprovedWorkflowValue(ruleSet?.approval_status) ||
    isApprovedWorkflowValue(ruleSet?.review_status)
  );
  return approvedRuleSet || ruleSets[0] || null;
}

export default function LeaseExpenseRules() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState(() => new URLSearchParams(location.search).get("lease") || "");
  const [editingRuleContext, setEditingRuleContext] = useState(null);
  const [editForm, setEditForm] = useState(null);

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

  const scopedLeases = useMemo(
    () =>
      leases.filter((lease) =>
        matchesHierarchyScope(lease, scope, { propertyKey: "property_id", unitKey: "unit_id" }),
      ),
    [leases, scope]
  );

  const selectorFilteredLeases = scopedLeases.filter((lease) => {
    const unit = lease.unit_id ? scope.unitById.get(lease.unit_id) ?? null : null;
    const buildingId = unit?.building_id || null;
    if (scopeProperty !== "all" && lease.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all" && buildingId !== scopeBuilding) return false;
    if (scopeUnit !== "all" && lease.unit_id !== scopeUnit) return false;
    return true;
  });

  const leaseIds = selectorFilteredLeases.map((lease) => lease.id);



  // Fallback query: direct supabase read of ALL non-archived rule sets the
  // current user can see (RLS handles scoping). Always runs so it can rescue
  // the page when the scoped path drops rules due to dedup/category-resolver
  // bugs, stale React-Query cache, or any other JS-side issue. Filtered to
  // the in-scope lease IDs after fetch, so the scope selector still works.
  const { data: directRuleSets = [], isLoading: isLoadingDirect } = useQuery({
    queryKey: ["lease-expense-rule-sets-direct"],
    queryFn: async () => {
      const { data: sets, error: setsErr } = await supabase
        .from("lease_expense_rule_sets")
        .select("id, lease_id, org_id, property_id, version, status, created_at, updated_at")
        .not("status", "eq", "archived")
        .order("version", { ascending: false });
      if (setsErr) {
        console.error("[LeaseExpenseRules] direct rule_sets read failed:", setsErr);
        return [];
      }
      const ruleSetsByLease = new Map();
      for (const s of sets || []) {
        const existing = ruleSetsByLease.get(s.lease_id) || [];
        existing.push(s);
        ruleSetsByLease.set(s.lease_id, existing);
      }
      const latest = [...ruleSetsByLease.values()].map((ruleSetsForLease) => pickPreferredRuleSet(ruleSetsForLease)).filter(Boolean);
      const setIds = latest.map((s) => s.id);
      console.log("[LeaseExpenseRules-DIRECT] rule_sets read:", latest.length);
      if (setIds.length === 0) return [];
      const { data: rules, error: rulesErr } = await supabase
        .from("lease_expense_rules")
        .select("*")
        .in("rule_set_id", setIds);
      if (rulesErr) {
        console.error("[LeaseExpenseRules] direct rules read failed:", rulesErr);
        return latest.map((s) => ({ leaseId: s.lease_id, ruleSet: s, rules: [] }));
      }
      console.log("[LeaseExpenseRules-DIRECT] rules read:", rules?.length || 0);
      const byRuleSet = new Map();
      for (const r of rules || []) {
        const list = byRuleSet.get(r.rule_set_id) || [];
        list.push(r);
        byRuleSet.set(r.rule_set_id, list);
      }
      return latest.map((s) => ({
        leaseId: s.lease_id,
        ruleSet: s,
        rules: byRuleSet.get(s.id) || [],
      }));
    },
  });

  const ruleSetsByLease = useMemo(() => {
    const merged = [];
    const scopeIdSet = new Set(leaseIds);
    
    // Direct DB rows are the source of truth for actionable rules
    for (const entry of directRuleSets) {
      if (scopeIdSet.size > 0 && !scopeIdSet.has(entry.leaseId)) continue;
      merged.push(entry);
    }

    const finalMerged = merged.filter((m) => m.rules && m.rules.length > 0);
    console.log("[LeaseExpenseRules] all leases in scope:", leases.map(l => ({ id: l.id, name: l.tenant_name || l.name, abstract_status: l.abstract_status })));
    console.log("[LeaseExpenseRules] merged ruleSetsByLease:", {
      direct_entries: directRuleSets?.length || 0,
      after_scope_filter: finalMerged.length,
    });
    return finalMerged;
  }, [directRuleSets, leaseIds]);

  const isLoading = isLoadingDirect;



  const [regenerateState, setRegenerateState] = useState({ running: false });
  const hasRunAutoRegen = useRef(false);

  const isUuid = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  const leaseById = useMemo(() => {
    const map = new Map();
    for (const lease of leases) map.set(lease.id, lease);
    return map;
  }, [leases]);

  const staleLeases = useMemo(() => {
    const rulesByLease = new Map();
    for (const entry of ruleSetsByLease) {
      rulesByLease.set(entry.leaseId, entry.rules || []);
    }
    return selectorFilteredLeases.filter((lease) => {
      const isApproved = ["approved", "executed", "budget_ready"].includes(
        String(lease?.abstract_status || lease?.status).toLowerCase()
      );
      if (!isApproved) return false;
      
      const rules = rulesByLease.get(lease.id) || [];
      // If there are no rules for an approved lease, it needs extraction
      if (rules.length === 0) return true;
      
      return false;
    });
  }, [ruleSetsByLease, selectorFilteredLeases]);

  const runForceRegenerateAll = async () => {
    if (staleLeases.length === 0) return;
    if (regenerateState.running) return;
    setRegenerateState({ running: true });

    try {
      for (const lease of staleLeases) {
        toast.loading(`Extracting rules for ${lease.tenant_name || lease.name}...`, { id: "regen-toast" });
        await leaseRulePipelineService.generateLeaseExpenseRulesForLease({
          leaseId: lease.id,
          force: true,
          source: "manual_extract"
        });
      }
      queryClient.invalidateQueries({ queryKey: ["lease-expense-rule-sets"] });
      queryClient.invalidateQueries({ queryKey: ["lease-expense-rule-sets-direct"] });
      toast.success(`Successfully extracted rules.`, { id: "regen-toast" });
    } catch (err) {
      console.error("[LeaseExpenseRules] regenerate all FAILED", err);
      toast.error(`Extraction failed: ${err.message}`, { id: "regen-toast" });
    } finally {
      setRegenerateState({ running: false });
    }
  };

  useEffect(() => {
    if (staleLeases.length > 0 && !regenerateState.running && !hasRunAutoRegen.current) {
      hasRunAutoRegen.current = true;
      runForceRegenerateAll();
    }
  }, [staleLeases]);


  const targetLease = useMemo(() => {
    if (search && search.length >= 8) {
      return leases.find(l => l.id.toLowerCase() === search.toLowerCase() || l.id.toLowerCase().startsWith(search.toLowerCase()));
    }
    if (staleLeases.length === 1) return staleLeases[0];
    return leases.find(l => l.id === "310ab875-f516-4a2b-94d9-686cf4b87d90") || null;
  }, [search, leases, staleLeases]);


  const categoryById = useMemo(() => {
    const map = new Map();
    for (const category of categories) map.set(category.id, category);
    return map;
  }, [categories]);

  const flattenedRows = useMemo(() => {
    const rows = [];
    for (const entry of ruleSetsByLease) {
      const lease = leaseById.get(entry.leaseId);
      const property = lease?.property_id ? scope.propertyById.get(lease.property_id) ?? null : null;
      for (const rule of entry.rules || []) {
        rows.push({
          rule,
          ruleSet: entry.ruleSet,
          lease,
          property,
          category: rule.expense_category_id ? categoryById.get(rule.expense_category_id) : null,
        });
      }
    }
    return rows;
  }, [ruleSetsByLease, leaseById, categoryById, scope]);

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
      if (statusFilter === "recoverable") return ["yes", "conditional"].includes(leaseExpenseRuleService.getRecoverableDecision(rule)) && !rule.is_excluded;
      if (statusFilter === "excluded") return rule.is_excluded;
      if (statusFilter === "needs_review") return needsReviewRule(rule);
      if (statusFilter === "approved") return isApprovedRule(rule);
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

  const filteredRows = flattenedRows.filter(({ rule, lease }) => {
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
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      if (!haystack.some((value) => value.includes(search.toLowerCase()))) return false;
    }

    // Recoverable / Non-Recoverable / Conditional now have separate filter
    // buckets (per product requirement). A rule lands in exactly ONE of
    // them based on its recoverable_from_tenant decision; "Excluded" rules
    // are folded into Non-Recoverable.
    const decision = getRecoverableDecision(rule);
    if (statusFilter === "all") return true;
    if (statusFilter === "recoverable") return decision === "yes" && !rule.is_excluded;
    if (statusFilter === "non_recoverable") return decision === "no" || rule.is_excluded;
    if (statusFilter === "conditional") return decision === "conditional" && !rule.is_excluded;
    if (statusFilter === "needs_review") return needsReviewRule(rule);
    if (statusFilter === "approved") return isApprovedRule(rule);
    return true;
  });

  const counts = useMemo(() => {
    const summary = {
      all: flattenedRows.length,
      recoverable: 0,
      non_recoverable: 0,
      conditional: 0,
      needs_review: 0,
      approved: 0,
    };

    for (const { rule } of flattenedRows) {
      const decision = getRecoverableDecision(rule);
      if (decision === "yes" && !rule.is_excluded) summary.recoverable += 1;
      if (decision === "no" || rule.is_excluded) summary.non_recoverable += 1;
      if (decision === "conditional" && !rule.is_excluded) summary.conditional += 1;
      if (needsReviewRule(rule)) summary.needs_review += 1;
      if (isApprovedRule(rule)) summary.approved += 1;
    }

    return summary;
  }, [flattenedRows]);

  const openRuleEditor = (context) => {
    setEditingRuleContext(context);
    setEditForm(buildRuleEditForm(context.rule));
  };

  const closeRuleEditor = () => {
    setEditingRuleContext(null);
    setEditForm(null);
  };

  const updateRuleMutation = useMutation({
    mutationFn: async ({ ruleId, patch }) => {
      if (!isUuid(ruleId) || String(ruleId).startsWith("workflow-rule-")) {
        throw new Error("Cannot approve unsaved rule. Regenerate rules first.");
      }
      const { data, error } = await supabase
        .from("lease_expense_rules")
        .update(patch)
        .eq("id", ruleId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lease-expense-rule-sets"] });
      queryClient.invalidateQueries({ queryKey: ["lease-expense-rule-sets-direct"] });
      queryClient.invalidateQueries({ queryKey: ["expense-classification-rule-sets"] });
    },
    onError: (error) => toast.error(error?.message || "Could not update rule"),
  });

  const ensurePersistedRule = async (rule, lease) => {
    if (!rule._is_fallback && isUuid(rule.id) && !String(rule.id).startsWith("workflow-rule-")) {
      return rule;
    }

    toast.loading("Persisting rules before action...", { id: "persist-toast" });
    try {
      const rulesForLease = ruleSetsByLease.find(rs => rs.leaseId === lease.id)?.rules || [];
      if (!rulesForLease.length) throw new Error("No rules found to persist");

      const authResult = await supabase.auth.getUser();
      const userId = authResult?.data?.user?.id || null;

      const result = await leaseExpenseRuleService.saveRuleSet({
        lease,
        rules: rulesForLease,
        status: "draft",
        approver: userId,
        createdFrom: "manual_approval",
      });

      toast.success("Rules persisted.", { id: "persist-toast" });

      const computeKey = (r) => {
        if (r.rule_key) return r.rule_key;
        const norm = (v) => String(v ?? "").toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
        const category = norm(r.expense_category || r.category_name || r.normalized_key);
        const subcategory = norm(r.expense_subcategory || r.subcategory_name);
        const type = norm(r.rule_type);
        const sourceKey = norm(r.source_field_key);
        return `${lease.id}_${type}_${category}_${subcategory}_${sourceKey}`;
      };

      const targetKey = computeKey(rule);
      const persistedRule = result?.rules?.find(r => computeKey(r) === targetKey);
      
      if (!persistedRule || !isUuid(persistedRule.id)) {
        throw new Error("Could not find the persisted version of this rule.");
      }

      queryClient.invalidateQueries({ queryKey: ["lease-expense-rule-sets"] });
      queryClient.invalidateQueries({ queryKey: ["lease-expense-rule-sets-direct"] });
      
      return persistedRule;
    } catch (err) {
      toast.error(`Failed to persist: ${err.message}`, { id: "persist-toast" });
      throw err;
    }
  };

  const approveRule = async (rawRule, lease) => {
    let rule;
    try {
      rule = await ensurePersistedRule(rawRule, lease);
    } catch {
      return;
    }


    const authResult = await supabase.auth.getUser();
    const userId = authResult?.data?.user?.id || null;
    const now = new Date().toISOString();
    const approvalPreview = {
      ...rule,
      review_status: "approved",
      approval_status: "approved",
      approved_by: userId,
      approved_at: now,
      updated_at: now,
    };
    const validation = getRuleValidation(approvalPreview);
    if (!validation.canApprove) {
      toast.error(validation.approvalBlockers[0] || "This rule needs real lease evidence before approval.");
      return;
    }
    console.log("[Approve Rule clicked]", rule.id);

    const patch = {
      review_status: "approved",
      approval_status: "approved",
      approved_by: userId,
      approved_at: now,
      updated_at: now,
    };
    console.log("[Approve Rule update payload]", patch);
    
    let approvedRule;
    try {
      approvedRule = await updateRuleMutation.mutateAsync({
        ruleId: rule.id,
        patch,
      });
      console.log("[Approve Rule update result]", approvedRule);
    } catch (err) {
      return;
    }

    toast.success("Rule approved");
  };

  const rejectRule = async (rawRule, lease) => {
    let rule;
    try {
      rule = await ensurePersistedRule(rawRule, lease);
    } catch {
      return;
    }
    const now = new Date().toISOString();
    const validation = getRuleValidation(rule);
    return updateRuleMutation.mutateAsync({
      ruleId: rule.id,
      patch: buildRuleWorkflowPatch(rule, validation, {
        row_status: "needs_review",
        review_status: "needs_review",
        approval_status: "draft",
        approved_by: null,
        approved_at: null,
        updated_at: now,
        recoverable_from_tenant: "no",
        cam_eligible: "no",
        recovery_method: "not_applicable",
        allocation_basis: null,
        is_recoverable: false,
        is_excluded: true,
      }),
    }).then(() => toast.success("Rule rejected"));
  };

  const markNARule = async (rawRule, lease) => {
    let rule;
    try {
      rule = await ensurePersistedRule(rawRule, lease);
    } catch {
      return;
    }
    const authResult = await supabase.auth.getUser();
    const userId = authResult?.data?.user?.id || null;
    const now = new Date().toISOString();
    const validation = getRuleValidation(rule);
    return updateRuleMutation.mutateAsync({
      ruleId: rule.id,
      patch: buildRuleWorkflowPatch(rule, validation, {
        row_status: "unmapped",
        review_status: "approved",
        approval_status: "approved",
        approved_by: userId,
        approved_at: now,
        updated_at: now,
        payment_treatment: validation.includedInBaseRent ? "included_in_base_rent" : "not_applicable",
        recoverable_from_tenant: "no",
        cam_eligible: "no",
        recovery_method: validation.includedInBaseRent ? "included_in_base_rent" : "not_applicable",
        allocation_basis: null,
        is_excluded: true,
        is_recoverable: false,
      }),
    }).then(() => toast.success("Rule marked N/A"));
  };

  const saveRuleEdits = async () => {
    if (!editingRuleContext?.rule || !editForm) return;
    await updateRuleMutation.mutateAsync({
      ruleId: editingRuleContext.rule.id,
      patch: {
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
      },
    });
    toast.success("Rule details updated");
    closeRuleEditor();
  };

  const subtitle = getScopeSubtitle(scope, {
    default: `${filteredRows.length} lease expense rule${filteredRows.length === 1 ? "" : "s"}`,
  });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Receipt}
        title="Lease Expense Rules"
        subtitle={subtitle}
        iconColor="from-amber-500 to-orange-600"
      />

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
              . This page is for contract rule review only.
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
        <StatCard label="All Rules" value={counts.all} />
        <StatCard label="Recoverable" value={counts.recoverable} accent="border-l-emerald-500 bg-emerald-50" />
        <StatCard label="Non-Recoverable" value={counts.non_recoverable} accent="border-l-slate-400 bg-slate-50" />
        <StatCard label="Conditional" value={counts.conditional} accent="border-l-purple-500 bg-purple-50" />
        <StatCard label="Needs Review" value={counts.needs_review} accent="border-l-amber-500 bg-amber-50" />
        <StatCard label="Approved" value={counts.approved} accent="border-l-blue-500 bg-blue-50" />
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
            <TabsTrigger value="recoverable" className="text-xs">Recoverable ({counts.recoverable})</TabsTrigger>
            <TabsTrigger value="non_recoverable" className="text-xs">Non-Recoverable ({counts.non_recoverable})</TabsTrigger>
            <TabsTrigger value="conditional" className="text-xs">Conditional ({counts.conditional})</TabsTrigger>
            <TabsTrigger value="needs_review" className="text-xs">Needs Review ({counts.needs_review})</TabsTrigger>
            <TabsTrigger value="approved" className="text-xs">Approved ({counts.approved})</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Tenant</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Property</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Rule Type</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Category</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Subcategory</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Included In Rent</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Responsibility</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Payment Treatment</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Recoverable</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">CAM Eligible</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Recovery Method</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Allocation</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Cap</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Admin Fee</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Gross-Up</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Tenant Share</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Est. Amount</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Billing Frequency</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Reconciliation Required</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Exact Source Text</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Confidence</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Extraction</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Review Status</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Approval Status</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Source Field Key</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={25} className="py-12 text-center">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" />
                  </TableCell>
                </TableRow>
              ) : filteredRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={25} className="py-12 text-center text-sm text-slate-400">
                    No lease expense rules in this view. Approve a lease abstract and run rule extraction to populate this list.
                  </TableCell>
                </TableRow>
              ) : (
                filteredRows.map(({ rule, ruleSet, lease, property, category }) => {
                  const validation = getRuleValidation(rule);
                  const recoverableDecision = validation.recoverableFromTenant;
                  const camEligibleDecision = validation.camEligible;
                  const paymentTreatment = validation.paymentTreatment;
                  const responsibility = getOperationalResponsibility(rule);
                  const recoveryMethod = validation.recoveryMethod;
                  const allocationBasis = validation.allocationBasis;
                  const capDisplay = rule.is_subject_to_cap || rule.cap_percent != null || rule.cap_type || rule.cap_amount != null
                    ? [
                        rule.cap_type || "",
                        rule.cap_percent != null ? `${rule.cap_percent}%` : null,
                        rule.cap_amount != null ? `$${Number(rule.cap_amount).toLocaleString()}` : null,
                        rule.cap_value != null && rule.cap_amount == null ? String(rule.cap_value) : null,
                      ].filter(Boolean).join(" ") || "-"
                    : "-";
                  const sourcePage = getSourcePage(rule);
                  const sourceText = getExactSourceText(rule) || "-";
                  return (
                    <TableRow key={rule.id} className="align-top hover:bg-slate-50">
                      <TableCell className="text-sm font-medium text-slate-900">
                        {lease ? (
                          <Link
                            to={createPageUrl("LeaseReview", { id: lease.id })}
                            className="text-blue-600 hover:text-blue-700"
                          >
                            {lease.tenant_name || lease.id.slice(0, 8)}
                          </Link>
                        ) : (
                          "-"
                        )}
                        <p className="text-[10px] text-slate-400">
                          Rule set v{ruleSet?.version} - {ruleSet?.status}
                        </p>
                        {rule._is_fallback && (
                          <Badge className="bg-amber-100 text-amber-800 text-[9px] px-1 py-0 h-4 mt-1">
                            Not persisted
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-slate-600">{property?.name || "-"}</TableCell>
                      <TableCell className="text-sm">
                        <Badge className="bg-slate-100 text-slate-700 text-[10px]">
                          {humanizeToken(rule.rule_type) || "General"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        <div className="font-medium text-slate-900">
                          {rule.category_name || rule.expense_category || category?.category_name || "-"}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">
                        {rule.expense_subcategory || rule.subcategory_name || category?.subcategory_name || "-"}
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] ${validation.includedInBaseRent ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>
                          {validation.includedInBaseRent ? "Included" : "Separate"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">{humanizeToken(responsibility)}</TableCell>
                      <TableCell className="text-sm text-slate-700">{humanizeToken(paymentTreatment)}</TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] ${["yes", "conditional"].includes(recoverableDecision) && !rule.is_excluded ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                          {formatTriState(recoverableDecision)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] ${["yes", "conditional"].includes(camEligibleDecision) ? "bg-sky-100 text-sky-700" : "bg-slate-100 text-slate-600"}`}>
                          {formatTriState(camEligibleDecision)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">{humanizeToken(recoveryMethod)}</TableCell>
                      <TableCell className="text-sm text-slate-700">{allocationBasis ? humanizeToken(allocationBasis) : "-"}</TableCell>
                      <TableCell className="text-sm text-slate-700">{capDisplay}</TableCell>
                      <TableCell className="text-sm text-slate-700">
                        {rule.admin_fee_applicable ? (rule.admin_fee_percent ? `${rule.admin_fee_percent}%` : "Yes") : "-"}
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">
                        {rule.gross_up_applicable ? (rule.gross_up_percent != null ? `${rule.gross_up_percent}%` : "Yes") : rule.gross_up_percent != null ? `${rule.gross_up_percent}%` : "-"}
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">
                        {rule.tenant_share_percent != null ? `${rule.tenant_share_percent}%` : "-"}
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">
                        {[
                          rule.estimated_annual_amount != null ? `$${Number(rule.estimated_annual_amount).toLocaleString()}/yr` : null,
                          rule.estimated_monthly_amount != null ? `$${Number(rule.estimated_monthly_amount).toLocaleString()}/mo` : null
                        ].filter(Boolean).join(" · ") || "-"}
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">{rule.billing_frequency || rule.frequency || "-"}</TableCell>
                      <TableCell className="text-sm text-slate-700">{rule.reconciliation_required ? "Yes" : "No"}</TableCell>
                      <TableCell className="max-w-[260px] text-xs text-slate-600">
                        {sourceText && sourceText !== "-" ? <span className="italic">"{truncate(sourceText)}"</span> : "-"}
                      </TableCell>
                      <TableCell className="text-xs text-slate-700">{formatConfidence(rule.confidence_score)}</TableCell>
                      <TableCell className="text-xs text-slate-700">{rule.extraction_status || "-"}</TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] ${
                          String(rule.review_status).toLowerCase() === "reviewed" || String(rule.review_status).toLowerCase() === "approved"
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-amber-100 text-amber-800"
                        }`}>
                          {humanizeToken(rule.review_status || "Pending")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] ${
                          String(rule.approval_status || rule.row_status).toLowerCase() === "approved"
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-amber-100 text-amber-800"
                        }`}>
                          {humanizeToken(rule.approval_status || rule.row_status || "Needs Review")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-slate-500 font-mono">
                        {rule.source_field_key || "-"}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0"
                              disabled={updateRuleMutation.isPending}
                              aria-label="Rule actions"
                            >
                              <MoreVertical className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-slate-500">
                              Review
                            </DropdownMenuLabel>
                            <DropdownMenuItem
                              onSelect={(event) => {
                                event.preventDefault();
                                approveRule(rule, lease);
                              }}
                              className="text-emerald-700 focus:text-emerald-800"
                            >
                              <Check className="mr-2 h-3.5 w-3.5" />
                              Approve rule
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={(event) => {
                                event.preventDefault();
                                rejectRule(rule, lease);
                              }}
                              className="text-red-700 focus:text-red-800"
                            >
                              <X className="mr-2 h-3.5 w-3.5" />
                              Reject rule
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={(event) => {
                                event.preventDefault();
                                markNARule(rule, lease);
                              }}
                              className="text-slate-700"
                            >
                              <MinusCircle className="mr-2 h-3.5 w-3.5" />
                              Mark N/A
                            </DropdownMenuItem>
                            {lease ? (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-slate-500">
                                  Edit
                                </DropdownMenuLabel>
                                <DropdownMenuItem
                                  onSelect={(event) => {
                                    event.preventDefault();
                                    openRuleEditor({ rule, lease, property, category, ruleSet });
                                  }}
                                >
                                  <Pencil className="mr-2 h-3.5 w-3.5" />
                                  Edit rule details
                                </DropdownMenuItem>
                              </>
                            ) : null}
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
      </Card>

      <p className="text-xs text-slate-500">
        Looking for actual expense rows (invoices, imports, vendor bills)? Go to{" "}
        <Link to={createPageUrl("Expenses")} className="underline">Actual Expenses</Link>.
      </p>

      <Dialog open={!!editingRuleContext} onOpenChange={(open) => { if (!open) closeRuleEditor(); }}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Rule Details</DialogTitle>
            <DialogDescription>
              Update the selected lease expense rule in place. This edits the specific row you clicked from the action menu.
            </DialogDescription>
          </DialogHeader>

          {editingRuleContext?.rule && editForm ? (
            <div className="space-y-5">
              <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm md:grid-cols-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tenant / Lease</p>
                  <p className="mt-1 font-medium text-slate-900">{editingRuleContext.lease?.tenant_name || editingRuleContext.lease?.id || "-"}</p>
                  <p className="text-xs text-slate-500">Rule set v{editingRuleContext.ruleSet?.version || "-"}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Property</p>
                  <p className="mt-1 font-medium text-slate-900">{editingRuleContext.property?.name || "-"}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Review Status</p>
                  <p className="mt-1 font-medium text-slate-900">{humanizeToken(editingRuleContext.rule.review_status || editingRuleContext.rule.row_status || "-")}</p>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Category</Label>
                  <Input
                    value={editForm.category_name}
                    onChange={(event) => setEditForm((current) => ({ ...current, category_name: event.target.value }))}
                    placeholder="Normalized category"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Subcategory</Label>
                  <Input
                    value={editForm.expense_subcategory}
                    onChange={(event) => setEditForm((current) => ({ ...current, expense_subcategory: event.target.value }))}
                    placeholder="Normalized subcategory"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Included In Rent</Label>
                  <Select value={editForm.included_in_base_rent} onValueChange={(value) => setEditForm((current) => ({ ...current, included_in_base_rent: value }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="yes">Yes</SelectItem>
                      <SelectItem value="no">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Responsibility</Label>
                  <Input
                    value={editForm.responsibility}
                    onChange={(event) => setEditForm((current) => ({ ...current, responsibility: event.target.value }))}
                    placeholder="Operational responsibility"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Payment Treatment</Label>
                  <Select value={editForm.payment_treatment} onValueChange={(value) => setEditForm((current) => ({ ...current, payment_treatment: value }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PAYMENT_TREATMENT_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>{humanizeToken(option)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Recoverable From Tenant</Label>
                  <Select value={editForm.recoverable_from_tenant} onValueChange={(value) => setEditForm((current) => ({ ...current, recoverable_from_tenant: value }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TRI_STATE_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>{humanizeToken(option)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>CAM Eligible</Label>
                  <Select value={editForm.cam_eligible} onValueChange={(value) => setEditForm((current) => ({ ...current, cam_eligible: value }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TRI_STATE_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>{humanizeToken(option)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Recovery Method</Label>
                  <Select value={editForm.recovery_method} onValueChange={(value) => setEditForm((current) => ({ ...current, recovery_method: value }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {RECOVERY_METHOD_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>{humanizeToken(option)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Allocation Basis</Label>
                  <Select value={editForm.allocation_basis} onValueChange={(value) => setEditForm((current) => ({ ...current, allocation_basis: value }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ALLOCATION_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>{humanizeToken(option)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Cap Type</Label>
                  <Input
                    value={editForm.cap_type}
                    onChange={(event) => setEditForm((current) => ({ ...current, cap_type: event.target.value }))}
                    placeholder="Percent, amount, fixed..."
                  />
                </div>
                <div className="space-y-2">
                  <Label>Cap Percent</Label>
                  <Input
                    type="number"
                    value={editForm.cap_percent}
                    onChange={(event) => setEditForm((current) => ({ ...current, cap_percent: event.target.value }))}
                    placeholder="0"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Cap Amount</Label>
                  <Input
                    type="number"
                    value={editForm.cap_amount}
                    onChange={(event) => setEditForm((current) => ({ ...current, cap_amount: event.target.value }))}
                    placeholder="0"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Admin Fee Applies</Label>
                  <Select value={editForm.admin_fee_applicable} onValueChange={(value) => setEditForm((current) => ({ ...current, admin_fee_applicable: value }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="yes">Yes</SelectItem>
                      <SelectItem value="no">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Admin Fee Percent</Label>
                  <Input
                    type="number"
                    value={editForm.admin_fee_percent}
                    onChange={(event) => setEditForm((current) => ({ ...current, admin_fee_percent: event.target.value }))}
                    placeholder="0"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Gross-Up Applies</Label>
                  <Select value={editForm.gross_up_applicable} onValueChange={(value) => setEditForm((current) => ({ ...current, gross_up_applicable: value }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="yes">Yes</SelectItem>
                      <SelectItem value="no">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Gross-Up Percent</Label>
                  <Input
                    type="number"
                    value={editForm.gross_up_percent}
                    onChange={(event) => setEditForm((current) => ({ ...current, gross_up_percent: event.target.value }))}
                    placeholder="0"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Reconciliation Required</Label>
                  <Select value={editForm.reconciliation_required} onValueChange={(value) => setEditForm((current) => ({ ...current, reconciliation_required: value }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="yes">Yes</SelectItem>
                      <SelectItem value="no">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Source Evidence</Label>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  <p><span className="font-medium text-slate-900">Source page:</span> {(() => {
                    const sp = getSourcePage(editingRuleContext.rule);
                    return sp != null && sp !== "" && Number(sp) > 0 ? `p. ${Number(sp)}` : "—";
                  })()}</p>
                  <p className="mt-2"><span className="font-medium text-slate-900">Exact source text:</span> {getExactSourceText(editingRuleContext.rule) || "-"}</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea
                  value={editForm.notes}
                  onChange={(event) => setEditForm((current) => ({ ...current, notes: event.target.value }))}
                  placeholder="Add rule notes or override context..."
                  rows={4}
                />
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={closeRuleEditor} disabled={updateRuleMutation.isPending}>
              Cancel
            </Button>
            <Button onClick={saveRuleEdits} disabled={updateRuleMutation.isPending || !editForm} className="bg-blue-600 hover:bg-blue-700">
              {updateRuleMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <Card className={accent ? `border-l-4 ${accent}` : ""}>
      <CardContent className="p-4">
        <p className="text-2xl font-bold text-slate-900">{value}</p>
        <p className="text-xs font-medium text-slate-500">{label}</p>
      </CardContent>
    </Card>
  );
}
