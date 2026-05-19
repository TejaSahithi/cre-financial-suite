/**
 * LeaseExpenseRules - portfolio-wide view of lease expense rules extracted
 * from approved leases. The single-lease editor remains
 * LeaseExpenseClassification; this page is the cross-lease audit and
 * approval surface backed by the existing rule-set tables.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Calculator,
  Check,
  Loader2,
  MinusCircle,
  MoreVertical,
  Pencil,
  Receipt,
  RefreshCw,
  Send,
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
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

function isApprovedRule(rule) {
  return ["approved", "reviewed"].includes(String(rule?.review_status || "").toLowerCase()) && rule?.approval_status === "approved";
}

function needsReviewRule(rule) {
  return (
    rule?.review_status === "needs_review" ||
    rule?.row_status === "needs_review" ||
    rule?.row_status === "uncertain"
  );
}

function getRecoverableDecision(rule) {
  return leaseExpenseRuleService.getRecoverableDecision(rule);
}

function getCamEligibleDecision(rule) {
  return leaseExpenseRuleService.getCamEligibleDecision(rule);
}

function getPaymentTreatment(rule) {
  return leaseExpenseRuleService.getPaymentTreatment(rule);
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

export default function LeaseExpenseRules() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  const { data: leases = [] } = useOrgQuery("Lease");
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

  // Primary query: scoped via the service. Goes through finalizeLeaseExpenseRules
  // for full normalization. This is the "preferred" path.
  const { data: ruleSetsByLeaseScoped = [], isLoading: isLoadingScoped } = useQuery({
    queryKey: ["lease-expense-rule-sets", leaseIds.join(",")],
    queryFn: () => leaseExpenseRuleService.loadRuleSets(leaseIds),
    enabled: leaseIds.length > 0,
  });

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
      const latestByLease = new Map();
      for (const s of sets || []) {
        if (!latestByLease.has(s.lease_id)) latestByLease.set(s.lease_id, s);
      }
      const latest = [...latestByLease.values()];
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

  // Merge: prefer scoped result (richer normalization) but if it yields 0
  // entries for a lease that the direct path DOES have rules for, use the
  // direct entry. This makes the page survive any breakage in the scoped
  // pipeline while keeping the normalized fields when they work.
  const ruleSetsByLease = useMemo(() => {
    const scopedByLease = new Map(
      (ruleSetsByLeaseScoped || []).map((e) => [e.leaseId, e]),
    );
    const merged = [];
    const scopeIdSet = new Set(leaseIds);
    for (const entry of directRuleSets) {
      // Skip leases outside the scope selector
      if (scopeIdSet.size > 0 && !scopeIdSet.has(entry.leaseId)) continue;
      const scoped = scopedByLease.get(entry.leaseId);
      if (scoped && (scoped.rules?.length || 0) > 0) {
        merged.push(scoped);
      } else {
        merged.push(entry);
      }
    }
    // Also include scoped entries for leases not in directRuleSets (shouldn't
    // happen, but defensive).
    for (const [leaseId, entry] of scopedByLease) {
      if (!merged.find((m) => m.leaseId === leaseId)) merged.push(entry);
    }
    console.log("[LeaseExpenseRules] merged ruleSetsByLease:", {
      scoped_entries: ruleSetsByLeaseScoped?.length || 0,
      direct_entries: directRuleSets?.length || 0,
      after_scope_filter: merged.length,
    });
    return merged;
  }, [ruleSetsByLeaseScoped, directRuleSets, leaseIds]);

  const isLoading = isLoadingScoped || isLoadingDirect;

  // ── Backfill: extract rules for already-approved leases that have none.
  // Used when leases were approved before the persistence flow was wired,
  // or when re-approval is impractical. Iterates serially with progress so
  // we don't hammer the LLM with parallel requests.
  const [backfillState, setBackfillState] = useState({ running: false, done: 0, total: 0 });
  const backfillCandidates = useMemo(() => {
    const ruleCountByLease = new Map();
    for (const entry of ruleSetsByLease) {
      ruleCountByLease.set(entry.leaseId, entry.rules?.length || 0);
    }
    return selectorFilteredLeases.filter((lease) => {
      const isApproved =
        String(lease?.abstract_status || "").toLowerCase() === "approved" ||
        String(lease?.status || "").toLowerCase() === "approved";
      if (!isApproved) return false;
      return (ruleCountByLease.get(lease.id) || 0) === 0;
    });
  }, [ruleSetsByLease, selectorFilteredLeases]);

  const runBackfill = async () => {
    if (backfillState.running) return;
    if (backfillCandidates.length === 0) {
      toast.info("No approved leases in scope are missing expense rules.");
      return;
    }
    setBackfillState({ running: true, done: 0, total: backfillCandidates.length });

    // Pre-flight diagnostic: dump the pipeline state for EVERY candidate so
    // we know exactly where rules come from (workflow / extract / text) and
    // why any lease produces zero. This is the table the spec asked for.
    console.group(`[LeaseExpenseRules] backfill diagnostic for ${backfillCandidates.length} approved lease(s)`);
    const preDiagnostics = [];
    for (const lease of backfillCandidates) {
      const d = await leaseExpenseRuleService.diagnoseExpenseRulePipeline(lease);
      preDiagnostics.push(d);
    }
    console.table(preDiagnostics.map((d) => ({
      lease_id: d.lease_id?.slice(0, 8),
      tenant: d.tenant_name || "—",
      approved_abstract_id: d.approved_lease_abstract_id?.slice(0, 8) || "—",
      property_id: d.property_id?.slice(0, 8) || "—",
      building_id: d.building_id?.slice(0, 8) || "—",
      unit_id: d.unit_id?.slice(0, 8) || "—",
      abstract_status: d.abstract_status,
      has_workflow_output: d.has_workflow_output,
      expense_rules_in_payload: d.expense_rules_count,
      clauses: d.clause_records_count,
      source_file_id: d.source_file_id?.slice(0, 8) || "—",
      source_text_chars: d.source_text_length,
      source_text_field: d.source_text_field || "—",
      existing_rule_sets: d.existing_rule_sets_count,
      existing_rules: d.existing_rules_count,
    })));
    console.log("Full diagnostic objects:", preDiagnostics);
    console.groupEnd();

    let persistedTotal = 0;
    const perLeaseResults = [];
    for (let i = 0; i < backfillCandidates.length; i += 1) {
      const lease = backfillCandidates[i];
      const leaseStart = performance.now();
      try {
        const result = await leaseExpenseRuleService.ensureLeaseExpenseRules({
          lease,
          categories,
          status: "draft",
          createdFrom: "backfill",
          approver: lease?.signed_by || null,
        });
        const count = result?.rules?.length || 0;
        persistedTotal += count;
        perLeaseResults.push({
          lease_id: lease.id.slice(0, 8),
          tenant: lease.tenant_name || "—",
          rules_persisted: count,
          rule_set_id: result?.ruleSet?.id?.slice(0, 8) || "—",
          rule_set_status: result?.ruleSet?.status || "—",
          ms: Math.round(performance.now() - leaseStart),
        });
      } catch (err) {
        console.error(`[LeaseExpenseRules] backfill FAILED for lease ${lease.id} (${lease.tenant_name}):`, err);
        perLeaseResults.push({
          lease_id: lease.id.slice(0, 8),
          tenant: lease.tenant_name || "—",
          rules_persisted: 0,
          error: err?.message || String(err),
          ms: Math.round(performance.now() - leaseStart),
        });
      }
      setBackfillState((prev) => ({ ...prev, done: i + 1 }));
    }
    setBackfillState({ running: false, done: 0, total: 0 });

    // Post-flight summary the spec asked for.
    console.group(`[LeaseExpenseRules] backfill summary`);
    console.table(perLeaseResults);
    console.log("Totals:", {
      approved_leases_found: backfillCandidates.length,
      leases_with_workflow_output: preDiagnostics.filter((d) => d.has_workflow_output).length,
      leases_with_expense_rules_in_payload: preDiagnostics.filter((d) => d.expense_rules_count > 0).length,
      leases_with_source_text: preDiagnostics.filter((d) => d.source_text_length > 0).length,
      rules_persisted_total: persistedTotal,
      leases_with_zero_rules: perLeaseResults.filter((r) => r.rules_persisted === 0).length,
    });
    console.groupEnd();

    toast.success(`Backfill complete — ${persistedTotal} rules across ${backfillCandidates.length} leases. Open DevTools console for diagnostic table.`);
    queryClient.invalidateQueries({ queryKey: ["lease-expense-rule-sets"] });
    queryClient.invalidateQueries({ queryKey: ["lease-expense-rule-sets-direct"] });
  };

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

  const updateRuleMutation = useMutation({
    mutationFn: async ({ ruleId, patch }) => {
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
    },
    onError: (error) => toast.error(error?.message || "Could not update rule"),
  });

  const approveRule = (rule) =>
    updateRuleMutation.mutateAsync({
      ruleId: rule.id,
      patch: {
        row_status: "mapped",
        review_status: "approved",
        approval_status: "approved",
        is_excluded: false,
        published_to_cam: false,
      },
    }).then(() => toast.success("Rule approved"));

  const rejectRule = (rule) =>
    updateRuleMutation.mutateAsync({
      ruleId: rule.id,
      patch: {
        row_status: "needs_review",
        review_status: "needs_review",
        approval_status: "draft",
        is_recoverable: false,
        is_excluded: true,
        published_to_cam: false,
      },
    }).then(() => toast.success("Rule rejected"));

  const markNARule = (rule) =>
    updateRuleMutation.mutateAsync({
      ruleId: rule.id,
      patch: {
        row_status: "unmapped",
        review_status: "approved",
        approval_status: "draft",
        is_excluded: true,
        is_recoverable: false,
        published_to_cam: false,
      },
    }).then(() => toast.success("Rule marked N/A"));

  const publishRuleToCam = (rule, propertyId) =>
    updateRuleMutation.mutateAsync({
      ruleId: rule.id,
      patch: {
        published_to_cam: true,
        review_status: "approved",
        approval_status: "approved",
      },
    }).then(() => {
      toast.success("Rule published to CAM");
      navigate(createPageUrl("CAMSetup") + `?property=${propertyId}`);
    });

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
              . CAM Setup and Budget consume only approved rules.
            </p>
          </div>
        </CardContent>
      </Card>

      {backfillCandidates.length > 0 && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-amber-900">
            <div>
              <p className="font-medium">
                {backfillCandidates.length} approved {backfillCandidates.length === 1 ? "lease has" : "leases have"} no expense rules yet
              </p>
              <p className="text-xs">
                Click below to extract rules from the lease document for each one. Uses the workflow output where available, otherwise re-runs extraction. Doesn't re-approve the abstract.
              </p>
            </div>
            <Button
              size="sm"
              className="bg-amber-600 text-white hover:bg-amber-700"
              onClick={runBackfill}
              disabled={backfillState.running}
            >
              {backfillState.running ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  Extracting {backfillState.done}/{backfillState.total}…
                </>
              ) : (
                <>
                  <RefreshCw className="mr-1 h-4 w-4" />
                  Extract rules from {backfillCandidates.length} approved {backfillCandidates.length === 1 ? "lease" : "leases"}
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      )}

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
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Billing Frequency</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Reconciliation Required</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Source Page</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Exact Source Text</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Confidence</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Extraction</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Review Status</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Published To CAM</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={22} className="py-12 text-center">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" />
                  </TableCell>
                </TableRow>
              ) : filteredRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={22} className="py-12 text-center text-sm text-slate-400">
                    No lease expense rules in this view. Approve a lease abstract and run rule extraction to populate this list.
                  </TableCell>
                </TableRow>
              ) : (
                filteredRows.map(({ rule, ruleSet, lease, property, category }) => {
                  const recoverableDecision = getRecoverableDecision(rule);
                  const camEligibleDecision = getCamEligibleDecision(rule);
                  const paymentTreatment = getPaymentTreatment(rule);
                  const responsibility = rule.responsibility || (
                    rule.included_in_base_rent
                      ? "Included in base rent"
                      : rule.is_excluded
                        ? "Tenant pays directly"
                        : ["yes", "conditional"].includes(recoverableDecision)
                          ? "Landlord (recoverable)"
                          : "Landlord"
                  );
                  const recoveryMethod = rule.recovery_method || (
                    (rule.billing_frequency || rule.frequency) === "monthly"
                      ? "Monthly billing"
                      : rule.base_year || rule.has_base_year
                        ? "Base year"
                        : rule.expense_stop_amount != null
                        ? "Expense stop"
                        : rule.is_subject_to_cap
                          ? "Capped"
                            : ["yes", "conditional"].includes(recoverableDecision)
                              ? "Annual pass-through"
                              : "-"
                  );
                  const allocationBasis =
                    rule.allocation_basis ||
                    (["yes", "conditional"].includes(recoverableDecision) ? "Pro-rata" : "-");
                  const capDisplay = rule.is_subject_to_cap
                    ? [
                        rule.cap_type || "",
                        rule.cap_percent != null ? `${rule.cap_percent}%` : null,
                        rule.cap_amount != null ? `$${Number(rule.cap_amount).toLocaleString()}` : null,
                        rule.cap_value != null && rule.cap_amount == null ? String(rule.cap_value) : null,
                      ].filter(Boolean).join(" ")
                    : "-";
                  const clause = (rule.clauses || [])[0];
                  const sourcePage = rule.source_page ?? clause?.page_number ?? null;
                  const sourceText = rule.exact_source_text || clause?.clause_text || rule.source || rule.notes || "-";

                  return (
                    <TableRow key={rule.id} className="align-top hover:bg-slate-50">
                      <TableCell className="text-sm font-medium text-slate-900">
                        {lease ? (
                          <Link
                            to={createPageUrl("LeaseExpenseClassification") + `?id=${lease.id}`}
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
                      </TableCell>
                      <TableCell className="text-sm text-slate-600">{property?.name || "-"}</TableCell>
                      <TableCell className="text-sm">
                        <div className="font-medium text-slate-900">
                          {rule.category_name || rule.expense_category || category?.category_name || "-"}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">
                        {rule.expense_subcategory || rule.subcategory_name || category?.subcategory_name || "-"}
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] ${rule.included_in_base_rent ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>
                          {rule.included_in_base_rent ? "Included" : "Separate"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">{responsibility}</TableCell>
                      <TableCell className="text-sm text-slate-700">{paymentTreatment}</TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] ${["yes", "conditional"].includes(recoverableDecision) && !rule.is_excluded ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                          {recoverableDecision || "no"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] ${["yes", "conditional"].includes(camEligibleDecision) ? "bg-sky-100 text-sky-700" : "bg-slate-100 text-slate-600"}`}>
                          {camEligibleDecision || "no"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">{recoveryMethod}</TableCell>
                      <TableCell className="text-sm text-slate-700">{allocationBasis}</TableCell>
                      <TableCell className="text-sm text-slate-700">{capDisplay}</TableCell>
                      <TableCell className="text-sm text-slate-700">
                        {rule.admin_fee_applicable ? (rule.admin_fee_percent ? `${rule.admin_fee_percent}%` : "Yes") : "-"}
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">
                        {rule.gross_up_applicable ? (rule.gross_up_percent ? `${rule.gross_up_percent}%` : "Yes") : "-"}
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">{rule.billing_frequency || rule.frequency || "-"}</TableCell>
                      <TableCell className="text-sm text-slate-700">{rule.reconciliation_required ? "Yes" : "No"}</TableCell>
                      <TableCell className="text-sm text-slate-700">{sourcePage ?? "-"}</TableCell>
                      <TableCell className="max-w-[260px] text-xs text-slate-600">
                        {sourceText && sourceText !== "-" ? <span className="italic">"{truncate(sourceText)}"</span> : "-"}
                      </TableCell>
                      <TableCell className="text-xs text-slate-700">{formatConfidence(rule.confidence_score)}</TableCell>
                      <TableCell className="text-xs text-slate-700">{rule.extraction_status || "-"}</TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] ${
                          isApprovedRule(rule)
                            ? "bg-emerald-100 text-emerald-700"
                            : needsReviewRule(rule)
                              ? "bg-amber-100 text-amber-800"
                              : ROW_STATUS_STYLE[rule.row_status] || "bg-slate-100 text-slate-700"
                        }`}>
                          {isApprovedRule(rule)
                            ? "Approved"
                            : needsReviewRule(rule)
                              ? "Needs Review"
                              : ROW_STATUS_LABEL[rule.row_status] || rule.row_status || "-"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] ${rule.published_to_cam ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>
                          {rule.published_to_cam ? "Published" : "Not Published"}
                        </Badge>
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
                                approveRule(rule);
                              }}
                              className="text-emerald-700 focus:text-emerald-800"
                            >
                              <Check className="mr-2 h-3.5 w-3.5" />
                              Approve rule
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={(event) => {
                                event.preventDefault();
                                rejectRule(rule);
                              }}
                              className="text-red-700 focus:text-red-800"
                            >
                              <X className="mr-2 h-3.5 w-3.5" />
                              Reject rule
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={(event) => {
                                event.preventDefault();
                                markNARule(rule);
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
                                <DropdownMenuItem asChild>
                                  <Link to={createPageUrl("LeaseExpenseClassification") + `?id=${lease.id}`}>
                                    <Pencil className="mr-2 h-3.5 w-3.5" />
                                    Edit rule details
                                  </Link>
                                </DropdownMenuItem>
                              </>
                            ) : null}

                            {lease?.property_id ? (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-slate-500">
                                  Downstream
                                </DropdownMenuLabel>
                                <DropdownMenuItem
                                  disabled={!leaseExpenseRuleService.canPublishRuleToCam(rule)}
                                  onSelect={(event) => {
                                    event.preventDefault();
                                    if (!leaseExpenseRuleService.canPublishRuleToCam(rule)) return;
                                    publishRuleToCam(rule, lease.property_id);
                                  }}
                                  className="text-blue-700 focus:text-blue-800"
                                  title={
                                    leaseExpenseRuleService.canPublishRuleToCam(rule)
                                      ? "Publish this rule to the CAM engine"
                                      : "Requires approved + recoverable + cam-eligible + not included in rent"
                                  }
                                >
                                  <Send className="mr-2 h-3.5 w-3.5" />
                                  Publish to CAM
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
        <Link to={createPageUrl("Expenses")} className="underline">Actual Expenses</Link>. Looking for CAM recovery setup? Go to{" "}
        <Link to={createPageUrl("CAMSetup")} className="underline">CAM Setup</Link>.
      </p>

      <Card className="border-slate-200 bg-slate-50">
        <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
          <span className="text-slate-600">
            <Calculator className="mr-1 inline h-4 w-4 text-slate-500" />
            Approved lease expense rules feed CAM Setup and Recovery Budget.
          </span>
          <Link to={createPageUrl("CAMDashboard")} className="text-blue-600 hover:text-blue-700">
            Go to CAM Dashboard {"->"}
          </Link>
        </CardContent>
      </Card>
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
