/**
 * LeaseExpenseClassification — Expense Recoverability
 *
 * This is the bridge between Approved Lease Expense Rules and Approved Actual Expenses.
 *
 * Data flow:
 *   useOrgQuery("Expense") → filter approved actuals (approved_status = "approved")
 *   leaseExpenseRuleService.loadRuleSets() → filter approved rule sets
 *   Cross-match by category/lease → build combined rows
 *   Actions: Finalize, Send to CAM, Send to Budget
 */
import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRightCircle,
  Check,
  CheckCircle,
  DollarSign,
  FileText,
  Info,
  Loader2,
  MoreHorizontal,
  Edit2,
  Trash2,
  Plus,
  RefreshCw,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import useOrgQuery from "@/hooks/useOrgQuery";
import { buildHierarchyScope, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import { expenseService } from "@/services/expenseService";
import { supabase } from "@/services/supabaseClient";
import { createPageUrl } from "@/utils";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// ─── helpers ───────────────────────────────────────────────────────────────

function fmt(val) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(val || 0);
}

function categoryMatch(expense, rule) {
  const ec = String(expense?.category || expense?.expense_subcategory || "").toLowerCase().replace(/\W+/g, "_").trim();
  const rc = String(
    rule?.category_name || rule?.normalized_key || rule?.expense_category || rule?.expense_subcategory || ""
  ).toLowerCase().replace(/\W+/g, "_").trim();
  if (!ec || !rc) return false;
  return ec.includes(rc) || rc.includes(ec) || ec === rc;
}

function isApprovedExpense(e) {
  // Accept any approval indicator — the Actual Expenses page can set any of these
  const st = String(e.approved_status || e.status || "").toLowerCase();
  const rs = String(e.recovery_status || "").toLowerCase();
  return (
    st === "approved" ||
    rs === "approved" ||
    rs === "recoverable" ||
    rs === "non_recoverable" ||
    rs === "conditional"
    // Note: "needs_review" is intentionally excluded — only truly reviewed rows flow here
  );
}

function isApprovedRule(r) {
  const st = String(r.review_status || r.approval_status || r.row_status || "").toLowerCase();
  return st === "approved" || st === "mapped" || st === "manually_added";
}

function recoverabilityFromRule(rule) {
  const rt = leaseExpenseRuleService.getRecoverableDecision(rule);
  if (rt === "yes") return "recoverable";
  if (rt === "conditional") return "conditional";
  return "non_recoverable";
}

function expenseRecoverability(expense) {
  const rs = String(expense.recoverability_result || expense.recovery_status || expense.classification || "needs_review").toLowerCase();
  if (rs === "recoverable") return "recoverable";
  if (["non_recoverable", "excluded"].includes(rs)) return "non_recoverable";
  if (rs === "conditional") return "conditional";
  return "needs_review";
}

// ─── component ─────────────────────────────────────────────────────────────

export default function LeaseExpenseClassification() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit,     setScopeUnit]     = useState("all");
  const [scopeLease,    setScopeLease]    = useState("all");
  // Default to "all" years — expenses may span different fiscal years
  const [scopeYear,     setScopeYear]     = useState("all");
  const [activeTab,     setActiveTab]     = useState("all");
  const [search,        setSearch]        = useState("");
  const [selectedIds,   setSelectedIds]   = useState(new Set());
  const [amountEditing, setAmountEditing] = useState({}); // ruleId → amount string

  // ── base data (same pattern as Expenses.jsx / LeaseExpenseRules.jsx) ─────
  const { data: allExpenses = [], isLoading: loadingExp } = useOrgQuery("Expense");
  const { data: leases = [], isLoading: loadingLeases }   = useOrgQuery("Lease");
  const { data: properties = [] }  = useOrgQuery("Property");
  const { data: buildings  = [] }  = useOrgQuery("Building");
  const { data: units      = [] }  = useOrgQuery("Unit");

  // Build scope from org data
  const scope = useMemo(
    () => buildHierarchyScope({ search: "", portfolios: [], properties, buildings, units }),
    [properties, buildings, units]
  );

  // ── scoped leases ─────────────────────────────────────────────────────────
  const scopedLeases = useMemo(() => {
    return leases.filter((l) => {
      if (!matchesHierarchyScope(l, scope, { propertyKey: "property_id", unitKey: "unit_id" })) return false;
      if (scopeProperty !== "all" && l.property_id !== scopeProperty) return false;
      const unit = l.unit_id ? scope.unitById.get(l.unit_id) : null;
      const buildingId = unit?.building_id || l.building_id || null;
      if (scopeBuilding !== "all" && buildingId !== scopeBuilding) return false;
      if (scopeUnit !== "all" && l.unit_id !== scopeUnit) return false;
      if (scopeLease !== "all" && l.id !== scopeLease) return false;
      return true;
    });
  }, [leases, scope, scopeProperty, scopeBuilding, scopeUnit, scopeLease]);

  const scopedLeaseIds = useMemo(() => scopedLeases.map((l) => l.id), [scopedLeases]);

  // ── approved actual expenses ──────────────────────────────────────────────
  // IMPORTANT: Many real expenses (property-level invoices) do NOT have lease_id set.
  // We filter by property/building/unit only — not by lease or year.
  const approvedActuals = useMemo(() => {
    return allExpenses.filter((e) => {
      // Exclude synthetic lease-import rows (these are derived, not real invoices)
      if (e.source_type === "lease_import" || e.source === "lease_import") return false;
      // Must be approved/reviewed
      if (!isApprovedExpense(e)) return false;
      // Scope: property > building > unit (skip lease — many expenses have no lease_id)
      if (scopeProperty !== "all" && e.property_id !== scopeProperty) return false;
      if (scopeBuilding !== "all" && e.building_id !== scopeBuilding) return false;
      if (scopeUnit !== "all" && e.unit_id !== scopeUnit) return false;
      // If a specific lease is selected, include expenses for that lease OR with no lease
      if (scopeLease !== "all" && e.lease_id && e.lease_id !== scopeLease) return false;
      // Year filter — only apply when explicitly set to a specific year
      if (scopeYear !== "all" && e.fiscal_year && String(e.fiscal_year) !== scopeYear) return false;
      return true;
    });
  }, [allExpenses, scopeProperty, scopeBuilding, scopeUnit, scopeLease, scopeYear]);

  // ── approved rule sets ────────────────────────────────────────────────────
  // Load rule sets for ALL leases in scope. If no leases scoped but property selected,
  // we still load all rules for leases in that property.
  const allLeaseIds = useMemo(() => leases.map((l) => l.id), [leases]);
  const ruleLeaseIds = useMemo(() => {
    // If specific leases are scoped, use those; otherwise use ALL leases in the org
    // (we filter by property-matched leases or fall back to all if nothing scoped)
    if (scopedLeaseIds.length > 0) return scopedLeaseIds;
    return allLeaseIds;
  }, [scopedLeaseIds, allLeaseIds]);

  const { data: ruleSets = [], isLoading: loadingRules } = useQuery({
    queryKey: ["expense-classification-rule-sets", ruleLeaseIds.slice(0, 50).join("|")],
    queryFn: () => leaseExpenseRuleService.loadRuleSets(ruleLeaseIds.slice(0, 50)),
    enabled: ruleLeaseIds.length > 0,
  });

  const approvedRules = useMemo(() => {
    return ruleSets
      .flatMap((entry) =>
        (entry.rules || []).filter(isApprovedRule).map((r) => ({
          ...r,
          _leaseId: entry.leaseId,
          _ruleSet: entry.ruleSet,
        }))
      );
  }, [ruleSets]);

  // ── cross-match rows ──────────────────────────────────────────────────────
  // Matching strategy:
  //   1. If expense has a lease_id AND a rule exists for that lease with same category → MATCHED
  //   2. If expense has no lease_id, try matching by category alone against any in-scope rule → MATCHED
  //   3. If no match → UNMATCHED EXPENSE row
  //   4. Rules with no matching expense → RULE ONLY row
  const rows = useMemo(() => {
    const result = [];
    const usedRuleIds = new Set();
    const usedExpenseIds = new Set();

    for (const expense of approvedActuals) {
      // Try matching rule: same lease (if lease_id set) OR any in-scope rule with same category
      const matchingRule = approvedRules.find(
        (r) =>
          !usedRuleIds.has(r.id) &&
          // Either same lease or expense has no lease (property-level)
          (expense.lease_id
            ? (r._leaseId === expense.lease_id || r.lease_id === expense.lease_id)
            : true) &&
          categoryMatch(expense, r)
      );
      if (matchingRule) {
        usedRuleIds.add(matchingRule.id);
        usedExpenseIds.add(expense.id);
        result.push({
          _id: `exp_${expense.id}__rule_${matchingRule.id}`,
          matched: true,
          expense,
          rule: matchingRule,
          category: expense.category || matchingRule.category_name || "—",
          amount: Number(expense.amount) || 0,
          ruleAmount: null,
          recoverability: expenseRecoverability(expense) !== "needs_review"
            ? expenseRecoverability(expense)
            : recoverabilityFromRule(matchingRule),
          camEligible: leaseExpenseRuleService.getCamEligibleDecision(matchingRule),
          status: expense.classification_updated_at ? "finalized" : "matched",
        });
      } else {
        if (!usedExpenseIds.has(expense.id)) {
          usedExpenseIds.add(expense.id);
          result.push({
            _id: `exp_${expense.id}`,
            matched: false,
            expense,
            rule: null,
            category: expense.category || "—",
            amount: Number(expense.amount) || 0,
            ruleAmount: null,
            // Use the expense's own recoverability status — this is set by Actual Expenses page
            recoverability: expenseRecoverability(expense),
            camEligible: "no",
            status: expense.classification_updated_at ? "finalized" : "unmatched",
          });
        }
      }
    }

    // Unmatched rules (no actual expense yet)
    for (const rule of approvedRules) {
      if (!usedRuleIds.has(rule.id)) {
        result.push({
          _id: `rule_${rule.id}`,
          matched: false,
          expense: null,
          rule,
          category: rule.category_name || rule.normalized_key || "—",
          amount: 0,
          ruleAmount: null,
          recoverability: recoverabilityFromRule(rule),
          camEligible: leaseExpenseRuleService.getCamEligibleDecision(rule),
          status: "rule_only",
        });
      }
    }

    return result;
  }, [approvedActuals, approvedRules]);

  // ── filter rows for active tab ────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (activeTab === "recoverable")     return row.recoverability === "recoverable";
      if (activeTab === "non_recoverable") return row.recoverability === "non_recoverable";
      if (activeTab === "conditional")     return row.recoverability === "conditional";
      if (activeTab === "needs_review")    return row.recoverability === "needs_review" || row.status === "unmatched";
      if (activeTab === "cam_eligible")    return ["yes", "conditional"].includes(row.camEligible);
      if (activeTab === "rule_only")       return row.status === "rule_only";
      return true; // "all"
    }).filter((row) => {
      if (!search) return true;
      const hay = [row.category, row.expense?.vendor, row.expense?.description, row.rule?.category_name]
        .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(search.toLowerCase());
    });
  }, [rows, activeTab, search]);

  // ── totals for summary cards ──────────────────────────────────────────────
  const totals = useMemo(() => {
    let recoverable = 0, nonRecoverable = 0, conditional = 0, needsReview = 0, camEligible = 0;
    for (const row of rows) {
      const amt = row.ruleAmount ?? row.amount;
      if (row.recoverability === "recoverable")     recoverable += amt;
      if (row.recoverability === "non_recoverable") nonRecoverable += amt;
      if (row.recoverability === "conditional")     conditional += amt;
      if (row.recoverability === "needs_review" || row.status === "unmatched") needsReview += amt;
      if (["yes", "conditional"].includes(row.camEligible)) camEligible += amt;
    }
    return { recoverable, nonRecoverable, conditional, needsReview, camEligible };
  }, [rows]);

  const counts = useMemo(() => ({
    all:             rows.length,
    recoverable:     rows.filter((r) => r.recoverability === "recoverable").length,
    non_recoverable: rows.filter((r) => r.recoverability === "non_recoverable").length,
    conditional:     rows.filter((r) => r.recoverability === "conditional").length,
    needs_review:    rows.filter((r) => r.recoverability === "needs_review" || r.status === "unmatched").length,
    cam_eligible:    rows.filter((r) => ["yes", "conditional"].includes(r.camEligible)).length,
    rule_only:       rows.filter((r) => r.status === "rule_only").length,
  }), [rows]);

  // ── mutations ─────────────────────────────────────────────────────────────
  const finalizeMutation = useMutation({
    mutationFn: async (ids) => {
      const rowsToFinalize = Array.from(ids)
        .map((rowId) => rows.find((r) => r._id === rowId))
        .filter((row) => row?.expense?.id);
      await Promise.all(
        rowsToFinalize.map((row) => expenseService.finalizeExpenseClassification(row.expense.id, row.recoverability))
      );
      return rowsToFinalize.length;
    },
    onSuccess: (count) => {
      toast.success(`Finalized ${count} expense(s)`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["Expense"] });
    },
    onError: (err) => toast.error(err?.message || "Finalize failed"),
  });

  const sendToCamMutation = useMutation({
    mutationFn: async (ids) => {
      const camRows = Array.from(ids)
        .map((rowId) => rows.find((r) => r._id === rowId))
        .filter((row) => ["yes", "conditional"].includes(row?.camEligible) && row?.expense?.id);
      if (camRows.length === 0) throw new Error("No CAM-eligible rows selected");
      await Promise.all(
        camRows.map((row) =>
          expenseService.reviewExpense(row.expense, {
            recoveryStatus: "recoverable",
            approvedStatus: "approved",
            ruleSource: "cam",
            reason: "Sent to CAM from Expense Classification",
          })
        )
      );
      return camRows.length;
    },
    onSuccess: (count) => {
      toast.success(`${count} expense(s) sent to CAM`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["Expense"] });
    },
    onError: (err) => toast.error(err?.message || "Send to CAM failed"),
  });

  // update amount for a rule-only row
  const updateRuleAmountMutation = useMutation({
    mutationFn: async ({ ruleId, amount }) => {
      const { error } = await supabase
        .from("lease_expense_rules")
        .update({ final_value: amount, manual_value: amount })
        .eq("id", ruleId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Amount saved");
      queryClient.invalidateQueries({ queryKey: ["expense-classification-rule-sets"] });
    },
    onError: (err) => toast.error(err?.message || "Save failed"),
  });

  // ── selection helpers ─────────────────────────────────────────────────────
  const toggleRow = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = (e) => {
    if (e.target.checked) setSelectedIds(new Set(filteredRows.map((r) => r._id)));
    else setSelectedIds(new Set());
  };

  const isLoading = loadingExp || loadingLeases || loadingRules;

  // ── recoverability badge styling ──────────────────────────────────────────
  function recoverBadge(r) {
    if (r === "recoverable")     return "bg-emerald-50 text-emerald-700 border-emerald-200";
    if (r === "non_recoverable") return "bg-rose-50 text-rose-700 border-rose-200";
    if (r === "conditional")     return "bg-amber-50 text-amber-700 border-amber-200";
    return "bg-slate-100 text-slate-600 border-slate-200";
  }

  function camBadge(c) {
    if (c === "yes")         return "bg-blue-50 text-blue-700";
    if (c === "conditional") return "bg-sky-50 text-sky-700";
    return "bg-slate-100 text-slate-400";
  }

  const currentYear = new Date().getFullYear();
  const yearOptions = [currentYear - 1, currentYear, currentYear + 1];

  return (
    <div className="flex flex-col h-full bg-slate-50/50 min-h-screen pb-20">

      {/* ── Header ── */}
      <div className="bg-slate-900 border-b border-slate-800 text-white shadow-sm">
        <div className="max-w-screen-xl mx-auto px-6 py-4">
          {/* Title row */}
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 mb-4">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-bold tracking-tight">Expense Recoverability</h1>
              <Badge variant="outline" className="bg-white/10 text-indigo-200 border-indigo-500/30 font-normal text-xs hidden sm:inline-flex">
                Classification Engine
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="h-8 bg-white/5 hover:bg-white/10 text-white border-white/10 text-xs" onClick={() => navigate(createPageUrl("AddExpense"))}>
                <Plus className="w-3 h-3 mr-1.5" /> Add Expense
              </Button>
              <Button size="sm" variant="outline" className="h-8 bg-white/5 hover:bg-white/10 text-white border-white/10 text-xs" onClick={() => navigate(createPageUrl("BulkImport"))}>
                <Upload className="w-3 h-3 mr-1.5" /> Bulk Import
              </Button>
              <Button size="sm" variant="outline" className="h-8 bg-white/5 hover:bg-white/10 text-white border-white/10 text-xs" onClick={() => navigate(createPageUrl("LeaseExpenseRules"))}>
                <FileText className="w-3 h-3 mr-1.5" /> Lease Rules
              </Button>
              <Button size="sm" variant="outline" className="h-8 bg-white/5 hover:bg-white/10 text-white border-white/10 text-xs" onClick={() => navigate(createPageUrl("ExpenseReview"))}>
                <CheckCircle className="w-3 h-3 mr-1.5" /> Expense Review
              </Button>
            </div>
          </div>

          {/* Compact scope toolbar */}
          <div className="flex flex-wrap items-center gap-2 bg-white/5 px-3 py-2 rounded-lg border border-white/10 text-xs">
            <span className="text-slate-400 font-medium uppercase tracking-wider mr-1">Scope:</span>
            <select
              className="h-7 bg-slate-800 border border-slate-700 text-slate-200 rounded px-2 focus:ring-1 focus:ring-indigo-500 outline-none"
              value={scopeProperty} onChange={(e) => setScopeProperty(e.target.value)}
            >
              <option value="all">All Properties</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.property_name || p.name}</option>)}
            </select>
            <select
              className="h-7 bg-slate-800 border border-slate-700 text-slate-200 rounded px-2 focus:ring-1 focus:ring-indigo-500 outline-none"
              value={scopeBuilding} onChange={(e) => setScopeBuilding(e.target.value)}
            >
              <option value="all">All Buildings</option>
              {buildings
                .filter((b) => scopeProperty === "all" || b.property_id === scopeProperty)
                .map((b) => <option key={b.id} value={b.id}>{b.building_name || b.name}</option>)}
            </select>
            <select
              className="h-7 bg-slate-800 border border-slate-700 text-slate-200 rounded px-2 focus:ring-1 focus:ring-indigo-500 outline-none"
              value={scopeUnit} onChange={(e) => setScopeUnit(e.target.value)}
            >
              <option value="all">All Units</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.unit_number || u.unit_id_code}</option>)}
            </select>
            <select
              className="h-7 bg-slate-800 border border-slate-700 text-slate-200 rounded px-2 focus:ring-1 focus:ring-indigo-500 outline-none"
              value={scopeLease} onChange={(e) => setScopeLease(e.target.value)}
            >
              <option value="all">All Leases</option>
              {leases.map((l) => <option key={l.id} value={l.id}>{l.tenant_name || l.id.slice(0, 8)}</option>)}
            </select>
            <select
              className="h-7 bg-slate-800 border border-slate-700 text-slate-200 rounded px-2 focus:ring-1 focus:ring-indigo-500 outline-none"
              value={scopeYear} onChange={(e) => setScopeYear(e.target.value)}
            >
              <option value="all">All Years</option>
              {yearOptions.map((y) => <option key={y} value={String(y)}>{y}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="max-w-screen-xl mx-auto w-full px-6 mt-6 space-y-6">

        {/* ── Banners ── */}
        {!isLoading && approvedActuals.length === 0 && (
          <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-5 py-4">
            <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0 text-amber-600" />
            <div className="flex-1">
              <p className="font-semibold text-sm">No approved actual expenses in this scope</p>
              <p className="text-xs mt-1 text-amber-700">Go to Actual Expenses and set <code className="bg-amber-100 px-1 rounded">approved_status = approved</code> before running classification.</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button size="sm" variant="outline" className="bg-white text-amber-900 border-amber-300 h-8 text-xs" onClick={() => navigate(createPageUrl("Expenses"))}>Actual Expenses</Button>
              <Button size="sm" variant="outline" className="bg-white text-amber-900 border-amber-300 h-8 text-xs" onClick={() => navigate(createPageUrl("AddExpense"))}>Add Expense</Button>
            </div>
          </div>
        )}

        {!isLoading && approvedActuals.length > 0 && approvedRules.length === 0 && (
          <div className="flex items-start gap-3 bg-rose-50 border border-rose-200 text-rose-900 rounded-xl px-5 py-4">
            <Info className="w-5 h-5 mt-0.5 shrink-0 text-rose-600" />
            <div className="flex-1">
              <p className="font-semibold text-sm">No approved lease expense rules found</p>
              <p className="text-xs mt-1 text-rose-700">You have {approvedActuals.length} approved expense(s) but no approved rules. Approve rules in Lease Expense Rules to enable recoverability matching.</p>
            </div>
            <Button size="sm" variant="outline" className="bg-white text-rose-900 border-rose-300 h-8 text-xs shrink-0" onClick={() => navigate(createPageUrl("LeaseExpenseRules"))}>Lease Rules</Button>
          </div>
        )}

        {/* ── Summary Cards ── */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: "Actuals Loaded",    value: approvedActuals.length, unit: "rows", color: "border-t-slate-400" },
            { label: "Rules Loaded",      value: approvedRules.length,   unit: "rules", color: "border-t-slate-400" },
            { label: "Recoverable",       value: fmt(totals.recoverable),    color: "border-t-emerald-500" },
            { label: "Non-Recoverable",   value: fmt(totals.nonRecoverable), color: "border-t-rose-500" },
            { label: "CAM-Eligible Pool", value: fmt(totals.camEligible),    color: "border-t-blue-500" },
          ].map((card) => (
            <Card key={card.label} className={`border-t-4 ${card.color} shadow-sm`}>
              <CardContent className="p-4">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">{card.label}</p>
                <p className="text-xl font-bold text-slate-800">{card.value}</p>
                {card.unit && <p className="text-xs text-slate-400 mt-0.5">{card.unit}</p>}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* ── Action Bar ── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Input
              placeholder="Search category, vendor, description..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-72 h-9 text-sm"
            />
            {isLoading && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={selectedIds.size === 0 || finalizeMutation.isPending}
              onClick={() => finalizeMutation.mutate(selectedIds)}
              className="h-9 border-indigo-200 text-indigo-700 hover:bg-indigo-50 text-xs"
            >
              <Check className="w-3.5 h-3.5 mr-1.5" />
              Finalize ({selectedIds.size})
            </Button>
            <Button
              size="sm"
              disabled={selectedIds.size === 0 || sendToCamMutation.isPending}
              onClick={() => sendToCamMutation.mutate(selectedIds)}
              className="h-9 bg-blue-600 hover:bg-blue-700 text-xs"
            >
              <ArrowRightCircle className="w-3.5 h-3.5 mr-1.5" />
              Send to CAM ({selectedIds.size})
            </Button>
          </div>
        </div>

        {/* ── Tabs + Table ── */}
        <Card className="border-0 shadow-md rounded-xl overflow-hidden bg-white">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="px-4 pt-3 border-b bg-slate-50">
              <TabsList className="bg-transparent h-auto pb-3 gap-1 flex-wrap">
                {[
                  { val: "all",             label: `All (${counts.all})` },
                  { val: "recoverable",     label: `Recoverable (${counts.recoverable})` },
                  { val: "non_recoverable", label: `Non-Recoverable (${counts.non_recoverable})` },
                  { val: "conditional",     label: `Conditional (${counts.conditional})` },
                  { val: "needs_review",    label: `Needs Review (${counts.needs_review})` },
                  { val: "cam_eligible",    label: `CAM Eligible (${counts.cam_eligible})` },
                  { val: "rule_only",       label: `Rules Only (${counts.rule_only})` },
                ].map(({ val, label }) => (
                  <TabsTrigger
                    key={val}
                    value={val}
                    className="data-[state=active]:bg-white data-[state=active]:text-indigo-700 data-[state=active]:shadow-sm border border-transparent data-[state=active]:border-slate-200 rounded-full px-3 py-1 text-xs font-medium"
                  >
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            <TabsContent value={activeTab} className="m-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-slate-50 sticky top-0">
                    <TableRow>
                      <TableHead className="w-10 text-center">
                        <input
                          type="checkbox"
                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4"
                          checked={filteredRows.length > 0 && selectedIds.size === filteredRows.length}
                          onChange={toggleAll}
                        />
                      </TableHead>
                      <TableHead className="text-[10px] uppercase font-bold text-slate-500">Category</TableHead>
                      <TableHead className="text-[10px] uppercase font-bold text-slate-500">Tenant</TableHead>
                      <TableHead className="text-[10px] uppercase font-bold text-slate-500">Vendor</TableHead>
                      <TableHead className="text-[10px] uppercase font-bold text-slate-500 text-right">Actual Amt</TableHead>
                      <TableHead className="text-[10px] uppercase font-bold text-slate-500 text-right">Rule Amt</TableHead>
                      <TableHead className="text-[10px] uppercase font-bold text-slate-500">Recoverability</TableHead>
                      <TableHead className="text-[10px] uppercase font-bold text-slate-500 text-center">CAM</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      <TableRow>
                        <TableCell colSpan={10} className="py-16 text-center">
                          <Loader2 className="w-6 h-6 animate-spin mx-auto text-slate-300" />
                          <p className="text-sm text-slate-400 mt-2">Loading expenses and rules…</p>
                        </TableCell>
                      </TableRow>
                    ) : filteredRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={10} className="py-16 text-center">
                          <FileText className="w-10 h-10 mx-auto text-slate-200 mb-3" />
                          <p className="text-sm text-slate-400">No records in this view.</p>
                          {approvedActuals.length === 0 && (
                            <p className="text-xs text-slate-400 mt-1">Approve actual expenses in <button className="underline text-indigo-500" onClick={() => navigate(createPageUrl("Expenses"))}>Actual Expenses</button> first.</p>
                          )}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredRows.map((row) => {
                        const ruleEditing = amountEditing[row.rule?.id] ?? "";
                        const expenseEditing = amountEditing[row.expense?.id] ?? "";
                        const lease = row.expense?.lease_id ? leases.find(l => l.id === row.expense.lease_id) : null;
                        const ruleLease = row.rule?.lease_id ? leases.find(l => l.id === row.rule.lease_id) : null;
                        const tenant = row.expense?.tenant_name || lease?.tenant_name || ruleLease?.tenant_name || "—";
                        const vendor = row.expense?.vendor || "—";
                        const ruleAmt = row.rule
                          ? (row.rule.final_value ?? row.rule.manual_value ?? row.rule.extracted_value ?? null)
                          : null;
                        const isSelected = selectedIds.has(row._id);

                        return (
                          <TableRow key={row._id} className="group hover:bg-indigo-50/30 transition-colors border-b-slate-100">
                            <TableCell className="text-center">
                              <input
                                type="checkbox"
                                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4 cursor-pointer"
                                checked={isSelected}
                                onChange={() => toggleRow(row._id)}
                              />
                            </TableCell>
                            <TableCell className="font-medium text-slate-800 text-sm">
                              {String(row.category).replace(/_/g, " ")}
                            </TableCell>
                            <TableCell className="text-slate-500 text-xs">{tenant}</TableCell>
                            <TableCell className="text-slate-500 text-xs">{vendor}</TableCell>
                            <TableCell className="text-right font-medium text-slate-700 text-sm">
                              {row.expense ? (
                                <div className="flex items-center justify-end gap-1">
                                  {amountEditing[row.expense.id] !== undefined ? (
                                    <Input
                                      autoFocus
                                      className="h-7 w-24 text-xs text-right font-mono"
                                      value={expenseEditing}
                                      placeholder="Enter $"
                                      onChange={(e) => setAmountEditing((prev) => ({ ...prev, [row.expense.id]: e.target.value }))}
                                      onBlur={() => {
                                        const val = Number(String(expenseEditing).replace(/[$,\s]/g, ""));
                                        if (Number.isFinite(val) && val > 0) {
                                          expenseService.updateExpenseAmount(row.expense.id, val)
                                            .then(() => queryClient.invalidateQueries({ queryKey: ["Expense"] }))
                                            .catch((err) => toast.error(err?.message || "Failed to update amount"));
                                        }
                                        setAmountEditing((prev) => { const n = { ...prev }; delete n[row.expense.id]; return n; });
                                      }}
                                    />
                                  ) : (
                                    <span 
                                      className="cursor-pointer hover:bg-slate-100 px-2 py-1 rounded"
                                      onClick={() => setAmountEditing((prev) => ({ ...prev, [row.expense.id]: String(row.expense.amount || "") }))}
                                    >
                                      {fmt(row.expense.amount)}
                                    </span>
                                  )}
                                </div>
                              ) : <span className="text-slate-300">—</span>}
                            </TableCell>
                            <TableCell className="text-sm text-right">
                              {row.rule ? (
                                <div className="flex items-center justify-end gap-1">
                                  <Input
                                    className="h-7 w-24 text-xs text-right font-mono"
                                    value={amountEditing[row.rule.id] !== undefined ? ruleEditing : (ruleAmt !== null ? String(ruleAmt) : "")}
                                    placeholder="Enter $"
                                    onChange={(e) => setAmountEditing((prev) => ({ ...prev, [row.rule.id]: e.target.value }))}
                                    onBlur={() => {
                                      const val = Number(String(ruleEditing).replace(/[$,\s]/g, ""));
                                      if (Number.isFinite(val) && val > 0) {
                                        updateRuleAmountMutation.mutate({ ruleId: row.rule.id, amount: val });
                                      }
                                      setAmountEditing((prev) => { const n = { ...prev }; delete n[row.rule.id]; return n; });
                                    }}
                                  />
                                </div>
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className={`border text-[10px] uppercase ${recoverBadge(row.recoverability)}`}>
                                {String(row.recoverability || "—").replace(/_/g, " ")}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-center">
                              <span className={`text-[10px] px-2 py-0.5 rounded font-medium uppercase ${camBadge(row.camEligible)}`}>
                                {row.camEligible || "no"}
                              </span>
                            </TableCell>
                            <TableCell className="text-right pr-4">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-slate-100 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <MoreHorizontal className="w-4 h-4 text-slate-500" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-40">
                                  <DropdownMenuItem onClick={() => finalizeMutation.mutate(new Set([row._id]))} disabled={finalizeMutation.isPending}>
                                    <Check className="w-4 h-4 mr-2 text-indigo-600" />
                                    Finalize
                                  </DropdownMenuItem>
                                  {row.rule ? (
                                    <DropdownMenuItem onClick={() => setAmountEditing({ ...amountEditing, [row.rule.id]: String(ruleAmt || "") })}>
                                      <Edit2 className="w-4 h-4 mr-2 text-slate-500" />
                                      Edit Rule Amount
                                    </DropdownMenuItem>
                                  ) : row.expense ? (
                                    <DropdownMenuItem onClick={() => setAmountEditing({ ...amountEditing, [row.expense.id]: String(row.expense.amount || "") })}>
                                      <Edit2 className="w-4 h-4 mr-2 text-slate-500" />
                                      Edit Expense Amount
                                    </DropdownMenuItem>
                                  ) : null}
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem className="text-rose-600">
                                    <Trash2 className="w-4 h-4 mr-2" />
                                    Delete
                                  </DropdownMenuItem>
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

        {/* ── Downstream Legend ── */}
        <div className="flex flex-wrap gap-4 text-xs text-slate-500 border-t pt-4">
          <span className="flex items-center gap-1.5"><DollarSign className="w-3.5 h-3.5 text-blue-500" /> <strong>CAM:</strong> Recoverable + CAM-Eligible rows → Send to CAM module</span>
          <span className="flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5 text-emerald-500" /> <strong>Budget:</strong> Finalized rows flow into Expense Projection → Budget</span>
          <span className="flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5 text-indigo-500" /> <strong>Review:</strong> Exceptions (unmatched / conditional) → Expense Review queue</span>
        </div>

      </div>
    </div>
  );
}
