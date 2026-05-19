import React, { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";
import { ExpenseService } from "@/services/api";
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import { expenseService } from "@/services/expenseService";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import ExpenseClassificationTable from "@/components/ExpenseClassification/ExpenseClassificationTable";
import ExpenseValuePanel from "@/components/ExpenseClassification/ExpenseValuePanel";
import ClauseEvidenceDrawer from "@/components/ExpenseClassification/ClauseEvidenceDrawer";
import { createPageUrl } from "@/utils";

function getRuleForCategory(rules, categoryId) {
  return rules.find((rule) => rule.expense_category_id === categoryId) || null;
}

function categorizeCategory(category, rules) {
  const rule = getRuleForCategory(rules, category.id);
  if (!rule) return "needsReview";

  const recoveryStatus = leaseExpenseRuleService.normalizeRecoveryStatus(rule);
  if (recoveryStatus === "recoverable") return "recoverable";
  if (["non_recoverable", "excluded"].includes(recoveryStatus)) return "nonRecoverable";
  if (recoveryStatus === "conditional") return "conditional";
  return "needsReview";
}

export default function LeaseExpenseClassification() {
  // The link from Lease Expense Rules / Leases uses `?id=` (query string),
  // not a path param. Reading via useSearchParams handles both shapes.
  const [searchParams] = useSearchParams();
  const id = searchParams.get("id") || searchParams.get("lease_id") || null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [activeRuleSetId, setActiveRuleSetId] = useState(null);
  const [localRules, setLocalRules] = useState([]);
  const autoExtractedLeaseIds = useRef(new Set());

  // Filters State
  const [scopeType, setScopeType] = useState('property');
  const [frequency, setFrequency] = useState('yearly');

  // UI State
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [selectedRule, setSelectedRule] = useState(null);
  const [isEvidenceDrawerOpen, setIsEvidenceDrawerOpen] = useState(false);
  const [isValuePanelOpen, setIsValuePanelOpen] = useState(false);

  // Fetch Lease
  const { data: lease, isLoading: isLoadingLease } = useQuery({
    queryKey: ['lease', id],
    queryFn: async () => {
      const { data, error } = await supabase.from('leases').select('*').eq('id', id).single();
      if (error) throw error;
      return data;
    },
    enabled: !!id
  });

  // Fetch Taxonomies
  const { data: categories = [], isLoading: isLoadingCategories } = useQuery({
    queryKey: ['scope_expense_categories', scopeType, lease?.property_id, lease?.unit_id],
    queryFn: async () => {
      let scopeId = null;
      if (scopeType === 'property') scopeId = lease?.property_id;
      else if (scopeType === 'unit') scopeId = lease?.unit_id;

      if (scopeId) {
        const { data: scopeData, error: scopeErr } = await supabase
          .from('scope_expense_categories')
          .select('expense_category_id, is_applicable, expense_categories(*)')
          .eq('scope_type', scopeType)
          .eq('scope_id', scopeId)
          .eq('is_applicable', true);
        
        if (!scopeErr && scopeData && scopeData.length > 0) {
           return scopeData.map(s => s.expense_categories).filter(Boolean).sort((a,b) => a.display_order - b.display_order);
        }
      }

      // Fallback
      const { data, error } = await supabase.from('expense_categories')
        .select('*')
        .eq('is_active', true)
        .order('display_order', { ascending: true });
      if (error) {
        console.warn("[LeaseExpenseClassification] categories query failed:", error.message);
        return [];
      }
      return data || [];
    },
    enabled: !!lease
  });

  const effectiveCategories = useMemo(() => {
    if (categories.length > 0) return categories;
    return leaseExpenseRuleService.buildFallbackCategories({ lease, rules: localRules });
  }, [categories, lease, localRules]);

  // Fetch Active Rule Set & Rules
  const { data: ruleSetData, isLoading: isLoadingRules } = useQuery({
    queryKey: ['lease_expense_rule_sets', id],
    queryFn: () => leaseExpenseRuleService.loadRuleSet(id),
    enabled: !!id,
  });

  const ruleSet = ruleSetData?.ruleSet;

  React.useEffect(() => {
    if (!ruleSetData) return;
    setActiveRuleSetId(ruleSetData.ruleSet?.id || null);
    setLocalRules(ruleSetData.rules || []);
  }, [ruleSetData]);

  // Mutation: Extract with AI
  const extractRulesMutation = useMutation({
    mutationFn: async ({ silent = false } = {}) => {
      const persisted = await leaseExpenseRuleService.extractDraftRuleSet({
        lease,
        categories: effectiveCategories,
        existingRuleSetId: activeRuleSetId,
        existingRules: localRules,
      });

      return { persisted, silent };
    },
    onSuccess: ({ persisted, silent }) => {
      setActiveRuleSetId(persisted?.ruleSet?.id || null);
      setLocalRules(persisted?.rules || []);
      queryClient.invalidateQueries(['lease_expense_rule_sets', id]);
      if (!silent) {
        toast.success("AI extraction complete. Please review the draft rules.");
      }
    },
    onError: (err) => {
      toast.error(`Extraction failed: ${err.message}`);
    }
  });

  // Mutation: Save / Approve
  const saveRuleSetMutation = useMutation({
    mutationFn: async (status) => {
      const persisted = await leaseExpenseRuleService.saveRuleSet({
        lease,
        rules: localRules,
        status,
        existingRuleSetId: activeRuleSetId,
        categories: effectiveCategories,
      });

      if (status === "approved") {
        await expenseService.syncLeaseDerivedExpenses({ leases: [lease] });
        const propertyExpenses = await ExpenseService.filter({ property_id: lease.property_id });
        await expenseService.classifyExpenses({ expenses: propertyExpenses, leases: [lease] });
      }

      return persisted;
    },
    onSuccess: (persisted) => {
      setActiveRuleSetId(persisted?.ruleSet?.id || null);
      setLocalRules(persisted?.rules || []);
      queryClient.invalidateQueries(['lease_expense_rule_sets', id]);
      queryClient.invalidateQueries({ queryKey: ["Expense"] });
      queryClient.invalidateQueries({ queryKey: ["Lease"] });
      toast.success("Expense rules saved successfully.");
    },
    onError: (err) => {
      toast.error(`Save failed: ${err.message}`);
    }
  });

  // ── Classification mutation ───────────────────────────────────────────
  // Runs expenseService.classifyExpenses for this lease's actuals + rules
  // and persists the result into expense_classifications (lifecycle status,
  // exception type, recoverability decision, snapshot fields). Drives the
  // Expense Review and Expense Projection downstream pages.
  const classifyExpensesMutation = useMutation({
    mutationFn: async () => {
      if (!lease?.id) throw new Error("No lease loaded");
      return expenseService.classifyExpenses({
        expenses: actualExpenses,
        leases: [lease],
      });
    },
    onSuccess: (result) => {
      toast.success(
        `Classification complete: ${result?.classified || 0} matched, ${result?.needsReview || 0} need review.`,
      );
      queryClient.invalidateQueries({ queryKey: ["lease-actual-expenses", id] });
      queryClient.invalidateQueries({ queryKey: ["lease-expense-classifications", id] });
    },
    onError: (err) => {
      toast.error(`Classification failed: ${err?.message || "Unknown error"}`);
    },
  });

  React.useEffect(() => {
    if (!lease?.id || effectiveCategories.length === 0 || isLoadingRules) return;
    if (extractRulesMutation.isPending) return;
    if (autoExtractedLeaseIds.current.has(lease.id)) return;
    if ((localRules || []).length > 0) return;

    autoExtractedLeaseIds.current.add(lease.id);
    extractRulesMutation.mutate({ silent: true });
  }, [effectiveCategories, extractRulesMutation, isLoadingRules, lease?.id, localRules]);

  const groupedCategories = useMemo(() => {
    return effectiveCategories.reduce((groups, category) => {
      const key = categorizeCategory(category, localRules);
      groups[key].push(category);
      return groups;
    }, {
      recoverable: [],
      nonRecoverable: [],
      conditional: [],
      needsReview: [],
    });
  }, [effectiveCategories, localRules]);

  const ruleGroups = useMemo(
    () => leaseExpenseRuleService.groupRulesByRecoveryStatus(localRules),
    [localRules]
  );

  // ── Actual Expenses for this lease ────────────────────────────────────
  // Pulls all `expenses` rows the user can read where lease_id matches OR
  // (lease_id is null AND the expense scope overlaps this lease's
  // property/building/unit). This is the "actuals" side of the
  // rules-vs-actuals coordination shown below the grid.
  const { data: actualExpenses = [], isLoading: isLoadingActuals } = useQuery({
    queryKey: ["lease-actual-expenses", id, lease?.property_id],
    enabled: !!lease?.id,
    queryFn: async () => {
      const orFilter = [`lease_id.eq.${lease.id}`];
      if (lease.property_id) orFilter.push(`and(lease_id.is.null,property_id.eq.${lease.property_id})`);
      const { data, error } = await supabase
        .from("expenses")
        .select("id, lease_id, property_id, building_id, unit_id, category, amount, vendor, date, source, description, invoice_number")
        .or(orFilter.join(","))
        .order("date", { ascending: false })
        .limit(500);
      if (error) {
        console.warn("[LeaseExpenseClassification] actuals query failed:", error.message);
        return [];
      }
      return data || [];
    },
  });

  // Persisted classifications. Read so the page reflects the LAST
  // classification run, not just the live in-browser match (which can
  // change if rules change).
  const { data: persistedClassifications = [] } = useQuery({
    queryKey: ["lease-expense-classifications", id, lease?.property_id],
    enabled: !!lease?.id,
    queryFn: async () => {
      const orFilter = [`lease_id.eq.${lease.id}`];
      if (lease.property_id) orFilter.push(`and(lease_id.is.null,property_id.eq.${lease.property_id})`);
      const { data, error } = await supabase
        .from("expense_classifications")
        .select("id, expense_id, lease_expense_rule_id, recoverability_result, cam_eligible, recovery_method, recovery_reason, classification_status, exception_type, confidence_score, finalized_at, reviewed_at, amount")
        .or(orFilter.join(","))
        .order("classified_at", { ascending: false })
        .limit(1000);
      if (error) {
        console.warn("[LeaseExpenseClassification] classifications query failed:", error.message);
        return [];
      }
      return data || [];
    },
  });

  // Pair each actual expense to its best-matching rule (if any) using the
  // existing matcher service. Computes variance against the rule's
  // annualized expected amount where possible.
  const matchedActuals = useMemo(() => {
    if (!lease?.id || actualExpenses.length === 0) return [];
    const rulesByLeaseId = new Map([[lease.id, localRules]]);
    const leases = [lease];

    const ruleAnnualExpected = (rule) => {
      const raw = Number(rule?.final_value ?? rule?.manual_value ?? rule?.extracted_value ?? rule?.fixed_monthly_amount ?? rule?.explicit_charge_amount);
      if (!Number.isFinite(raw) || raw === 0) return null;
      const f = String(rule?.frequency || rule?.billing_frequency || "yearly").toLowerCase();
      if (f === "monthly") return raw * 12;
      if (f === "quarterly") return raw * 4;
      return raw;
    };

    // Plain-English explanation per row — what a non-engineer reading the
    // page needs to understand the classification decision.
    const buildPlainReason = (expense, rule, match) => {
      const cat = expense?.category || rule?.category_name || rule?.expense_category || "this expense";
      const niceCat = String(cat).replace(/_/g, " ");
      if (!rule) {
        return `This ${niceCat} expense needs review because no matching approved lease rule was found in the current scope.`;
      }
      const ruleLabel = rule.category_name || rule.expense_category || "matching lease rule";
      const niceRule = String(ruleLabel).replace(/_/g, " ");
      const payment = String(rule.payment_treatment || "").toLowerCase();
      const recoverable = String(match?.recoverability_result || rule.recoverable_from_tenant || "").toLowerCase();
      if (payment === "included_in_base_rent") {
        return `This ${niceCat} expense is non-recoverable because the approved ${niceRule} rule says it is included in base rent.`;
      }
      if (recoverable === "recoverable") {
        const method = rule.recovery_method ? ` via ${String(rule.recovery_method).replace(/_/g, " ")}` : "";
        return `This ${niceCat} expense is recoverable from the tenant${method} per the approved ${niceRule} rule.`;
      }
      if (recoverable === "conditional") {
        return `This ${niceCat} expense is conditionally recoverable — the approved ${niceRule} rule has a cap, base year, or condition that needs human review before recovery.`;
      }
      if (recoverable === "excluded" || recoverable === "non_recoverable") {
        return `This ${niceCat} expense is non-recoverable per the approved ${niceRule} rule.`;
      }
      return `This ${niceCat} expense matched the ${niceRule} rule but the recovery decision needs review.`;
    };

    return actualExpenses.map((expense) => {
      const match = expenseService.matchActualExpenseToLeaseRule(expense, { leases, rulesByLeaseId });
      const rule = match?.rule || null;
      const expectedAnnual = ruleAnnualExpected(rule);
      const actualAmount = Number(expense?.amount) || 0;
      const variance = expectedAnnual != null ? actualAmount - (expectedAnnual / 12) : null;
      const plainReason = buildPlainReason(expense, rule, match);
      return {
        expense,
        rule,
        matchScore: match?.score ?? 0,
        recoverability: match?.recoverability_result || "needs_review",
        recoveryMethod: match?.recovery_method || rule?.recovery_method || null,
        camEligible: match?.cam_eligible || null,
        reason: match?.reason || null,
        plainReason,
        expectedAnnual,
        variance,
      };
    });
  }, [actualExpenses, localRules, lease]);

  // Roll up matched actuals by bucket so the totals card can show
  // "Actual vs Rule" comparison alongside the rule-based forecast.
  const actualTotals = useMemo(() => {
    const buckets = {
      recoverable: { count: 0, ytd: 0 },
      non_recoverable: { count: 0, ytd: 0 },
      conditional: { count: 0, ytd: 0 },
      needs_review: { count: 0, ytd: 0 },
      unmatched: { count: 0, ytd: 0 },
    };
    let total = 0;
    for (const m of matchedActuals) {
      const amount = Number(m.expense?.amount) || 0;
      total += amount;
      const key =
        m.recoverability === "recoverable" ? "recoverable"
        : m.recoverability === "non_recoverable" || m.recoverability === "excluded" ? "non_recoverable"
        : m.recoverability === "conditional" ? "conditional"
        : !m.rule ? "unmatched"
        : "needs_review";
      buckets[key].count += 1;
      buckets[key].ytd += amount;
    }
    return { buckets, total };
  }, [matchedActuals]);

  // ── Total Expense Calculation ─────────────────────────────────────────
  // Rolls up dollar amounts across rules into recoverable / non-recoverable /
  // conditional totals at both monthly and annual cadence. Used by the
  // sidebar's "Total Expense Calculation" card. Per-rule frequency is
  // normalized to annual; rules without a value are excluded from the sum
  // but counted under "needs value".
  const expenseTotals = useMemo(() => {
    const toNumber = (v) => {
      if (v == null || v === "") return null;
      const n = Number(String(v).replace(/[$,%\s,]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const annualize = (amount, freq) => {
      if (amount == null) return null;
      const f = String(freq || "").toLowerCase();
      if (f === "monthly") return amount * 12;
      if (f === "quarterly") return amount * 4;
      if (f === "yearly" || f === "annual" || !f) return amount;
      if (f === "triggered" || f === "none") return null;
      return amount;
    };
    const buckets = {
      recoverable:    { annual: 0, monthly: 0, count: 0, withValue: 0, noValue: 0 },
      non_recoverable:{ annual: 0, monthly: 0, count: 0, withValue: 0, noValue: 0 },
      conditional:    { annual: 0, monthly: 0, count: 0, withValue: 0, noValue: 0 },
      excluded:       { annual: 0, monthly: 0, count: 0, withValue: 0, noValue: 0 },
    };
    const categoryRows = []; // for the per-category breakdown table
    for (const rule of localRules) {
      const decision = leaseExpenseRuleService.normalizeRecoveryStatus(rule);
      const bucketKey =
        rule.is_excluded ? "excluded"
        : decision === "recoverable" ? "recoverable"
        : decision === "conditional" ? "conditional"
        : decision === "non_recoverable" || decision === "excluded" ? "non_recoverable"
        : null;
      if (!bucketKey) continue;
      const bucket = buckets[bucketKey];
      bucket.count += 1;
      const rawAmount = toNumber(rule.final_value ?? rule.manual_value ?? rule.extracted_value ?? rule.fixed_monthly_amount ?? rule.explicit_charge_amount);
      const annual = annualize(rawAmount, rule.frequency || rule.billing_frequency);
      if (annual != null) {
        bucket.annual += annual;
        bucket.monthly += annual / 12;
        bucket.withValue += 1;
      } else {
        bucket.noValue += 1;
      }
      if (rawAmount != null) {
        categoryRows.push({
          category: rule.category_name || rule.subcategory_name || rule.expense_category,
          bucket: bucketKey,
          frequency: rule.frequency || rule.billing_frequency || "yearly",
          amount: rawAmount,
          annual: annual ?? 0,
        });
      }
    }
    const totalAnnual = buckets.recoverable.annual + buckets.non_recoverable.annual + buckets.conditional.annual + buckets.excluded.annual;
    return { buckets, totalAnnual, totalMonthly: totalAnnual / 12, categoryRows };
  }, [localRules]);

  const fmtMoney = (n) => `$${Math.round(n || 0).toLocaleString()}`;

  const handleEditRule = (category, rule) => {
    setSelectedCategory(category);
    setSelectedRule(rule);
    setIsValuePanelOpen(true);
  };

  const handleViewEvidence = (category, rule) => {
    setSelectedCategory(category);
    setSelectedRule(rule);
    setIsEvidenceDrawerOpen(true);
  };

  const handleSaveRule = (updatedRule) => {
    setLocalRules(prev => {
      const existingIdx = prev.findIndex(r => r.expense_category_id === updatedRule.expense_category_id);
      if (existingIdx >= 0) {
        const newRules = [...prev];
        newRules[existingIdx] = updatedRule;
        return newRules;
      } else {
        return [...prev, updatedRule];
      }
    });
    setIsValuePanelOpen(false);
  };

  const isWorking = isLoadingLease || isLoadingCategories || isLoadingRules || extractRulesMutation.isPending || saveRuleSetMutation.isPending;

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <Button variant="ghost" onClick={() => navigate(-1)} className="mb-2">
        <ArrowLeft className="w-4 h-4 mr-2" /> Back
      </Button>

      <PageHeader
        icon={FileText}
        title="Expense Recoverability"
        subtitle={lease
          ? `Matching actual expenses to approved lease rules for: ${lease.tenant_name || 'Lease'}`
          : 'Loading...'}
        iconColor="from-blue-600 to-indigo-600"
      >
        <div className="flex flex-wrap gap-2">
          <Link to={createPageUrl("AddExpense", { lease_id: id })}>
            <Button variant="outline" size="sm" disabled={isWorking}>Add Expense</Button>
          </Link>
          <Link to={createPageUrl("BulkImport", { lease_id: id })}>
            <Button variant="outline" size="sm" disabled={isWorking}>Bulk Import</Button>
          </Link>
          <Link to={createPageUrl("LeaseExpenseRules") + (lease?.property_id ? `?property=${lease.property_id}` : "")}>
            <Button variant="outline" size="sm" disabled={isWorking}>Manage Lease Rules</Button>
          </Link>
          <Button
            className="bg-slate-900 hover:bg-slate-800 text-white"
            size="sm"
            onClick={() => classifyExpensesMutation.mutate()}
            disabled={classifyExpensesMutation.isPending || actualExpenses.length === 0 || localRules.length === 0}
            title={
              actualExpenses.length === 0
                ? "Add actual expenses first"
                : localRules.length === 0
                ? "Approve lease expense rules first"
                : "Match actuals against rules and persist results"
            }
          >
            {classifyExpensesMutation.isPending ? "Running Classification…" : "Run Classification"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/LeaseReview?id=${id}`)}
            disabled={isWorking}
          >
            <ArrowLeft className="w-4 h-4 mr-1" /> Lease Review
          </Button>
        </div>
      </PageHeader>

      {/* ── Empty-state guards ────────────────────────────────────────────
          Per spec: don't show fake zero charts. If actuals or approved
          rules are missing, surface the precondition prominently. */}
      {!isLoadingActuals && actualExpenses.length === 0 && (
        <Card className="border-amber-200 bg-amber-50/70">
          <CardContent className="flex items-start gap-3 p-4 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="flex-1">
              <p className="font-semibold">No actual expenses found for this lease.</p>
              <p className="mt-1 text-xs">
                Add or import expenses before classification.{" "}
                <Link to={createPageUrl("AddExpense", { lease_id: id })} className="underline">Add one manually</Link>
                {" or "}
                <Link to={createPageUrl("BulkImport", { lease_id: id })} className="underline">bulk import a CSV</Link>.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      {!isLoadingRules && localRules.length === 0 && (
        <Card className="border-rose-200 bg-rose-50/70">
          <CardContent className="flex items-start gap-3 p-4 text-sm text-rose-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="flex-1">
              <p className="font-semibold">No approved lease expense rules found.</p>
              <p className="mt-1 text-xs">
                Approve lease expense rules before classification.{" "}
                <Link to={createPageUrl("LeaseExpenseRules")} className="underline">Open Lease Expense Rules</Link>{" "}
                to extract and approve them.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── 8 top cards per spec ──────────────────────────────────────────
          Actuals Loaded · Approved Rules · Matched · Recoverable $ ·
          Non-Recoverable $ · Conditional/Needs Review $ · Finalized $ ·
          CAM Eligible $ */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        <SummaryCard label="Actuals Loaded"          value={actualExpenses.length}                                        tone="slate" />
        <SummaryCard label="Approved Rules"          value={localRules.filter((r) => r.approval_status === "approved" || r.review_status === "approved").length} tone="slate" />
        <SummaryCard label="Matched"                 value={matchedActuals.filter((m) => m.rule).length}                  tone="blue" />
        <SummaryCard label="Recoverable"             value={fmtMoney(actualTotals.buckets.recoverable.ytd)}               tone="emerald" />
        <SummaryCard label="Non-Recoverable"         value={fmtMoney(actualTotals.buckets.non_recoverable.ytd)}           tone="rose" />
        <SummaryCard label="Conditional / Review"    value={fmtMoney(actualTotals.buckets.conditional.ytd + actualTotals.buckets.needs_review.ytd)} tone="amber" />
        <SummaryCard
          label="Finalized"
          value={fmtMoney(persistedClassifications.filter((c) => c.classification_status === "finalized").reduce((s, c) => s + Number(c.amount || 0), 0))}
          tone="emerald"
        />
        <SummaryCard
          label="CAM Eligible"
          value={fmtMoney(matchedActuals.filter((m) => m.camEligible === "yes" || m.camEligible === "conditional").reduce((s, m) => s + Number(m.expense?.amount || 0), 0))}
          tone="blue"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Main area — Actuals vs Rules table is the primary surface now.
            The per-lease rule grid was previously the main content; it has
            been demoted to a collapsible "Lease Rule Reference" panel
            below because rule approval belongs on the Lease Expense Rules
            page, not here. */}
        <div className="md:col-span-3 space-y-4">
          <details className="rounded-lg border border-slate-200 bg-slate-50/60">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-700">
              Lease Rule Reference
              <span className="ml-2 text-xs font-normal text-slate-500">
                ({localRules.length} rules — open Lease Expense Rules to approve / edit)
              </span>
            </summary>
            <div className="border-t border-slate-200 p-4">
              {isLoadingCategories ? (
                <div className="py-8 text-center text-slate-500">Loading taxonomy...</div>
              ) : (
                <div className="space-y-6">
                  <RuleGroupSection
                    title="Recoverable Rules"
                    description="These lease clauses allow the expense to be recovered from the tenant."
                    categories={groupedCategories.recoverable}
                    rules={localRules}
                    tone="emerald"
                    frequency={frequency}
                    onEditRule={handleEditRule}
                    onViewEvidence={handleViewEvidence}
                  />
                  <RuleGroupSection
                    title="Non-Recoverable Rules"
                    description="These costs stay with ownership or are explicitly excluded."
                    categories={groupedCategories.nonRecoverable}
                    rules={localRules}
                    tone="rose"
                    frequency={frequency}
                    onEditRule={handleEditRule}
                    onViewEvidence={handleViewEvidence}
                  />
                  <RuleGroupSection
                    title="Conditional Rules"
                    description="These clauses depend on caps, base years, gross-up logic, or other conditions."
                    categories={groupedCategories.conditional}
                    rules={localRules}
                    tone="amber"
                    frequency={frequency}
                    onEditRule={handleEditRule}
                    onViewEvidence={handleViewEvidence}
                  />
                  <RuleGroupSection
                    title="Needs Review / Unmapped"
                    description="Finish the yes/no mapping or add the value manually when the lease mentions the item but no numeric amount was found."
                    categories={groupedCategories.needsReview}
                    rules={localRules}
                    tone="slate"
                    frequency={frequency}
                    onEditRule={handleEditRule}
                    onViewEvidence={handleViewEvidence}
                  />
                </div>
              )}
            </div>
          </details>

          {/* ── Actuals vs Rules Coordination ──────────────────────────── */}
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle>Actual Expenses vs Lease Rules</CardTitle>
                <p className="mt-1 text-sm text-slate-500">
                  Each invoice / bulk-imported / manually-added expense for this lease, matched against the rule that governs its recovery. Click <em>Run Classification</em> to persist decisions to <code>expense_classifications</code> — that's what feeds Expense Review and Expense Projection.
                </p>
              </div>
              <div className="flex flex-shrink-0 flex-col items-end gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px] uppercase">
                    {matchedActuals.length} actuals
                  </Badge>
                  <Badge variant="outline" className="text-[10px] uppercase text-slate-500">
                    YTD {`$${Math.round(actualTotals.total).toLocaleString()}`}
                  </Badge>
                </div>
                {persistedClassifications.length > 0 && (
                  <div className="flex items-center gap-2 text-[10px] text-slate-500">
                    <Badge variant="outline" className="bg-emerald-50 text-emerald-700">
                      {persistedClassifications.filter((c) => c.classification_status === "finalized").length} finalized
                    </Badge>
                    <Badge variant="outline" className="bg-amber-50 text-amber-700">
                      {persistedClassifications.filter((c) => c.classification_status === "exception" || c.exception_type).length} exceptions
                    </Badge>
                  </div>
                )}
                <Button
                  size="sm"
                  className="bg-slate-900 hover:bg-slate-800"
                  onClick={() => classifyExpensesMutation.mutate()}
                  disabled={classifyExpensesMutation.isPending || actualExpenses.length === 0}
                  title={
                    actualExpenses.length === 0
                      ? "Import or add actual expenses first"
                      : "Match every actual against approved lease rules and persist the decisions"
                  }
                >
                  {classifyExpensesMutation.isPending ? "Classifying…" : "Run Classification"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {isLoadingActuals ? (
                <div className="py-8 text-center text-sm text-slate-500">Loading actuals…</div>
              ) : matchedActuals.length === 0 ? (
                <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                  <p className="font-medium text-slate-700">No actual expenses imported yet for this lease.</p>
                  <p className="mt-1 text-xs">
                    Use <Link to={createPageUrl("AddExpense", { lease_id: lease?.id })} className="text-blue-600 underline">Add Expense</Link>,{" "}
                    <Link to={createPageUrl("BulkImport", { lease_id: lease?.id })} className="text-blue-600 underline">Bulk Import</Link>,
                    or connect an invoice feed. They'll be matched against the rules above automatically.
                  </p>
                </div>
              ) : (
                <>
                  {/* Per-bucket summary chips */}
                  <div className="mb-3 flex flex-wrap gap-2 text-[11px]">
                    <ActualsBucketChip label="Recoverable"     count={actualTotals.buckets.recoverable.count}     amount={actualTotals.buckets.recoverable.ytd}     tone="emerald" />
                    <ActualsBucketChip label="Conditional"     count={actualTotals.buckets.conditional.count}     amount={actualTotals.buckets.conditional.ytd}     tone="amber" />
                    <ActualsBucketChip label="Non-Recoverable" count={actualTotals.buckets.non_recoverable.count} amount={actualTotals.buckets.non_recoverable.ytd} tone="rose" />
                    <ActualsBucketChip label="Needs Review"    count={actualTotals.buckets.needs_review.count}    amount={actualTotals.buckets.needs_review.ytd}    tone="slate" />
                    <ActualsBucketChip label="Unmatched"       count={actualTotals.buckets.unmatched.count}       amount={actualTotals.buckets.unmatched.ytd}       tone="red" />
                  </div>

                  <div className="overflow-x-auto rounded-md border border-slate-200">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                        <tr>
                          <th className="px-3 py-2 text-left">Date</th>
                          <th className="px-3 py-2 text-left">Vendor / Invoice</th>
                          <th className="px-3 py-2 text-left">Category</th>
                          <th className="px-3 py-2 text-right">Actual</th>
                          <th className="px-3 py-2 text-left">Matched Rule</th>
                          <th className="px-3 py-2 text-left">CAM Eligible</th>
                          <th className="px-3 py-2 text-right">Rule (annual)</th>
                          <th className="px-3 py-2 text-right">Variance / mo</th>
                          <th className="px-3 py-2 text-left">Recovery</th>
                          <th className="px-3 py-2 text-left max-w-[320px]">Why</th>
                          <th className="px-3 py-2 text-left">Source</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {matchedActuals.map(({ expense, rule, recoverability, expectedAnnual, variance, recoveryMethod, camEligible, plainReason }) => {
                          const recoveryTone =
                            recoverability === "recoverable" ? "bg-emerald-100 text-emerald-800"
                            : recoverability === "conditional" ? "bg-amber-100 text-amber-800"
                            : recoverability === "non_recoverable" || recoverability === "excluded" ? "bg-rose-100 text-rose-800"
                            : !rule ? "bg-red-100 text-red-800"
                            : "bg-slate-200 text-slate-700";
                          return (
                            <tr key={expense.id} className="hover:bg-slate-50">
                              <td className="px-3 py-2 text-slate-700">{expense.date || "—"}</td>
                              <td className="px-3 py-2">
                                <div className="font-medium text-slate-900">{expense.vendor || "—"}</div>
                                {expense.invoice_number && (
                                  <div className="text-[10px] text-slate-500">#{expense.invoice_number}</div>
                                )}
                              </td>
                              <td className="px-3 py-2 text-slate-700">{expense.category || "—"}</td>
                              <td className="px-3 py-2 text-right font-mono font-semibold text-slate-900">
                                {`$${Math.round(Number(expense.amount) || 0).toLocaleString()}`}
                              </td>
                              <td className="px-3 py-2 text-slate-700">
                                {rule ? (
                                  <div>
                                    <div className="font-medium">{rule.category_name || rule.expense_category}</div>
                                    {recoveryMethod && (
                                      <div className="text-[10px] text-slate-500">{recoveryMethod.replace(/_/g, " ")}</div>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-red-700">No matching rule</span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <Badge className={`text-[10px] uppercase ${
                                  camEligible === "yes" ? "bg-emerald-100 text-emerald-800"
                                  : camEligible === "conditional" ? "bg-amber-100 text-amber-800"
                                  : "bg-slate-100 text-slate-600"
                                }`}>
                                  {camEligible ? String(camEligible).replace(/_/g, " ") : "—"}
                                </Badge>
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-slate-700">
                                {expectedAnnual != null ? `$${Math.round(expectedAnnual).toLocaleString()}` : "—"}
                              </td>
                              <td className={`px-3 py-2 text-right font-mono ${variance == null ? "text-slate-400" : variance > 0 ? "text-rose-700" : variance < 0 ? "text-emerald-700" : "text-slate-700"}`}>
                                {variance == null ? "—" : `${variance > 0 ? "+" : ""}$${Math.round(variance).toLocaleString()}`}
                              </td>
                              <td className="px-3 py-2">
                                <Badge className={`${recoveryTone} text-[10px] uppercase`}>
                                  {recoverability?.replace(/_/g, " ") || "—"}
                                </Badge>
                              </td>
                              <td className="px-3 py-2 text-[11px] text-slate-600 max-w-[320px]" title={plainReason}>
                                <span className="line-clamp-2">{plainReason}</span>
                              </td>
                              <td className="px-3 py-2 text-[10px] text-slate-500">{expense.source || "manual"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <p className="mt-3 text-[11px] text-slate-500">
                    Variance is per-month: actual amount minus (rule annual ÷ 12). Negative = under-budget, positive = over-budget. Rules with no dollar value can't compute variance.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar Area */}
        <div className="space-y-4">
          {/* ── Total Expense Calculation ─────────────────────────────── */}
          <Card className="border-slate-200">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Total Expense Calculation</CardTitle>
                <Badge variant="outline" className="text-[10px] uppercase">Lease total</Badge>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Annualized rollup of all rule amounts. Rules with no dollar value are excluded from the total but counted separately.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg bg-slate-900 px-4 py-3 text-white">
                <div className="text-[10px] uppercase tracking-wider text-slate-300">Estimated Annual</div>
                <div className="mt-1 text-2xl font-bold">{fmtMoney(expenseTotals.totalAnnual)}</div>
                <div className="mt-0.5 text-xs text-slate-300">
                  {fmtMoney(expenseTotals.totalMonthly)} / month
                </div>
              </div>

              <div className="space-y-2 text-xs">
                <TotalRow
                  label="Recoverable from tenant"
                  count={expenseTotals.buckets.recoverable.count}
                  withValue={expenseTotals.buckets.recoverable.withValue}
                  annual={expenseTotals.buckets.recoverable.annual}
                  tone="emerald"
                />
                <TotalRow
                  label="Conditional"
                  count={expenseTotals.buckets.conditional.count}
                  withValue={expenseTotals.buckets.conditional.withValue}
                  annual={expenseTotals.buckets.conditional.annual}
                  tone="amber"
                />
                <TotalRow
                  label="Non-recoverable"
                  count={expenseTotals.buckets.non_recoverable.count}
                  withValue={expenseTotals.buckets.non_recoverable.withValue}
                  annual={expenseTotals.buckets.non_recoverable.annual}
                  tone="rose"
                />
                <TotalRow
                  label="Excluded"
                  count={expenseTotals.buckets.excluded.count}
                  withValue={expenseTotals.buckets.excluded.withValue}
                  annual={expenseTotals.buckets.excluded.annual}
                  tone="slate"
                />
              </div>

              {expenseTotals.categoryRows.length > 0 && (
                <details className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                  <summary className="cursor-pointer font-medium text-slate-700">
                    Per-category breakdown ({expenseTotals.categoryRows.length})
                  </summary>
                  <table className="mt-2 w-full text-[11px]">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="text-left">Category</th>
                        <th className="text-left">Freq</th>
                        <th className="text-right">Amount</th>
                        <th className="text-right">Annual</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expenseTotals.categoryRows.map((row, i) => (
                        <tr key={i} className="border-t border-slate-200">
                          <td className="py-1 pr-2 text-slate-700">{row.category}</td>
                          <td className="py-1 pr-2 text-slate-500">{row.frequency}</td>
                          <td className="py-1 pr-2 text-right font-mono text-slate-700">{fmtMoney(row.amount)}</td>
                          <td className="py-1 text-right font-mono font-semibold text-slate-900">{fmtMoney(row.annual)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}

              <div className="border-t border-slate-200 pt-2 text-[11px] text-slate-500">
                Rules with no dollar amount yet:{" "}
                <span className="font-semibold text-slate-700">
                  {Object.values(expenseTotals.buckets).reduce((s, b) => s + b.noValue, 0)}
                </span>
                {" "}— set values in Edit rule details to include them.
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Impact Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="p-4 bg-slate-50 rounded-lg border border-slate-100 space-y-4">
                <p className="text-sm text-slate-500 text-center mb-2">
                  Preview based on the current drafted rules.
                </p>

                <div className="flex justify-between items-center border-b pb-2">
                  <span className="text-sm font-medium text-slate-700">Categories Mapped</span>
                  <span className="font-bold text-slate-900">
                    {localRules.filter(r => r.review_status === 'approved').length} / {effectiveCategories.length}
                  </span>
                </div>

                <div className="flex justify-between items-center border-b pb-2">
                  <span className="text-sm font-medium text-slate-700">Explicitly Excluded</span>
                  <span className="font-bold text-rose-600">
                    {localRules.filter(r => r.is_excluded || r.is_recoverable === false).length}
                  </span>
                </div>

                <div className="flex justify-between items-center border-b pb-2">
                  <span className="text-sm font-medium text-slate-700">Subject to Cap</span>
                  <span className="font-bold text-blue-600">
                    {localRules.filter(r => r.is_subject_to_cap).length}
                  </span>
                </div>

                <div className="flex justify-between items-center pb-2">
                  <span className="text-sm font-medium text-slate-700">Needs Review</span>
                  <span className="font-bold text-amber-600">
                    {localRules.filter(r => r.review_status === 'needs_review' || r.row_status === 'needs_review' || r.row_status === 'uncertain').length}
                  </span>
                </div>
              </div>

              <div className="mt-4 p-3 bg-blue-50 border border-blue-100 rounded-md text-sm text-blue-800">
                Approving this rule set updates lease CAM config, persists clause evidence and values, and refreshes downstream classification readiness without creating Actual Expense rows.
              </div>
              <Button
                className="mt-4 w-full bg-slate-900 hover:bg-slate-800"
                onClick={() =>
                  navigate(
                    createPageUrl("ExpenseReview", {
                      property: lease?.property_id,
                      building: lease?.building_id,
                      unit: lease?.unit_id,
                    })
                  )
                }
              >
                Continue to Expense Review
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <ClauseEvidenceDrawer
        isOpen={isEvidenceDrawerOpen}
        onClose={() => setIsEvidenceDrawerOpen(false)}
        category={selectedCategory}
        rule={selectedRule}
      />

      <ExpenseValuePanel
        isOpen={isValuePanelOpen}
        onClose={() => setIsValuePanelOpen(false)}
        category={selectedCategory}
        rule={selectedRule}
        onSave={handleSaveRule}
      />

    </div>
  );
}

function SummaryCard({ label, value, tone }) {
  const TONE = {
    emerald: "border-emerald-200 bg-emerald-50/60",
    rose:    "border-rose-200 bg-rose-50/60",
    amber:   "border-amber-200 bg-amber-50/60",
    blue:    "border-blue-200 bg-blue-50/60",
    slate:   "border-slate-200 bg-slate-50/60",
  };
  const TXT = {
    emerald: "text-emerald-900",
    rose:    "text-rose-900",
    amber:   "text-amber-900",
    blue:    "text-blue-900",
    slate:   "text-slate-900",
  };
  return (
    <Card className={`border ${TONE[tone] || TONE.slate}`}>
      <CardContent className="p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
        <div className={`mt-1 text-lg font-bold tabular-nums ${TXT[tone] || TXT.slate}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function ActualsBucketChip({ label, count, amount, tone }) {
  const TONE = {
    emerald: "border-emerald-300 bg-emerald-50 text-emerald-800",
    rose:    "border-rose-300 bg-rose-50 text-rose-800",
    amber:   "border-amber-300 bg-amber-50 text-amber-900",
    slate:   "border-slate-300 bg-slate-50 text-slate-700",
    red:     "border-red-300 bg-red-50 text-red-800",
  };
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 ${TONE[tone] || TONE.slate}`}>
      <span className="font-medium">{label}</span>
      <span className="font-mono text-slate-900">{count}</span>
      <span className="text-slate-500">·</span>
      <span className="font-mono">{`$${Math.round(amount || 0).toLocaleString()}`}</span>
    </span>
  );
}

function TotalRow({ label, count, withValue, annual, tone }) {
  const TONE_CLASSES = {
    emerald: { label: "text-emerald-700", chip: "bg-emerald-100 text-emerald-800", value: "text-emerald-900" },
    rose:    { label: "text-rose-700",    chip: "bg-rose-100 text-rose-800",       value: "text-rose-900" },
    amber:   { label: "text-amber-700",   chip: "bg-amber-100 text-amber-900",     value: "text-amber-900" },
    slate:   { label: "text-slate-600",   chip: "bg-slate-200 text-slate-700",     value: "text-slate-800" },
  };
  const c = TONE_CLASSES[tone] || TONE_CLASSES.slate;
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-slate-100 bg-white px-3 py-2">
      <div>
        <div className={`text-[11px] font-medium ${c.label}`}>{label}</div>
        <div className="mt-0.5 text-[10px] text-slate-500">
          {count} rule{count === 1 ? "" : "s"}
          {withValue < count ? ` · ${count - withValue} without value` : ""}
        </div>
      </div>
      <div className={`text-right font-mono text-sm font-semibold ${c.value}`}>
        {`$${Math.round(annual || 0).toLocaleString()}`}
        <div className="text-[10px] font-normal text-slate-400">/ yr</div>
      </div>
    </div>
  );
}

function RuleGroupSection({
  title,
  description,
  categories,
  rules,
  tone,
  onEditRule,
  onViewEvidence,
}) {
  const toneClasses = {
    emerald: "border-emerald-200 bg-emerald-50/40",
    rose: "border-rose-200 bg-rose-50/40",
    amber: "border-amber-200 bg-amber-50/40",
    slate: "border-slate-200 bg-slate-50/70",
  };

  return (
    <div className={`rounded-xl border p-4 ${toneClasses[tone] || toneClasses.slate}`}>
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <p className="mt-1 text-xs text-slate-600">{description}</p>
      </div>
      {categories.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-white/80 px-4 py-6 text-center text-xs text-slate-500">
          No categories are in this bucket yet.
        </div>
      ) : (
        <ExpenseClassificationTable
          categories={categories}
          rules={rules}
          onEditRule={onEditRule}
          onViewEvidence={onViewEvidence}
        />
      )}
    </div>
  );
}
