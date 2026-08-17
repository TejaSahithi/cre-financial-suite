/**
 * CAMSetup — Guided 7-step CAM setup workflow, automation + business
 * usability pass.
 *
 *   Step 1 — Property / Period:  select property, automatic period suggestion, source-data summary
 *   Step 2 — Pools:              automatic pool suggestions (confirm/rename/combine/remove) + custom pools
 *   Step 3 — Participants:       automatic participant suggestions per pool + manual include/exclude with reason
 *   Step 4 — Policies:           complete policy display derived from materialized policy steps
 *   Step 5 — Expenses:           complete expense display, assign/split, readiness gaps
 *   Step 6 — Estimates & Adjustments: bulk monthly estimate entry + prior adjustments
 *   Step 7 — Readiness:          Readiness Action Center — business-friendly, resolvable, "Start CAM Run"
 *
 * Scope (property/building/unit/calendar/period) and the current step
 * persist in the URL, not component state, so they survive a refresh and
 * direct navigation to any step. This file does not calculate anything —
 * every figure shown is read from already-materialized/published/approved
 * records; every write goes through the cam-setup-actions-v2 edge function
 * (service-role, audited), never a silent local-only fallback.
 */
import React, { useMemo, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAssistantPageContext } from "@/assistant/useAssistantContext";
import { toast } from "sonner";
import {
  AlertTriangle, CheckCircle2, XCircle, ChevronRight, ChevronLeft,
  Plus, Trash2, Settings2, Users, FileText, DollarSign, ClipboardCheck, Loader2,
  Sparkles, ExternalLink, Combine, RefreshCw, Calculator, SlidersHorizontal,
  LayoutGrid, ClipboardList, Boxes, TrendingUp, HandCoins,
} from "lucide-react";

import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import StatCard from "@/components/lease-expense/StatCard";
import useOrgQuery from "@/hooks/useOrgQuery";
import useExpenseCategories from "@/hooks/useExpenseCategories";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { createPageUrl } from "@/utils";
import PageHeader from "@/components/PageHeader";
import ScopeSelector from "@/components/ScopeSelector";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

import {
  calendarTypeLabel, poolTypeLabel, scopeTypeLabel,
  policyStatusLabel, adjustmentTypeLabel, adjustmentStateLabel,
  participantStatusLabel, recoverabilityLabel,
  paymentDirectionLabel, paymentDirectionTone,
} from "@/lib/camLabels";
import { summarizePolicy } from "@/lib/camPolicySummary";
import { suggestPools, suggestParticipants } from "@/lib/camSuggestions";
import { normalizeReadiness, computeExpenseGapExceptions, mergeReadiness, suggestedPeriodForCalendar } from "@/lib/camReadiness";
import { buildCamActiveLeaseIdSet, filterCamActiveLeases, filterRowsToCamActiveLeases } from "@/lib/activeLease";

// ---- Helpers ----------------------------------------------------------------

function fmtCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function StatusBadge({ ready }) {
  return ready
    ? <Badge className="text-[11px] font-semibold bg-emerald-100 text-emerald-700">READY</Badge>
    : <Badge className="text-[11px] font-semibold bg-red-100 text-red-700">NOT READY</Badge>;
}

// Same donut recipe as src/components/dashboard/OccupancyChart.jsx (PieChart
// + centered label overlay) -- reused here directly rather than importing
// that component, since its data shape (properties) doesn't fit.
function Donut({ segments, centerValue, centerLabel }) {
  const data = segments.filter((s) => s.value > 0);
  if (data.length === 0) return <p className="text-xs text-slate-400 flex items-center justify-center h-28">No data</p>;
  return (
    <div className="relative w-28 h-28 mx-auto">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={34} outerRadius={50} dataKey="value" startAngle={90} endAngle={-270} stroke="none">
            {data.map((s, i) => <Cell key={i} fill={s.color} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-2">
        <span className="text-sm font-extrabold text-slate-900 leading-tight">{centerValue}</span>
        <span className="text-[9px] text-slate-400">{centerLabel}</span>
      </div>
    </div>
  );
}

function fmtDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

// Same tone mapping as CAMRun.jsx's StatusBadge, kept local since this file
// already owns a differently-shaped StatusBadge({ready}) for readiness.
function RunStatusBadge({ status }) {
  const tone =
    status === "posted" ? "bg-emerald-100 text-emerald-700"
    : status === "approved" ? "bg-emerald-100 text-emerald-700"
    : status === "submitted" || status === "under_review" ? "bg-amber-100 text-amber-800"
    : status === "calculated" ? "bg-blue-100 text-blue-700"
    : status === "readiness_failed" ? "bg-red-100 text-red-700"
    : "bg-slate-100 text-slate-600";
  return <Badge className={`text-[10px] uppercase font-semibold ${tone}`}>{status}</Badge>;
}

/** Every write in this wizard goes through cam-setup-actions-v2 (service-role,
 * audited). No silent fallback to a direct RPC or browser-local storage --
 * a failed write must surface as a real error, not a false "saved".
 * invokeEdgeFunction already throws on any error and resolves directly with
 * the response body on success (it is NOT a {data,error} tuple) -- an
 * earlier version of this wrapper destructured it as one, which silently
 * discarded every successful response and is why the previous version of
 * this file needed an elaborate fallback chain in the first place. */
async function camSetupAction(action, payload) {
  return invokeEdgeFunction("cam-setup-actions-v2", { action, ...payload });
}

const STEPS = [
  { id: 1, label: "Property / Period", icon: FileText },
  { id: 2, label: "Pools", icon: Settings2 },
  { id: 3, label: "Participants", icon: Users },
  { id: 4, label: "Policies", icon: ClipboardCheck },
  { id: 5, label: "Expenses", icon: DollarSign },
  { id: 6, label: "Estimates & Adjustments", icon: DollarSign },
  { id: 7, label: "Readiness", icon: CheckCircle2 },
];

export default function CAMSetup() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // ---- Requirement 1: scope persists in the URL, not component state ------
  const propertyId = searchParams.get("property_id") || "";
  const buildingId = searchParams.get("building_id") || "";
  const unitId = searchParams.get("unit_id") || "";
  const periodId = searchParams.get("period_id") || "";
  const selectedPoolId = searchParams.get("pool_id") || "";
  const step = Math.min(7, Math.max(1, Number(searchParams.get("step") || "1")));
  // Reconciliation Workbench is the default landing experience (business
  // users); the original 7-step wizard is preserved byte-for-byte behind
  // view=advanced for administrators. Both read/write the SAME scope/step
  // state above, so switching views never loses a selection. A URL that
  // already names an explicit step (every pre-redesign deep link/bookmark,
  // e.g. "?...&step=5") is meaningful only to the step wizard -- honor it
  // as an implicit request for Advanced Setup even without view=advanced,
  // so existing saved links keep landing on the content they always did.
  const explicitView = searchParams.get("view");
  const workbenchView = explicitView === "advanced" ? false : explicitView === "workbench" ? true : !searchParams.has("step");
  const workbenchTab = searchParams.get("wtab") || "expenses";

  useAssistantPageContext({
    page: "CAMSetup",
    entities: {
      propertyId: propertyId || undefined,
      buildingId: buildingId || undefined,
      unitId: unitId || undefined,
      recoveryPeriodId: periodId || undefined,
    },
    selectedTab: workbenchView ? workbenchTab : `step-${step}`,
  });

  function updateParams(patch) {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === "") next.delete(k); else next.set(k, String(v));
    }
    setSearchParams(next, { replace: false });
  }
  const setPropertyId = (v) => updateParams({ property_id: v, building_id: null, unit_id: null, period_id: null, pool_id: null });
  const setBuildingId = (v) => updateParams({ building_id: v, unit_id: null });
  const setUnitId = (v) => updateParams({ unit_id: v });
  const setPeriodId = (v) => updateParams({ period_id: v });
  const setStep = (s) => updateParams({ step: s });
  const setSelectedPoolId = (v) => updateParams({ pool_id: v });
  // Always writes an explicit value (never clears to null): if the current
  // advanced view was reached implicitly via a lingering step= param (see
  // workbenchView above), clearing view alone would leave step= in place
  // and the heuristic would re-derive advanced again on the very next
  // render -- explicit view=workbench is the only way to reliably override it.
  const setWorkbenchView = (goAdvanced) => updateParams({ view: goAdvanced ? "advanced" : "workbench" });
  const setWorkbenchTab = (t) => updateParams({ wtab: t });

  // Advanced Readiness drawer (transient UI only, not persisted) — reuses
  // Step7's exact content, see READINESS PRESENTATION below.
  const [advancedReadinessOpen, setAdvancedReadinessOpen] = useState(false);

  // Dialog state (transient UI only, not persisted)
  const [calendarDialog, setCalendarDialog] = useState(false);
  const [periodDialog, setPeriodDialog] = useState(false);
  const [poolDialog, setPoolDialog] = useState(false);
  const [combineDialog, setCombineDialog] = useState(null); // array of suggestions being combined
  const [participantDialog, setParticipantDialog] = useState(false);
  const [excludeDialog, setExcludeDialog] = useState(null); // participant row
  const [expenseDialog, setExpenseDialog] = useState(null);
  const [estimateDialog, setEstimateDialog] = useState(false);
  const [adjustmentDialog, setAdjustmentDialog] = useState(null);
  const [prepareCamResult, setPrepareCamResult] = useState(null);
  const [policyConflictLeaseId, setPolicyConflictLeaseId] = useState(null);
  const [conflictReasons, setConflictReasons] = useState({});

  // ---- Data queries ---------------------------------------------------------
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: leases = [] } = useOrgQuery("Lease");
  const activeLeases = useMemo(() => filterCamActiveLeases(leases), [leases]);
  const activeLeaseIds = useMemo(() => buildCamActiveLeaseIdSet(activeLeases), [activeLeases]);
  // useOrgQuery initializes with leases=[] before its own org-scoped fetch
  // resolves. Any query that filters leases inside its OWN queryFn without
  // this value (or something derived from it) in its queryKey would run
  // once against that initial empty array, cache an empty result under a
  // key that never changes again, and silently never refetch once leases
  // actually loads -- propertyLeaseIds exists specifically so every
  // dependent query below can put it in its key instead.
  // Building-scoped: when a building is selected, only that building's
  // leases participate -- previously this stayed property-wide regardless
  // of the building selector, silently showing every building's data no
  // matter which one was picked.
  const propertyLeaseIds = useMemo(
    () => activeLeases.filter((l) => l.property_id === propertyId && (!buildingId || l.building_id === buildingId)).map((l) => l.id),
    [activeLeases, propertyId, buildingId],
  );
  const { data: categories = [] } = useExpenseCategories();
  const categoryNamesById = useMemo(() => new Map((categories || []).map((c) => [c.id, c.category_name])), [categories]);

  const { data: buildings = [] } = useQuery({
    queryKey: ["cam-setup-buildings", propertyId],
    queryFn: async () => {
      const { data, error } = await supabase.from("buildings").select("*").eq("property_id", propertyId).order("name");
      if (error) return [];
      return data || [];
    },
    enabled: Boolean(propertyId),
  });
  const { data: units = [] } = useQuery({
    queryKey: ["cam-setup-units", propertyId],
    queryFn: async () => {
      const { data, error } = await supabase.from("units").select("*").eq("property_id", propertyId).order("unit_number");
      if (error) return [];
      return data || [];
    },
    enabled: Boolean(propertyId),
  });
  const scopeUnits = useMemo(
    () => units.filter((unit) => !buildingId || unit.building_id === buildingId),
    [units, buildingId],
  );

  const { data: calendars = [], refetch: refetchCalendars } = useQuery({
    queryKey: ["recovery_calendars", propertyId],
    enabled: Boolean(propertyId),
    queryFn: async () => {
      const { data, error } = await supabase.from("recovery_calendars").select("*").eq("property_id", propertyId).order("created_at");
      if (error) return [];
      return data || [];
    },
  });
  const calendarIds = useMemo(() => calendars.map((c) => c.id), [calendars]);
  const activeCalendar = calendars[0] || null;

  const { data: periods = [], refetch: refetchPeriods } = useQuery({
    queryKey: ["recovery_periods", calendarIds.join(",")],
    enabled: calendarIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.from("recovery_periods").select("*").in("calendar_id", calendarIds).order("start_date", { ascending: false });
      if (error) return [];
      return data || [];
    },
  });
  const selectedPeriod = useMemo(() => periods.find((p) => p.id === periodId) || null, [periods, periodId]);
  const requiredFiscalYears = useMemo(() => Array.from({ length: 7 }, (_, index) => 2021 + index), []);
  const periodByFiscalYear = useMemo(() => {
    const map = new Map();
    for (const period of periods) {
      const labelYear = String(period.label || "").match(/20\d{2}/)?.[0];
      const startYear = period.start_date ? new Date(`${period.start_date}T00:00:00Z`).getUTCFullYear() : null;
      const year = Number(labelYear || startYear);
      if (Number.isFinite(year) && !map.has(year)) map.set(year, period);
    }
    return map;
  }, [periods]);
  const periodSelectOptions = useMemo(() => {
    const seen = new Set();
    const required = requiredFiscalYears.map((year) => {
      const existing = periodByFiscalYear.get(year);
      if (existing?.id) seen.add(existing.id);
      return {
        key: `fy-${year}`,
        value: existing?.id || `__create_fy_${year}`,
        label: `FY${year}`,
        existing: Boolean(existing?.id),
      };
    });
    const extra = periods
      .filter((period) => period?.id && !seen.has(period.id))
      .map((period) => ({ key: period.id, value: period.id, label: period.label || period.id, existing: true }));
    return [...required, ...extra];
  }, [periods, periodByFiscalYear, requiredFiscalYears]);

  const { data: pools = [], refetch: refetchPools } = useQuery({
    // Building-scoped: a property-wide pool still applies inside any of its
    // buildings, so a building selection narrows to "property-wide OR this
    // building's own" pools -- never an exact-match building_id filter,
    // which would wrongly hide property-wide pools while viewing a building.
    queryKey: ["recovery_pools", propertyId, periodId, buildingId],
    enabled: Boolean(propertyId) && Boolean(periodId),
    queryFn: async () => {
      let query = supabase.from("recovery_pools").select("*, recovery_pool_categories(*)").eq("property_id", propertyId).eq("period_id", periodId);
      if (buildingId) query = query.or(`scope_type.eq.property,and(scope_type.eq.building,scope_id.eq.${buildingId})`);
      const { data, error } = await query.order("name");
      if (error) return [];
      return data || [];
    },
  });
  const alreadyCoveredCategoryIds = useMemo(() => {
    const set = new Set();
    for (const pool of pools) for (const cat of (pool.recovery_pool_categories || [])) if (cat.inclusion_mode === "include") set.add(cat.expense_category_id);
    return set;
  }, [pools]);
  const selectedPool = useMemo(() => pools.find((p) => p.id === selectedPoolId) || null, [pools, selectedPoolId]);
  const selectedPoolCategoryIds = useMemo(() => new Set((selectedPool?.recovery_pool_categories || []).filter((c) => c.inclusion_mode === "include").map((c) => c.expense_category_id)), [selectedPool]);

  const { data: participants = [], refetch: refetchParticipants } = useQuery({
    queryKey: ["pool_participants", selectedPoolId, propertyLeaseIds.join(",")],
    enabled: Boolean(selectedPoolId),
    queryFn: async () => {
      const { data, error } = await supabase.from("recovery_pool_lease_participants").select("*, leases(tenant_name)").eq("pool_id", selectedPoolId).order("created_at");
      if (error) return [];
      return filterRowsToCamActiveLeases(data || [], activeLeaseIds);
    },
  });

  // Active participant count per pool for ALL pools in scope at once (Step3's
  // own `participants` query above is intentionally scoped to one selected
  // pool only) -- needed for the Pool Calculation tab's "Participants"
  // column (spec section C) without re-querying per row.
  const { data: participantCountsByPoolId = new Map() } = useQuery({
    queryKey: ["pool_participant_counts", pools.map((p) => p.id).join(","), propertyLeaseIds.join(",")],
    enabled: pools.length > 0,
    queryFn: async () => {
      const poolIds = pools.map((p) => p.id);
      const { data, error } = await supabase.from("recovery_pool_lease_participants").select("pool_id, lease_id").in("pool_id", poolIds).eq("status", "active");
      if (error) return new Map();
      const counts = new Map();
      for (const row of filterRowsToCamActiveLeases(data || [], activeLeaseIds)) counts.set(row.pool_id, (counts.get(row.pool_id) || 0) + 1);
      return counts;
    },
  });

  const { data: leasePremises = [] } = useQuery({
    queryKey: ["cam-setup-lease-premises", propertyLeaseIds.join(",")],
    enabled: propertyLeaseIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("lease_premises")
        .select("*, lease_premises_spaces(*), lease_premises_area_periods(*)")
        .in("lease_id", propertyLeaseIds)
        .neq("status", "superseded");
      if (error) return [];
      return data || [];
    },
  });

  const { data: policies = [] } = useQuery({
    queryKey: ["lease_recovery_policies", propertyLeaseIds.join(",")],
    enabled: propertyLeaseIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("lease_recovery_policies")
        .select("*, leases(tenant_name), lease_recovery_policy_steps(*)")
        .in("lease_id", propertyLeaseIds)
        .neq("status", "superseded")
        .order("created_at");
      if (error) return [];
      return data || [];
    },
  });
  const approvedPolicySteps = useMemo(() => {
    const rows = [];
    for (const pol of policies) {
      if (pol.status !== "approved") continue;
      for (const step of (pol.lease_recovery_policy_steps || [])) rows.push({ ...step, lease_id: pol.lease_id, policy_id: pol.id });
    }
    return rows;
  }, [policies]);

  // Mirrors evaluate_cam_readiness's POLICY_CONFLICT rule (two active
  // policies, same lease, same expense category, overlapping effective
  // window) so the "Resolve" action in Step 7 offers exactly the pair the
  // readiness exception is about -- never an open-ended pick-any-policy list.
  const policyConflictsByLeaseId = useMemo(() => {
    const overlaps = (aFrom, aTo, bFrom, bTo) => aFrom <= (bTo || "9999-12-31") && bFrom <= (aTo || "9999-12-31");
    const active = policies.filter((p) => p.status !== "superseded");
    const byLease = new Map();
    for (const p of active) {
      if (!byLease.has(p.lease_id)) byLease.set(p.lease_id, []);
      byLease.get(p.lease_id).push(p);
    }
    const result = new Map();
    for (const [leaseId, leasePolicies] of byLease.entries()) {
      if (leasePolicies.length < 2) continue;
      const pairs = [];
      for (let i = 0; i < leasePolicies.length; i += 1) {
        for (let j = i + 1; j < leasePolicies.length; j += 1) {
          const a = leasePolicies[i]; const b = leasePolicies[j];
          const aCats = new Set((a.lease_recovery_policy_steps || []).map((s) => s.expense_category_id).filter(Boolean));
          const bCats = new Set((b.lease_recovery_policy_steps || []).map((s) => s.expense_category_id).filter(Boolean));
          const sharedCategory = [...aCats].some((c) => bCats.has(c));
          if (sharedCategory && overlaps(a.effective_from, a.effective_to, b.effective_from, b.effective_to)) pairs.push([a, b]);
        }
      }
      if (pairs.length > 0) result.set(leaseId, pairs);
    }
    return result;
  }, [policies]);

  const { data: priorAdjustments = [], refetch: refetchPriorAdj } = useQuery({
    // Building-scoped, same reasoning as estimateSchedules below.
    queryKey: ["cam_prior_period_adjustments", periodId, propertyLeaseIds.join(",")],
    enabled: Boolean(periodId),
    queryFn: async () => {
      let query = supabase.from("cam_prior_period_adjustments").select("*, leases(tenant_name)").eq("recovery_period_id", periodId);
      query = query.in("lease_id", propertyLeaseIds.length > 0 ? propertyLeaseIds : ["00000000-0000-0000-0000-000000000000"]);
      const { data, error } = await query;
      if (error) return [];
      return data || [];
    },
  });

  const { data: publishedExpenses = [] } = useQuery({
    // periodId + selectedPeriod's own start/end are in the key (not just
    // closed over) so a period switch always refetches/refilters instead of
    // reusing a cached result scoped to the previous period -- the exact
    // "prior-year published amounts appearing in this year" bug this fixes
    // was caused by this query filtering on property_id only, with no
    // period or fiscal_year predicate at all.
    // Building-scoped: an expense with building_id=null is property-wide
    // (applies inside any building), so a building selection narrows to
    // "property-wide OR this building's own" -- an exact-match filter would
    // wrongly hide legitimate property-wide expenses while viewing a building.
    queryKey: ["cam_expense_inputs_published", propertyId, periodId, buildingId, selectedPeriod?.start_date, selectedPeriod?.end_date],
    enabled: Boolean(propertyId) && Boolean(periodId) && Boolean(selectedPeriod),
    queryFn: async () => {
      let query = supabase
        .from("cam_expense_inputs")
        .select("*, cam_input_pool_assignments(*, recovery_pools(name))")
        .eq("property_id", propertyId)
        .eq("publication_status", "published");
      if (buildingId) query = query.or(`building_id.is.null,building_id.eq.${buildingId}`);
      const { data, error } = await query.order("created_at");
      if (error) return [];
      const periodStart = selectedPeriod.start_date;
      const periodEnd = selectedPeriod.end_date;
      const periodYear = periodStart ? new Date(`${periodStart}T00:00:00Z`).getUTCFullYear() : null;
      const inPeriod = (exp) => {
        if (exp.service_period_start && exp.service_period_end) {
          return exp.service_period_start <= periodEnd && exp.service_period_end >= periodStart;
        }
        if (exp.fiscal_year != null && periodYear != null) return Number(exp.fiscal_year) === periodYear;
        return false; // no period-identifying data -- excluded rather than guessed
      };
      const rows = (data || []).filter(inPeriod);
      // Enrich with vendor/description (from the source Expense record) and
      // recoverability (from the classification record) -- two separate
      // best-effort lookups since actual_expense_id / classification_result_id
      // are not real FKs PostgREST can embed automatically.
      const expenseIds = [...new Set(rows.map((r) => r.actual_expense_id).filter(Boolean))];
      const classificationIds = [...new Set(rows.map((r) => r.classification_result_id).filter(Boolean))];
      const [expensesRes, classificationsRes] = await Promise.all([
        expenseIds.length ? supabase.from("expenses").select("id, vendor, vendor_name, description, invoice_number").in("id", expenseIds) : Promise.resolve({ data: [] }),
        classificationIds.length ? supabase.from("expense_classifications").select("id, recovery_status, recoverability_result").in("id", classificationIds) : Promise.resolve({ data: [] }),
      ]);
      const expenseById = new Map((expensesRes.data || []).map((e) => [e.id, e]));
      const classificationById = new Map((classificationsRes.data || []).map((c) => [c.id, c]));
      return rows.map((r) => ({
        ...r,
        _sourceExpense: r.actual_expense_id ? expenseById.get(r.actual_expense_id) : null,
        _classification: r.classification_result_id ? classificationById.get(r.classification_result_id) : null,
      }));
    },
  });

  // Business rule: an expense only ever reaches cam_expense_inputs once its
  // classification's cam_eligible = 'yes' (enforced by
  // send_expense_classification_to_cam_workflow / publish_cam_expense_input
  // RPCs) -- so publishedExpenses above can never legitimately contain a
  // truly non-eligible row. The real "not eligible, stays in the Expense
  // module" set lives one step upstream, in expense_classifications rows
  // that were never sent to CAM at all. Queried separately, read-only, for
  // the CAM Expenses tab's optional excluded-source audit drawer only.
  const { data: excludedClassifications = [] } = useQuery({
    queryKey: ["cam_excluded_classifications", propertyId],
    enabled: Boolean(propertyId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expense_classifications")
        .select("id, expense_id, recovery_status, recoverability_result, cam_eligible, classification_status")
        .eq("property_id", propertyId)
        .neq("cam_eligible", "yes")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) return [];
      const expenseIds = [...new Set(data.map((c) => c.expense_id).filter(Boolean))];
      const { data: expenses } = expenseIds.length
        ? await supabase.from("expenses").select("id, vendor, vendor_name, description, amount").in("id", expenseIds)
        : { data: [] };
      const expenseById = new Map((expenses || []).map((e) => [e.id, e]));
      return data.map((c) => ({ ...c, _sourceExpense: c.expense_id ? expenseById.get(c.expense_id) : null }));
    },
  });

  const { data: estimateSchedules = [], refetch: refetchEstimates } = useQuery({
    // Building-scoped via propertyLeaseIds (already building-aware above).
    // recovery_period_id alone already can't leak cross-property (a period
    // belongs to one calendar, which belongs to one property), but it says
    // nothing about building -- without this, every building's estimates
    // showed regardless of the building selector.
    queryKey: ["cam_estimate_schedules", periodId, propertyLeaseIds.join(",")],
    enabled: Boolean(periodId),
    queryFn: async () => {
      let query = supabase.from("cam_estimate_schedules").select("*, leases(tenant_name)").eq("recovery_period_id", periodId);
      query = query.in("lease_id", propertyLeaseIds.length > 0 ? propertyLeaseIds : ["00000000-0000-0000-0000-000000000000"]);
      const { data, error } = await query.order("month_date");
      if (error) return [];
      return data || [];
    },
  });

  const { data: readinessRaw, isLoading: readinessLoading, refetch: refetchReadiness } = useQuery({
    // Building-scoped: get-cam-setup-readiness already accepts scope_type/
    // scope_id (confirmed in its own contract) -- previously never passed,
    // so readiness was always evaluated property-wide even while a building
    // was selected.
    queryKey: ["cam_readiness", propertyId, periodId, buildingId],
    enabled: Boolean(propertyId) && Boolean(periodId),
    queryFn: () => invokeEdgeFunction("get-cam-setup-readiness", {
      property_id: propertyId, recovery_period_id: periodId,
      scope_type: buildingId ? "building" : "property", scope_id: buildingId || propertyId,
    }),
  });
  const readiness = useMemo(() => {
    if (!readinessRaw) return { ready: false, blockingCount: 0, warningCount: 0, items: [] };
    const engine = normalizeReadiness(readinessRaw.readiness);
    const supplementary = computeExpenseGapExceptions(publishedExpenses);
    return mergeReadiness(engine, supplementary);
  }, [readinessRaw, publishedExpenses]);

  // ---- Workbench sections E/F/G/H: the SAME cam_runs / cam_run_pool_results /
  // cam_run_lease_results tables and the SAME run-cam-calculation-v2 edge
  // function CAMRun.jsx already uses — read/queried again here (distinct
  // query keys, same shapes) so "Calculate CAM Preview" and its results can
  // live on this page without touching CAMRun.jsx, which remains the
  // separate, deeper operational page (submit/approve/post/statements).
  const { data: workbenchRuns = [], refetch: refetchWorkbenchRuns } = useQuery({
    queryKey: ["cam-workbench-run-list", propertyId, periodId, buildingId],
    enabled: Boolean(propertyId) && Boolean(periodId),
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_runs").select("*").eq("scope_id", buildingId || propertyId).eq("recovery_period_id", periodId).order("created_at", { ascending: false });
      if (error) return [];
      return data || [];
    },
  });
  const activeRun = workbenchRuns.find((r) => r.status !== "voided" && r.status !== "superseded") || workbenchRuns[0] || null;

  const { data: poolResults = [] } = useQuery({
    queryKey: ["cam-workbench-pool-results", activeRun?.id],
    enabled: Boolean(activeRun?.id),
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_run_pool_results").select("*, recovery_pools(name)").eq("cam_run_id", activeRun.id);
      if (error) return [];
      return data || [];
    },
  });

  const { data: leaseResults = [] } = useQuery({
    queryKey: ["cam-workbench-lease-results", activeRun?.id, propertyLeaseIds.join(",")],
    enabled: Boolean(activeRun?.id),
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_run_lease_results").select("*, leases(tenant_name)").eq("cam_run_id", activeRun.id);
      if (error) return [];
      return filterRowsToCamActiveLeases(data || [], activeLeaseIds);
    },
  });

  const { data: runExceptions = [] } = useQuery({
    queryKey: ["cam-workbench-exceptions", activeRun?.id],
    enabled: Boolean(activeRun?.id),
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_run_exceptions").select("*").eq("cam_run_id", activeRun.id);
      if (error) return [];
      return data || [];
    },
  });

  // Identical call shape to CAMRun.jsx's calculateMutation — same edge
  // function, same payload, same persisted cam_runs record. Always runs in
  // posting_eligible mode here (full validation) since the Workbench's
  // "Calculate CAM Preview" button is meant to show the real, authoritative
  // preview a reviewer would act on, not a relaxed draft simulation.
  const calculateMutation = useMutation({
    mutationFn: async () => {
      try {
        await invokeEdgeFunction("prepare-cam-automatically-v2", {
          property_id: propertyId,
          recovery_period_id: periodId,
        });
      } catch (error) {
        console.warn("[CAMSetup] prepare-cam-automatically-v2 preflight failed:", error?.message || error);
      }
      return invokeEdgeFunction("run-cam-calculation-v2", {
        property_id: propertyId, recovery_period_id: periodId,
        scope_type: buildingId ? "building" : "property", scope_id: buildingId || propertyId,
        run_type: "standard", run_mode: "posting_eligible",
      });
    },
    onSuccess: (result) => {
      if (result?.status === "readiness_failed") {
        toast.warning("Readiness check failed — see Advanced Readiness for details.");
      } else {
        toast.success(result?.idempotent_rerun ? "Up to date — no changes since last calculation." : "CAM preview calculated.");
      }
      refetchWorkbenchRuns();
      queryClient.invalidateQueries({ queryKey: ["cam-workbench-pool-results"] });
      queryClient.invalidateQueries({ queryKey: ["cam-workbench-lease-results"] });
      queryClient.invalidateQueries({ queryKey: ["cam-workbench-exceptions"] });
      setWorkbenchTab("results");
    },
    onError: (err) => toast.error(err?.message || "Calculation failed"),
  });

  // ---- Mutation dispatcher ----------------------------------------------------
  const mutation = useMutation({
    mutationFn: ({ action, payload }) => camSetupAction(action, payload),
    onSuccess: (_, { invalidate }) => { if (invalidate) invalidate.forEach((k) => queryClient.invalidateQueries({ queryKey: k })); },
    onError: (err) => toast.error(err.message || "Action failed"),
  });
  const doAction = (action, payload, invalidateKeys, successMsg) =>
    mutation.mutateAsync({ action, payload, invalidate: invalidateKeys }, { onSuccess: () => toast.success(successMsg ?? "Saved") });
  const selectRecoveryPeriod = async (value) => {
    if (!String(value || "").startsWith("__create_fy_")) {
      setPeriodId(value);
      return;
    }
    const year = Number(String(value).replace("__create_fy_", ""));
    if (!activeCalendar?.id || !Number.isFinite(year)) {
      toast.error("Set up a recovery calendar before creating fiscal periods.");
      return;
    }
    const created = await doAction(
      "create_recovery_period",
      { calendar_id: activeCalendar.id, start_date: `${year}-01-01`, end_date: `${year}-12-31`, label: `FY${year}` },
      [["recovery_periods", calendarIds.join(",")], ["recovery_periods"]],
      `FY${year} recovery period created`,
    );
    refetchPeriods();
    const createdId = created?.period?.id || created?.id || null;
    if (createdId) setPeriodId(createdId);
  };

  // "Prepare CAM Automatically" -- a separate controlled backend command
  // (prepare-cam-automatically-v2), not a cam-setup-actions-v2 action, since
  // it orchestrates multiple existing RPCs (backfill, materialize,
  // readiness) rather than performing one CRUD write. Idempotent: safe to
  // rerun for the same property+period.
  const prepareCamMutation = useMutation({
    mutationFn: () => invokeEdgeFunction("prepare-cam-automatically-v2", { property_id: propertyId, recovery_period_id: periodId }),
    onSuccess: (result) => {
      setPrepareCamResult(result);
      [
        ["lease_recovery_policies", propertyLeaseIds.join(",")],
        ["cam-setup-lease-premises", propertyLeaseIds.join(",")],
        ["cam_expense_inputs_published", propertyId, periodId, selectedPeriod?.start_date, selectedPeriod?.end_date],
        ["recovery_pools", propertyId, periodId],
        ["cam_readiness", propertyId, periodId],
      ].forEach((k) => queryClient.invalidateQueries({ queryKey: k }));
      toast.success("Re-Sync Source Data finished — review suggestions below");
    },
    onError: (err) => toast.error(err.message || "Re-Sync Source Data failed"),
  });

  const resetAndReimportMutation = useMutation({
    mutationFn: async () => {
      if (!propertyId || !periodId) throw new Error("Select a property and recovery period first.");

      // 1. Clear existing pools and child assignments for this property/period
      const { data: poolsToDelete } = await supabase
        .from("recovery_pools")
        .select("id")
        .eq("property_id", propertyId)
        .eq("period_id", periodId);

      const poolIds = (poolsToDelete || []).map((p) => p.id);

      if (poolIds.length > 0) {
        await supabase.from("cam_expense_pool_assignments").delete().in("pool_id", poolIds);
        await supabase.from("recovery_pool_lease_participants").delete().in("pool_id", poolIds);
        await supabase.from("recovery_pool_scope_members").delete().in("pool_id", poolIds);
        await supabase.from("recovery_pool_categories").delete().in("pool_id", poolIds);
        await supabase.from("recovery_pools").delete().in("id", poolIds);
      }

      // 2. Resolve duplicate lease policy conflicts for this property by marking older duplicate policy rows as superseded
      const { data: propertyLeases } = await supabase
        .from("leases")
        .select("id")
        .eq("property_id", propertyId);

      const pLeaseIds = (propertyLeases || []).map((l) => l.id);
      if (pLeaseIds.length > 0) {
        const { data: duplicatePolicies } = await supabase
          .from("lease_recovery_policies")
          .select("id, lease_id, created_at")
          .in("lease_id", pLeaseIds)
          .neq("status", "superseded");

        const polsByLease = new Map();
        for (const pol of duplicatePolicies || []) {
          if (!polsByLease.has(pol.lease_id)) polsByLease.set(pol.lease_id, []);
          polsByLease.get(pol.lease_id).push(pol);
        }
        for (const [_, pols] of polsByLease.entries()) {
          if (pols.length > 1) {
            pols.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            const olderIds = pols.slice(1).map((p) => p.id);
            if (olderIds.length > 0) {
              await supabase.from("lease_recovery_policies").update({ status: "superseded" }).in("id", olderIds);
            }
          }
        }
      }

      // 3. Invoke prepare-cam-automatically-v2 to re-import fresh source data from upstream modules
      const result = await invokeEdgeFunction("prepare-cam-automatically-v2", {
        property_id: propertyId,
        recovery_period_id: periodId,
      });

      // 4. Auto-confirm suggested pools into recovery_pools so pools are created immediately
      const suggestedPoolsList = result?.suggested?.pools || [];
      for (const sugg of suggestedPoolsList) {
        if (!sugg.expense_category_id) continue;
        const poolName = sugg.category_name
          ? suggestedPoolNameForCategory(sugg.category_name)
          : suggestedPoolNameForCategory(sugg.expense_category_id);

        const created = await camSetupAction("create_recovery_pool", {
          property_id: propertyId,
          period_id: periodId,
          name: poolName,
          pool_type: buildingId ? "building" : "property",
          scope_type: buildingId ? "building" : "property",
          scope_id: buildingId || propertyId,
        });

        if (created?.pool?.id) {
          await camSetupAction("assign_pool_category", {
            pool_id: created.pool.id,
            expense_category_id: sugg.expense_category_id,
          });
        }
      }

      return result;
    },
    onSuccess: (result) => {
      setPrepareCamResult(result);
      [
        ["lease_recovery_policies", propertyLeaseIds.join(",")],
        ["cam-setup-lease-premises", propertyLeaseIds.join(",")],
        ["cam_expense_inputs_published", propertyId, periodId, selectedPeriod?.start_date, selectedPeriod?.end_date],
        ["recovery_pools", propertyId, periodId],
        ["cam_readiness", propertyId, periodId],
      ].forEach((k) => queryClient.invalidateQueries({ queryKey: k }));
      toast.success("CAM data reset & fresh source data re-imported successfully!");
    },
    onError: (err) => toast.error(err.message || "Reset & Re-Import failed"),
  });

  // Item G: controlled, versioned override for a POLICY_CONFLICT readiness
  // exception. Only ever supersedes one of the two policies the readiness
  // engine itself identified as conflicting (policyConflictsByLeaseId) --
  // never an open pick-any-policy list -- and always requires a reason.
  const resolveConflictMutation = useMutation({
    mutationFn: ({ policyId, reason }) => camSetupAction("resolve_policy_conflict", { policy_id_to_supersede: policyId, reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lease_recovery_policies", propertyLeaseIds.join(",")] });
      queryClient.invalidateQueries({ queryKey: ["cam_readiness", propertyId, periodId] });
      setPolicyConflictLeaseId(null);
      toast.success("Conflict resolved");
    },
    onError: (err) => toast.error(err.message || "Could not resolve conflict"),
  });

  // ---- Requirement 2: source-data summary ------------------------------------
  const summary = useMemo(() => {
    // Reuses propertyLeaseIds (already building-aware, see its definition
    // near the top of the component) rather than re-deriving property-only
    // -- otherwise a lease correctly excluded from `policies`/`estimateSchedules`
    // by the building filter still shows up here, e.g. as a false "missing
    // policy" for a lease that simply belongs to a different building.
    const propLeases = activeLeases.filter((l) => propertyLeaseIds.includes(l.id));
    const approvedLeases = propLeases.filter((l) => policies.some((p) => p.lease_id === l.id && p.status === "approved"));
    const leasesWithApprovedRules = new Set(policies.filter((p) => p.status === "approved").map((p) => p.lease_id)).size;
    const materializedPolicies = policies.length;
    const leasesMissingPolicy = propLeases.filter((l) => !policies.some((p) => p.lease_id === l.id)).length;
    const finalizedExpenses = publishedExpenses.length;
    const publishedTotal = publishedExpenses.reduce((s, e) => s + Number(e.amount || 0), 0);
    const unassigned = publishedExpenses.filter((e) => (e.cam_input_pool_assignments || []).length === 0).length;
    const missingArea = leasePremises.filter((p) => !(p.lease_premises_area_periods || []).length).length;
    return {
      approvedLeaseCount: approvedLeases.length,
      leasesWithApprovedRules,
      materializedPolicies,
      leasesMissingPolicy,
      finalizedExpenses,
      publishedTotal,
      unassigned,
      estimateCount: estimateSchedules.length,
      missingArea,
      blockingCount: readiness.blockingCount,
    };
  }, [leases, propertyId, policies, publishedExpenses, leasePremises, estimateSchedules, readiness]);

  // ---- Requirement 1: per-step "can proceed" gating --------------------------
  const stepReady = {
    1: Boolean(propertyId) && Boolean(periodId),
    2: Boolean(propertyId) && Boolean(periodId),
    3: Boolean(propertyId) && Boolean(periodId) && pools.length > 0,
    4: Boolean(propertyId) && Boolean(periodId),
    5: Boolean(propertyId) && Boolean(periodId),
    6: Boolean(propertyId) && Boolean(periodId),
    7: Boolean(propertyId) && Boolean(periodId),
  };
  const canProceed = step < 7 && stepReady[step];
  const canGoBack = step > 1;

  // ============================================================================
  // Step 1 — Property / Period
  // ============================================================================
  function Step1() {
    const [calForm, setCalForm] = useState({ name: "Standard Calendar", calendar_type: "calendar_year", fiscal_start_month: 1 });
    const [periodForm, setPeriodForm] = useState({ start_date: "", end_date: "", label: "" });
    const [calendarIdForPeriod, setCalendarIdForPeriod] = useState("");

    const suggestion = activeCalendar ? suggestedPeriodForCalendar(activeCalendar) : null;
    const alreadyHasCurrentPeriod = suggestion && periods.some((p) => p.start_date === suggestion.start_date && p.end_date === suggestion.end_date);

    React.useEffect(() => {
      if (!propertyId && properties.length > 0) {
        setPropertyId(properties[0].id);
      }
    }, [properties]);

    React.useEffect(() => {
      if (propertyId && !periodId && periods.length > 0) {
        setPeriodId(periods[0].id);
      }
    }, [propertyId, periods]);

    return (
      <div className="space-y-6">
        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base font-semibold">Select Property</CardTitle>
            {properties.length > 0 && (
              <Badge variant="outline" className="text-xs font-normal">
                {properties.length} propert{properties.length === 1 ? "y" : "ies"} available
              </Badge>
            )}
          </CardHeader>
          <CardContent>
            {properties.length === 0 ? (
              <p className="text-sm text-slate-500">No properties found in this organization. Create a property first to set up CAM.</p>
            ) : (
              <ScopeSelector
                portfolios={portfolios}
                properties={properties}
                buildings={buildings}
                units={scopeUnits}
                selectedProperty={propertyId || "all"}
                selectedBuilding={buildingId || "all"}
                selectedUnit={unitId || "all"}
                onPropertyChange={(value) => setPropertyId(value === "all" ? "" : value)}
                onBuildingChange={(value) => setBuildingId(value === "all" ? "" : value)}
                onUnitChange={(value) => setUnitId(value === "all" ? "" : value)}
                syncToUrl
                queryParamNames={{ portfolio: "portfolio_id", property: "property_id", building: "building_id", unit: "unit_id" }}
              />
            )}
          </CardContent>
        </Card>

        {propertyId && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Recovery Calendar</CardTitle>
              {calendars.length === 0 && (
                <Button size="sm" id="btn-create-calendar" onClick={() => setCalendarDialog(true)}>
                  <Plus className="w-3 h-3 mr-1" /> Set Up Calendar
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {calendars.length === 0 ? (
                <p className="text-sm text-slate-500">No recovery calendar yet for this property. Most properties use a standard Calendar Year.</p>
              ) : (
                <div className="flex items-center gap-3 text-sm">
                  <span className="font-medium">{activeCalendar.name}</span>
                  <Badge className="text-[10px]">{calendarTypeLabel(activeCalendar.calendar_type)}</Badge>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Requirement 3: automatic recovery period suggestion */}
        {calendars.length > 0 && suggestion && !alreadyHasCurrentPeriod && (
          <Card className="border-blue-300 bg-blue-50">
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Sparkles className="w-5 h-5 text-blue-600 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-blue-900">Suggested recovery period: {suggestion.displayText}</p>
                  <p className="text-xs text-blue-700">Based on {activeCalendar.name}'s {calendarTypeLabel(activeCalendar.calendar_type).toLowerCase()} schedule.</p>
                </div>
              </div>
              <Button
                id="btn-confirm-suggested-period"
                onClick={async () => {
                  const created = await doAction("create_recovery_period", { calendar_id: activeCalendar.id, start_date: suggestion.start_date, end_date: suggestion.end_date, label: suggestion.label }, [["recovery_periods"]], "Recovery period created");
                  refetchPeriods();
                  if (created?.period?.id) setPeriodId(created.period.id);
                }}
              >
                Confirm
              </Button>
            </CardContent>
          </Card>
        )}

        {calendars.length > 0 && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Recovery Periods</CardTitle>
              <Button size="sm" variant="outline" id="btn-create-period" onClick={() => { setCalendarIdForPeriod(activeCalendar.id); setPeriodDialog(true); }}>
                <Plus className="w-3 h-3 mr-1" /> Custom Period (Nonstandard Fiscal Year)
              </Button>
            </CardHeader>
            <CardContent>
              {periods.length === 0 ? <p className="text-sm text-slate-500">No periods yet.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Label</TableHead><TableHead>Window</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>
                    {periods.map((p) => (
                      <TableRow key={p.id} className={periodId === p.id ? "bg-blue-50" : ""}>
                        <TableCell className="font-medium">{p.label}</TableCell>
                        <TableCell>{p.start_date} → {p.end_date}</TableCell>
                        <TableCell><Badge className="text-[10px]">{p.status}</Badge></TableCell>
                        <TableCell>
                          <Button size="sm" variant={periodId === p.id ? "default" : "outline"} id={`btn-select-period-${p.id}`} onClick={() => setPeriodId(p.id)}>
                            {periodId === p.id ? "Selected" : "Select"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}

        {propertyId && periodId && (
          <Card className="border-blue-200 bg-blue-50/40">
            <CardContent className="pt-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-slate-900 flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-blue-600" /> Prepare CAM Automatically</p>
                <p className="text-xs text-slate-600 mt-0.5">
                  Loads approved leases, premises, policies and published expenses for this property and period, then suggests pools, participants and expense assignments to review below. Nothing is finalized without your confirmation. Safe to run more than once.
                </p>
              </div>
              <Button
                id="btn-prepare-cam-automatically"
                onClick={() => prepareCamMutation.mutate()}
                disabled={prepareCamMutation.isPending}
              >
                {prepareCamMutation.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1.5" />}
                Prepare CAM Automatically
              </Button>
            </CardContent>
          </Card>
        )}

        {propertyId && periodId && <SourceDataSummaryCard />}

        <Dialog open={calendarDialog} onOpenChange={setCalendarDialog}>
          <DialogContent>
            <DialogHeader><DialogTitle>Set Up Recovery Calendar</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Name</Label><Input id="cal-name" value={calForm.name} onChange={(e) => setCalForm({ ...calForm, name: e.target.value })} /></div>
              <div><Label>Calendar Type</Label>
                <Select value={calForm.calendar_type} onValueChange={(v) => setCalForm({ ...calForm, calendar_type: v })}>
                  <SelectTrigger id="cal-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="calendar_year">{calendarTypeLabel("calendar_year")}</SelectItem>
                    <SelectItem value="fiscal_year">{calendarTypeLabel("fiscal_year")}</SelectItem>
                    <SelectItem value="lease_year">{calendarTypeLabel("lease_year")}</SelectItem>
                    <SelectItem value="custom">{calendarTypeLabel("custom")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div><Label>Fiscal Start Month (1 = January)</Label>
                <Input id="cal-start-month" type="number" min={1} max={12} value={calForm.fiscal_start_month} onChange={(e) => setCalForm({ ...calForm, fiscal_start_month: Number(e.target.value) })} /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCalendarDialog(false)}>Cancel</Button>
              <Button id="btn-save-calendar" onClick={async () => {
                await doAction("create_recovery_calendar", { property_id: propertyId, ...calForm }, [["recovery_calendars", propertyId]], "Calendar created");
                setCalendarDialog(false);
                refetchCalendars();
              }}>Create Calendar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={periodDialog} onOpenChange={setPeriodDialog}>
          <DialogContent>
            <DialogHeader><DialogTitle>Create Custom Recovery Period</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Label (e.g. FY2026)</Label><Input id="period-label" value={periodForm.label} onChange={(e) => setPeriodForm({ ...periodForm, label: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Start Date</Label><Input id="period-start" type="date" value={periodForm.start_date} onChange={(e) => setPeriodForm({ ...periodForm, start_date: e.target.value })} /></div>
                <div><Label>End Date</Label><Input id="period-end" type="date" value={periodForm.end_date} onChange={(e) => setPeriodForm({ ...periodForm, end_date: e.target.value })} /></div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPeriodDialog(false)}>Cancel</Button>
              <Button id="btn-save-period" onClick={async () => {
                const created = await doAction("create_recovery_period", { calendar_id: calendarIdForPeriod, ...periodForm }, [["recovery_periods"]], "Period created");
                setPeriodDialog(false);
                refetchPeriods();
                if (created?.period?.id) setPeriodId(created.period.id);
              }}>Create Period</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

      </div>
    );
  }

  // ---- Requirement 2: Source-Data Summary (clickable) ------------------------
  function SourceDataSummaryCard() {
    const stats = [
      { label: "Approved leases", value: summary.approvedLeaseCount, onClick: () => setStep(4) },
      { label: "Leases with approved recovery rules", value: summary.leasesWithApprovedRules, onClick: () => setStep(4) },
      { label: "Materialized policies", value: summary.materializedPolicies, onClick: () => setStep(4) },
      { label: "Leases missing policy information", value: summary.leasesMissingPolicy, warn: summary.leasesMissingPolicy > 0, onClick: () => setStep(4) },
      { label: "Finalized CAM-eligible expenses", value: summary.finalizedExpenses, onClick: () => setStep(5) },
      { label: "Published expense total", value: fmtCurrency(summary.publishedTotal), onClick: () => setStep(5) },
      { label: "Expenses awaiting pool assignment", value: summary.unassigned, warn: summary.unassigned > 0, onClick: () => setStep(5) },
      { label: "Existing estimate schedules", value: summary.estimateCount, onClick: () => setStep(6) },
      { label: "Missing area/occupancy records", value: summary.missingArea, warn: summary.missingArea > 0, onClick: () => setStep(4) },
      { label: "Readiness blocking count", value: summary.blockingCount, warn: summary.blockingCount > 0, onClick: () => setStep(7) },
    ];
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Source-Data Summary</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {stats.map((s, i) => (
              <button
                key={i}
                id={`summary-stat-${i}`}
                onClick={s.onClick}
                className={`text-left rounded-lg border p-3 hover:border-blue-400 transition-colors ${s.warn ? "border-amber-300 bg-amber-50" : "border-slate-200"}`}
              >
                <div className={`text-lg font-semibold ${s.warn ? "text-amber-700" : "text-slate-800"}`}>{s.value}</div>
                <div className="text-[11px] text-slate-500 leading-tight">{s.label}</div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  // ============================================================================
  // Step 2 — Pools (Requirement 4: automatic suggestions)
  // ============================================================================
  function Step2() {
    const [poolForm, setPoolForm] = useState({ name: "", pool_type: buildingId ? "building" : "property", scope_type: buildingId ? "building" : "property" });
    const [combineChecked, setCombineChecked] = useState({});
    const [combineName, setCombineName] = useState("");

    const suggestions = useMemo(
      () => suggestPools(approvedPolicySteps, publishedExpenses, categoryNamesById, alreadyCoveredCategoryIds),
      [approvedPolicySteps, publishedExpenses, categoryNamesById, alreadyCoveredCategoryIds],
    );

    async function confirmSuggestion(sugg, nameOverride) {
      const created = await doAction("create_recovery_pool", {
        property_id: propertyId, period_id: periodId, name: nameOverride || sugg.suggested_pool_name,
        pool_type: buildingId ? "building" : "property", scope_type: buildingId ? "building" : "property", scope_id: buildingId || propertyId,
      }, [["recovery_pools", propertyId, periodId]], "Pool created");
      if (created?.pool?.id) {
        await doAction("assign_pool_category", { pool_id: created.pool.id, expense_category_id: sugg.expense_category_id }, [["recovery_pools", propertyId, periodId]], "Category assigned");
      }
      refetchPools();
    }

    const checkedSuggestions = suggestions.filter((s) => combineChecked[s.expense_category_id]);

    return (
      <div className="space-y-6">
        <Card className="border-blue-200">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><Sparkles className="w-4 h-4 text-blue-600" /> Suggested Recovery Pools</CardTitle>
            <p className="text-xs text-slate-500 font-normal">Derived from approved lease recovery policies and finalized published expenses. Confirm, rename, combine, or remove — nothing is created until you confirm.</p>
          </CardHeader>
          <CardContent>
            {suggestions.length === 0 ? (
              <p className="text-sm text-slate-500">No new pool suggestions — either every category is already covered, or no approved policies/published expenses exist yet for this property.</p>
            ) : (
              <div className="space-y-2">
                {suggestions.map((s) => (
                  <div key={s.expense_category_id} className="flex items-center gap-3 rounded-lg border p-3">
                    <Checkbox
                      id={`combine-check-${s.expense_category_id}`}
                      checked={Boolean(combineChecked[s.expense_category_id])}
                      onCheckedChange={(v) => setCombineChecked((c) => ({ ...c, [s.expense_category_id]: Boolean(v) }))}
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium">{s.suggested_pool_name}</p>
                      <p className="text-xs text-slate-500">
                        {s.policy_lease_count} lease{s.policy_lease_count === 1 ? "" : "s"} with approved policy · {s.expense_count} expense line{s.expense_count === 1 ? "" : "s"} · {fmtCurrency(s.expense_total)} total
                      </p>
                    </div>
                    <Button size="sm" variant="outline" id={`btn-rename-suggestion-${s.expense_category_id}`} onClick={() => {
                      const name = window.prompt("Pool name", s.suggested_pool_name);
                      if (name) confirmSuggestion(s, name);
                    }}>Rename &amp; Confirm</Button>
                    <Button size="sm" id={`btn-confirm-suggestion-${s.expense_category_id}`} onClick={() => confirmSuggestion(s)}>Confirm</Button>
                  </div>
                ))}
                {checkedSuggestions.length > 1 && (
                  <div className="flex items-center gap-2 rounded-lg border border-blue-300 bg-blue-50 p-3">
                    <Combine className="w-4 h-4 text-blue-600" />
                    <Input placeholder="Combined pool name" className="h-8 max-w-xs" value={combineName} onChange={(e) => setCombineName(e.target.value)} />
                    <Button size="sm" id="btn-combine-suggestions" disabled={!combineName.trim()} onClick={() => setCombineDialog({ suggestions: checkedSuggestions, name: combineName })}>
                      Combine {checkedSuggestions.length} into One Pool
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Recovery Pools ({pools.length})</CardTitle>
            <Button size="sm" variant="outline" id="btn-create-pool" onClick={() => setPoolDialog(true)}>
              <Plus className="w-3 h-3 mr-1" /> Add Custom Pool
            </Button>
          </CardHeader>
          <CardContent>
            {pools.length === 0 ? <p className="text-sm text-slate-500">No pools for this period yet.</p> : (
              <Table>
                <TableHeader><TableRow><TableHead>Pool Name</TableHead><TableHead>Scope</TableHead><TableHead>Categories</TableHead><TableHead>Gross-Up Default</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>
                  {pools.map((pool) => (
                    <TableRow key={pool.id}>
                      <TableCell className="font-medium">{pool.name}</TableCell>
                      <TableCell><Badge className="text-[10px]">{poolTypeLabel(pool.scope_type)}</Badge></TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {(pool.recovery_pool_categories ?? []).map((cat) => (
                            <Badge key={cat.id} className={`text-[10px] ${cat.inclusion_mode === "include" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                              {categoryNamesById.get(cat.expense_category_id) || cat.expense_category_id.slice(0, 8)}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>{pool.default_gross_up_target_pct != null ? `${pool.default_gross_up_target_pct}%` : "—"}</TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline" id={`btn-goto-participants-${pool.id}`} onClick={() => { setSelectedPoolId(pool.id); setStep(3); }}>Participants →</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Dialog open={poolDialog} onOpenChange={setPoolDialog}>
          <DialogContent>
            <DialogHeader><DialogTitle>Add Custom Recovery Pool</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Pool Name</Label><Input id="pool-name" value={poolForm.name} onChange={(e) => setPoolForm({ ...poolForm, name: e.target.value })} /></div>
              <div><Label>Scope</Label>
                <Select value={poolForm.scope_type} onValueChange={(v) => setPoolForm({ ...poolForm, scope_type: v, pool_type: v })}>
                  <SelectTrigger id="pool-scope"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="property">{scopeTypeLabel("property")}</SelectItem>
                    <SelectItem value="building">{scopeTypeLabel("building")}</SelectItem>
                    <SelectItem value="custom">{scopeTypeLabel("custom")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPoolDialog(false)}>Cancel</Button>
              <Button id="btn-save-pool" disabled={!poolForm.name.trim()} onClick={async () => {
                await doAction("create_recovery_pool", { property_id: propertyId, period_id: periodId, scope_id: buildingId || propertyId, ...poolForm }, [["recovery_pools", propertyId, periodId]], "Pool created");
                setPoolDialog(false);
                refetchPools();
              }}>Create Pool</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(combineDialog)} onOpenChange={() => setCombineDialog(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Combine {combineDialog?.suggestions?.length} Suggestions into One Pool</DialogTitle></DialogHeader>
            <p className="text-sm text-slate-600">Categories: {combineDialog?.suggestions?.map((s) => s.suggested_pool_name).join(", ")}</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCombineDialog(null)}>Cancel</Button>
              <Button id="btn-confirm-combine" onClick={async () => {
                const created = await doAction("create_recovery_pool", {
                  property_id: propertyId, period_id: periodId, name: combineDialog.name,
                  pool_type: buildingId ? "building" : "property", scope_type: buildingId ? "building" : "property", scope_id: buildingId || propertyId,
                }, [], "Combined pool created");
                if (created?.pool?.id) {
                  for (const s of combineDialog.suggestions) {
                    await doAction("assign_pool_category", { pool_id: created.pool.id, expense_category_id: s.expense_category_id }, [], null);
                  }
                }
                queryClient.invalidateQueries({ queryKey: ["recovery_pools", propertyId, periodId] });
                setCombineDialog(null);
                setCombineChecked({});
                refetchPools();
              }}>Create Combined Pool</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ============================================================================
  // Step 3 — Participants (Requirement 5: automatic suggestions)
  // ============================================================================
  function Step3() {
    const [partForm, setPartForm] = useState({ lease_id: "", effective_from: "", reason: "" });

    const suggestions = useMemo(() => {
      if (!selectedPool || !selectedPeriod) return [];
      return suggestParticipants(selectedPool, activeLeases, leasePremises, approvedPolicySteps, selectedPoolCategoryIds, participants, selectedPeriod);
    }, [selectedPool, activeLeases, leasePremises, approvedPolicySteps, selectedPoolCategoryIds, participants, selectedPeriod]);

    const activeParticipants = participants.filter((p) => p.status === "active");

    return (
      <div className="space-y-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Select Pool</CardTitle></CardHeader>
          <CardContent>
            <Select value={selectedPoolId} onValueChange={setSelectedPoolId}>
              <SelectTrigger id="s3-pool"><SelectValue placeholder="Choose pool..." /></SelectTrigger>
              <SelectContent>{pools.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
          </CardContent>
        </Card>

        {selectedPoolId && (
          <>
            <Card className="border-blue-200">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2"><Sparkles className="w-4 h-4 text-blue-600" /> Suggested Participants</CardTitle>
                <p className="text-xs text-slate-500 font-normal">Derived from lease premises, this pool's scope, effective dates, and policy category eligibility. Explicit confirmation is what actually grants participation.</p>
              </CardHeader>
              <CardContent>
                {suggestions.length === 0 ? <p className="text-sm text-slate-500">No new suggestions for this pool.</p> : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tenant</TableHead><TableHead>Premises</TableHead><TableHead>Effective Area</TableHead>
                        <TableHead>Lease Dates</TableHead><TableHead>Reason</TableHead><TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {suggestions.map((s) => (
                        <TableRow key={s.lease_id}>
                          <TableCell className="font-medium">{s.tenant_name}</TableCell>
                          <TableCell className="text-xs font-mono">{s.premises_id.slice(0, 8)}</TableCell>
                          <TableCell>{s.effective_area_sqft != null ? `${Number(s.effective_area_sqft).toLocaleString()} sqft` : "—"}</TableCell>
                          <TableCell className="text-xs">{s.lease_start || "—"} → {s.lease_end || "open"}</TableCell>
                          <TableCell className="text-xs text-slate-500 max-w-xs">{s.reason}</TableCell>
                          <TableCell>
                            <Button size="sm" id={`btn-confirm-participant-${s.lease_id}`} onClick={async () => {
                              await doAction("add_pool_participant", { pool_id: selectedPoolId, lease_id: s.lease_id, effective_from: selectedPeriod.start_date, notes: "Confirmed from automatic suggestion" }, [["pool_participants", selectedPoolId]], "Participant confirmed");
                              refetchParticipants();
                            }}>Confirm</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Confirmed Participants ({activeParticipants.length})</CardTitle>
                <Button size="sm" variant="outline" id="btn-add-participant" onClick={() => setParticipantDialog(true)}>
                  <Plus className="w-3 h-3 mr-1" /> Include Other Lease
                </Button>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow><TableHead>Tenant</TableHead><TableHead>Effective From</TableHead><TableHead>Status</TableHead><TableHead>Source</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>
                    {participants.length === 0 && <TableRow><TableCell colSpan={5} className="text-slate-500 text-sm text-center py-4">No participants yet</TableCell></TableRow>}
                    {participants.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>{p.leases?.tenant_name ?? p.lease_id.slice(0, 8)}</TableCell>
                        <TableCell>{p.effective_from}{p.effective_to ? ` → ${p.effective_to}` : ""}</TableCell>
                        <TableCell><Badge className={`text-[10px] ${p.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{participantStatusLabel(p.status)}</Badge></TableCell>
                        <TableCell className="text-xs text-slate-500">{p.notes || "—"}</TableCell>
                        <TableCell>
                          {p.status === "active" && (
                            <Button size="sm" variant="ghost" id={`btn-exclude-participant-${p.id}`} onClick={() => setExcludeDialog(p)}>
                              <Trash2 className="w-3 h-3 text-red-500" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}

        <Dialog open={participantDialog} onOpenChange={setParticipantDialog}>
          <DialogContent>
            <DialogHeader><DialogTitle>Include Lease (Manual Override)</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Lease</Label>
                <Select value={partForm.lease_id} onValueChange={(v) => setPartForm({ ...partForm, lease_id: v })}>
                  <SelectTrigger id="part-lease"><SelectValue placeholder="Select lease..." /></SelectTrigger>
                  <SelectContent>{activeLeases.filter((l) => l.property_id === propertyId).map((l) => <SelectItem key={l.id} value={l.id}>{l.tenant_name ?? l.id.slice(0, 8)}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label>Effective From</Label><Input id="part-effective-from" type="date" value={partForm.effective_from} onChange={(e) => setPartForm({ ...partForm, effective_from: e.target.value })} /></div>
              <div><Label>Reason (required — this lease was not on the suggested list)</Label>
                <Textarea id="part-reason" rows={3} value={partForm.reason} onChange={(e) => setPartForm({ ...partForm, reason: e.target.value })} /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setParticipantDialog(false)}>Cancel</Button>
              <Button id="btn-save-participant" disabled={!partForm.lease_id || !partForm.effective_from || !partForm.reason.trim()} onClick={async () => {
                await doAction("add_pool_participant", { pool_id: selectedPoolId, lease_id: partForm.lease_id, effective_from: partForm.effective_from, notes: partForm.reason }, [["pool_participants", selectedPoolId]], "Participant added");
                setParticipantDialog(false);
                setPartForm({ lease_id: "", effective_from: "", reason: "" });
                refetchParticipants();
              }}>Add</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(excludeDialog)} onOpenChange={() => setExcludeDialog(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Exclude {excludeDialog?.leases?.tenant_name || "this lease"}</DialogTitle></DialogHeader>
            <ExcludeParticipantForm
              onCancel={() => setExcludeDialog(null)}
              onConfirm={async (reason) => {
                await doAction("remove_pool_participant", { participant_id: excludeDialog.id, reason }, [["pool_participants", selectedPoolId]], "Participant excluded");
                setExcludeDialog(null);
                refetchParticipants();
              }}
            />
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  function ExcludeParticipantForm({ onCancel, onConfirm }) {
    const [reason, setReason] = useState("");
    return (
      <>
        <div><Label>Reason (required)</Label><Textarea id="exclude-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this lease being excluded from the pool?" /></div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button id="btn-confirm-exclude" disabled={!reason.trim()} onClick={() => onConfirm(reason)}>Exclude</Button>
        </DialogFooter>
      </>
    );
  }

  // ============================================================================
  // Step 4 — Policies (Requirement 6: complete display)
  // ============================================================================
  function Step4() {
    const [resolveForm, setResolveForm] = useState({ state: "KNOWN_ZERO", amount: "", evidence_note: "" });
    const [policyDialog, setPolicyDialog] = useState(null);
    const [priorAdjDialog, setPriorAdjDialog] = useState(null);

    // Reuses propertyLeaseIds (already building-aware, see its definition
    // near the top of the component) rather than re-deriving property-only
    // -- otherwise a lease correctly excluded from `policies`/`estimateSchedules`
    // by the building filter still shows up here, e.g. as a false "missing
    // policy" for a lease that simply belongs to a different building.
    const propLeases = activeLeases.filter((l) => propertyLeaseIds.includes(l.id));
    const leasesMissingPolicy = propLeases.filter((l) => !policies.some((p) => p.lease_id === l.id));

    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Materialized Lease Recovery Policies</CardTitle>
            <p className="text-xs text-slate-500 font-normal">Loaded directly from materialized, approved lease recovery rules. You may only resolve missing or conflicting values — rules cannot be assigned arbitrarily here.</p>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tenant</TableHead><TableHead>Category</TableHead><TableHead>Share / Method</TableHead>
                    <TableHead>Gross-Up</TableHead><TableHead>Base Year</TableHead><TableHead>Cap</TableHead>
                    <TableHead>Fee</TableHead><TableHead>Effective</TableHead><TableHead>Status</TableHead><TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {policies.length === 0 && <TableRow><TableCell colSpan={10} className="text-sm text-slate-500 text-center py-4">No policies found. Ensure lease expense rules have been approved and materialized.</TableCell></TableRow>}
                  {policies.map((pol) => {
                    const summ = summarizePolicy(pol, pol.lease_recovery_policy_steps, categoryNamesById);
                    return (
                      <TableRow key={pol.id}>
                        <TableCell className="font-medium">{pol.leases?.tenant_name ?? "—"}</TableCell>
                        <TableCell>{summ.hasCategory ? summ.categoryName : <Badge className="text-[10px] bg-amber-100 text-amber-800">Not derivable from steps</Badge>}</TableCell>
                        <TableCell className="text-xs">{summ.shareDescription}</TableCell>
                        <TableCell className="text-xs">{summ.grossUpTarget}</TableCell>
                        <TableCell className="text-xs">{summ.baseYear}</TableCell>
                        <TableCell className="text-xs">{summ.cap}</TableCell>
                        <TableCell className="text-xs">{summ.adminFee}</TableCell>
                        <TableCell className="text-xs">{summ.effectiveFrom}{summ.effectiveTo ? ` → ${summ.effectiveTo}` : ""}</TableCell>
                        <TableCell><Badge className={`text-[10px] ${pol.status === "approved" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>{policyStatusLabel(pol.status)}</Badge></TableCell>
                        <TableCell>
                          <Button size="sm" variant="outline" id={`btn-view-policy-${pol.id}`} onClick={() => setPolicyDialog({ pol, summ })}>Detail</Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {leasesMissingPolicy.length > 0 && (
          <Card className="border-amber-300 bg-amber-50">
            <CardHeader><CardTitle className="text-base">Leases Missing Policy Information ({leasesMissingPolicy.length})</CardTitle></CardHeader>
            <CardContent>
              <ul className="text-sm space-y-1">
                {leasesMissingPolicy.map((l) => (
                  <li key={l.id} className="flex items-center justify-between">
                    <span>{l.tenant_name || l.id.slice(0, 8)}</span>
                    <Link to={createPageUrl("LeaseExpenseRules") + `?lease_id=${l.id}`} className="text-xs text-blue-600 underline flex items-center gap-1">
                      Resolve in Lease Expense Rules <ExternalLink className="w-3 h-3" />
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle className="text-base">Prior Adjustments &amp; Credits</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Tenant</TableHead><TableHead>Type</TableHead><TableHead>State</TableHead><TableHead>Amount</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {priorAdjustments.length === 0 && <TableRow><TableCell colSpan={5} className="text-sm text-slate-500 text-center py-4">No prior adjustment records for this period.</TableCell></TableRow>}
                {priorAdjustments.map((adj) => (
                  <TableRow key={adj.id}>
                    <TableCell>{adj.leases?.tenant_name ?? "—"}</TableCell>
                    <TableCell><Badge className="text-[10px]">{adjustmentTypeLabel(adj.adjustment_type)}</Badge></TableCell>
                    <TableCell><Badge className={`text-[10px] ${adj.state === "UNKNOWN" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>{adjustmentStateLabel(adj.state)}</Badge></TableCell>
                    <TableCell>{adj.amount != null ? fmtCurrency(adj.amount) : "—"}</TableCell>
                    <TableCell>
                      {adj.state === "UNKNOWN" && (
                        <Button size="sm" variant="outline" id={`btn-resolve-adj-${adj.id}`} onClick={() => setPriorAdjDialog({ leaseId: adj.lease_id, periodId: adj.recovery_period_id, adjType: adj.adjustment_type })}>Resolve</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Dialog open={Boolean(policyDialog)} onOpenChange={() => setPolicyDialog(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>Policy Detail — {policyDialog?.pol?.leases?.tenant_name}</DialogTitle></DialogHeader>
            {policyDialog && (
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-slate-400">Category</span><div>{policyDialog.summ.categoryName ?? "—"}</div></div>
                <div><span className="text-slate-400">Share / Method</span><div>{policyDialog.summ.shareDescription}</div></div>
                <div><span className="text-slate-400">Numerator / Denominator Source</span><div>{policyDialog.summ.numeratorDenominatorSource}</div></div>
                <div><span className="text-slate-400">Gross-Up Target</span><div>{policyDialog.summ.grossUpTarget}</div></div>
                <div><span className="text-slate-400">Base Year</span><div>{policyDialog.summ.baseYear}</div></div>
                <div><span className="text-slate-400">Expense Stop</span><div>{policyDialog.summ.expenseStop}</div></div>
                <div><span className="text-slate-400">Cap</span><div>{policyDialog.summ.cap}</div></div>
                <div><span className="text-slate-400">Floor</span><div>{policyDialog.summ.floor}</div></div>
                <div><span className="text-slate-400">Deductible</span><div>{policyDialog.summ.deductible}</div></div>
                <div><span className="text-slate-400">Admin / Management Fee</span><div>{policyDialog.summ.adminFee}</div></div>
                <div><span className="text-slate-400">Effective Dates</span><div>{policyDialog.summ.effectiveFrom} → {policyDialog.summ.effectiveTo || "open"}</div></div>
                <div><span className="text-slate-400">Readiness Status</span><div><Badge className={`text-[10px] ${policyDialog.pol.status === "approved" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>{policyStatusLabel(policyDialog.pol.status)}</Badge></div></div>
                <div className="col-span-2"><span className="text-slate-400">Source / Amendment Evidence</span>
                  <div className="text-xs font-mono bg-slate-50 rounded p-2 mt-1 max-h-32 overflow-y-auto">
                    {policyDialog.summ.sourceEvidence ? JSON.stringify(policyDialog.summ.sourceEvidence, null, 2) : "No evidence on file"}
                  </div>
                </div>
              </div>
            )}
            <DialogFooter>
              {policyDialog?.pol?.status !== "approved" && (
                <Button variant="outline" onClick={() => { setResolveForm({ state: "KNOWN_ZERO", amount: "", evidence_note: "" }); }}>
                  Resolve Missing Value
                </Button>
              )}
              <Button onClick={() => setPolicyDialog(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(priorAdjDialog)} onOpenChange={() => setPriorAdjDialog(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Resolve Prior Adjustment</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>State</Label>
                <Select value={resolveForm.state} onValueChange={(v) => setResolveForm({ ...resolveForm, state: v })}>
                  <SelectTrigger id="adj-state"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="KNOWN_ZERO">{adjustmentStateLabel("KNOWN_ZERO")}</SelectItem>
                    <SelectItem value="KNOWN_AMOUNT">{adjustmentStateLabel("KNOWN_AMOUNT")}</SelectItem>
                    <SelectItem value="NOT_APPLICABLE">{adjustmentStateLabel("NOT_APPLICABLE")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {resolveForm.state === "KNOWN_AMOUNT" && (
                <div><Label>Amount ($)</Label><Input id="adj-amount" type="number" value={resolveForm.amount} onChange={(e) => setResolveForm({ ...resolveForm, amount: e.target.value })} /></div>
              )}
              <div><Label>Evidence Note (required)</Label><Textarea id="adj-note" rows={3} value={resolveForm.evidence_note} onChange={(e) => setResolveForm({ ...resolveForm, evidence_note: e.target.value })} /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPriorAdjDialog(null)}>Cancel</Button>
              <Button id="btn-save-prior-adj" disabled={!resolveForm.evidence_note.trim()} onClick={async () => {
                await doAction("record_prior_adjustment", {
                  lease_id: priorAdjDialog.leaseId, recovery_period_id: priorAdjDialog.periodId, adjustment_type: priorAdjDialog.adjType,
                  state: resolveForm.state, amount: resolveForm.amount || undefined, evidence_note: resolveForm.evidence_note,
                }, [["cam_prior_period_adjustments", periodId]], "Adjustment resolved");
                setPriorAdjDialog(null);
                refetchPriorAdj();
              }}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ============================================================================
  // Step 5 — Expenses (Requirement 7: complete display)
  // ============================================================================
  function Step5() {
    const [assignForm, setAssignForm] = useState({ recovery_pool_id: "", amount: "" });
    const [splitRows, setSplitRows] = useState([{ recovery_pool_id: "", amount: "" }]);

    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Published Expense Inputs</CardTitle>
            <p className="text-xs text-slate-500 font-normal">Only finalized, CAM-eligible, published expense inputs appear here. Source expenses cannot be created here — use the Expenses module.</p>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor / Description</TableHead><TableHead>Category</TableHead><TableHead>Scope</TableHead>
                    <TableHead>Service Period</TableHead><TableHead>Amount</TableHead><TableHead>Recoverability</TableHead>
                    <TableHead>Pool Assignment</TableHead><TableHead /><TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {publishedExpenses.length === 0 && <TableRow><TableCell colSpan={9} className="text-sm text-slate-500 text-center py-4">No published expense inputs for this property.</TableCell></TableRow>}
                  {publishedExpenses.map((exp) => {
                    const assigned = (exp.cam_input_pool_assignments || []).reduce((s, a) => s + Number(a.amount || 0), 0);
                    const unassignedBalance = Number(exp.amount || 0) - assigned;
                    const vendor = exp._sourceExpense?.vendor || exp._sourceExpense?.vendor_name || "—";
                    const description = exp._sourceExpense?.description || "—";
                    const recoverability = exp._classification?.recoverability_result || exp._classification?.recovery_status;
                    const hasGap = !exp.category || !exp.service_period_start || !exp.service_period_end;
                    return (
                      <TableRow key={exp.id} className={hasGap ? "bg-amber-50" : ""}>
                        <TableCell>
                          <div className="text-sm font-medium">{vendor}</div>
                          <div className="text-xs text-slate-500">{description}</div>
                        </TableCell>
                        <TableCell>{exp.category ? (categoryNamesById.get(exp.category) || exp.category.slice(0, 8)) : <Badge className="text-[10px] bg-red-100 text-red-700">Missing</Badge>}</TableCell>
                        <TableCell className="text-xs">{exp.building_id ? "Building" : "Property-Wide"}</TableCell>
                        <TableCell className="text-xs">
                          {exp.service_period_start && exp.service_period_end
                            ? `${exp.service_period_start} → ${exp.service_period_end}`
                            : <Badge className="text-[10px] bg-amber-100 text-amber-800">Missing</Badge>}
                        </TableCell>
                        <TableCell className="font-medium">{fmtCurrency(exp.amount)}</TableCell>
                        <TableCell><Badge className="text-[10px]">{recoverabilityLabel(recoverability)}</Badge></TableCell>
                        <TableCell>
                          {(exp.cam_input_pool_assignments ?? []).length === 0
                            ? <Badge className="text-[10px] bg-amber-100 text-amber-800">Unassigned</Badge>
                            : (
                              <div className="text-xs">
                                {exp.cam_input_pool_assignments.map((a, i) => <div key={i}>{a.recovery_pools?.name}: {fmtCurrency(a.amount)}</div>)}
                                {unassignedBalance > 0.005 && <div className="text-amber-700">Unassigned balance: {fmtCurrency(unassignedBalance)}</div>}
                              </div>
                            )}
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="outline" id={`btn-assign-expense-${exp.id}`} onClick={() => { setExpenseDialog(exp); setSplitRows([{ recovery_pool_id: "", amount: String(unassignedBalance || exp.amount) }]); }}>
                            {(exp.cam_input_pool_assignments ?? []).length === 0 ? "Assign / Split" : "Adjust Split"}
                          </Button>
                        </TableCell>
                        <TableCell>
                          <Link to={createPageUrl("Expenses") + (exp.actual_expense_id ? `?expense_id=${exp.actual_expense_id}` : "")} className="text-xs text-blue-600 underline flex items-center gap-1">
                            Expense Module <ExternalLink className="w-3 h-3" />
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Dialog open={Boolean(expenseDialog)} onOpenChange={() => setExpenseDialog(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Assign / Split Expense</DialogTitle></DialogHeader>
            <p className="text-sm text-slate-600">Total amount: <strong>{fmtCurrency(expenseDialog?.amount)}</strong></p>
            <div className="space-y-2 mt-2">
              {splitRows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select value={row.recovery_pool_id} onValueChange={(v) => setSplitRows((r) => r.map((x, j) => j === i ? { ...x, recovery_pool_id: v } : x))}>
                    <SelectTrigger id={`split-pool-${i}`} className="flex-1"><SelectValue placeholder="Pool..." /></SelectTrigger>
                    <SelectContent>{pools.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
                  </Select>
                  <Input id={`split-amount-${i}`} type="number" min={0.01} className="w-32" value={row.amount} onChange={(e) => setSplitRows((r) => r.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
                  {splitRows.length > 1 && <Button size="sm" variant="ghost" onClick={() => setSplitRows((r) => r.filter((_, j) => j !== i))}><Trash2 className="w-3 h-3 text-red-500" /></Button>}
                </div>
              ))}
              <Button size="sm" variant="outline" id="btn-add-split-row" onClick={() => setSplitRows((r) => [...r, { recovery_pool_id: "", amount: "" }])}>
                <Plus className="w-3 h-3 mr-1" /> Split Across Another Pool
              </Button>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setExpenseDialog(null)}>Cancel</Button>
              <Button id="btn-save-assign-expense" onClick={async () => {
                for (const row of splitRows) {
                  if (!row.recovery_pool_id || !row.amount) continue;
                  await doAction("assign_expense_to_pool", { cam_expense_input_id: expenseDialog.id, recovery_pool_id: row.recovery_pool_id, amount: Number(row.amount) }, [], null);
                }
                queryClient.invalidateQueries({ queryKey: ["cam_expense_inputs_published", propertyId] });
                setExpenseDialog(null);
                toast.success("Expense assignment saved");
              }}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ============================================================================
  // Step 6 — Estimates & Adjustments (Requirement 8: bulk entry)
  // ============================================================================
  function Step6() {
    const leaseOptions = activeLeases.filter((l) => l.property_id === propertyId);
    const [bulkForm, setBulkForm] = useState({ lease_id: "", reason: "" });
    const [ranges, setRanges] = useState([{ amount: "", start_month: "", end_month: "" }]);

    function monthsInRange(startMonth, endMonth) {
      const rows = [];
      let cur = new Date(`${startMonth}-01T00:00:00Z`);
      const end = new Date(`${endMonth}-01T00:00:00Z`);
      while (cur <= end) {
        rows.push(cur.toISOString().slice(0, 10));
        cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
      }
      return rows;
    }

    const previewRows = useMemo(() => {
      const rows = [];
      for (const r of ranges) {
        if (!r.amount || !r.start_month || !r.end_month) continue;
        for (const month_date of monthsInRange(r.start_month, r.end_month)) rows.push({ month_date, amount: Number(r.amount) });
      }
      // Later ranges override earlier ones for the same month (last-write-wins on overlap).
      const byMonth = new Map(rows.map((r) => [r.month_date, r]));
      return [...byMonth.values()].sort((a, b) => a.month_date.localeCompare(b.month_date));
    }, [ranges]);

    return (
      <div className="space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Monthly Estimate Schedules</CardTitle>
            <Button size="sm" id="btn-open-bulk-estimate" onClick={() => setEstimateDialog(true)}>
              <Plus className="w-3 h-3 mr-1" /> Bulk Add Estimates
            </Button>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Tenant</TableHead><TableHead>Month</TableHead><TableHead>Amount</TableHead><TableHead>Source</TableHead></TableRow></TableHeader>
              <TableBody>
                {estimateSchedules.length === 0 && <TableRow><TableCell colSpan={4} className="text-sm text-slate-500 text-center py-4">No estimate schedules for this period. No existing Revenue/Billing source was found to import from — enter manually below.</TableCell></TableRow>}
                {estimateSchedules.map((es) => (
                  <TableRow key={es.id}>
                    <TableCell>{es.leases?.tenant_name ?? "—"}</TableCell>
                    <TableCell>{es.month_date}</TableCell>
                    <TableCell>{fmtCurrency(es.amount)}</TableCell>
                    <TableCell><Badge className="text-[10px]">{es.source === "imported" ? "Imported" : es.source === "generated_from_budget" ? "From Budget" : "Manual"}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Dialog open={estimateDialog} onOpenChange={setEstimateDialog}>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>Bulk Add Monthly Estimates</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Lease</Label>
                <Select value={bulkForm.lease_id} onValueChange={(v) => setBulkForm({ ...bulkForm, lease_id: v })}>
                  <SelectTrigger id="bulk-est-lease"><SelectValue placeholder="Select lease..." /></SelectTrigger>
                  <SelectContent>{leaseOptions.map((l) => <SelectItem key={l.id} value={l.id}>{l.tenant_name ?? l.id.slice(0, 8)}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <p className="text-xs text-slate-500">Add one row per effective range (use multiple rows if the monthly amount changes during the year).</p>
              {ranges.map((r, i) => (
                <div key={i} className="grid grid-cols-4 gap-2 items-end">
                  <div><Label className="text-[10px]">Monthly $</Label><Input id={`bulk-est-amount-${i}`} type="number" value={r.amount} onChange={(e) => setRanges((rr) => rr.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} /></div>
                  <div><Label className="text-[10px]">Start Month</Label><Input id={`bulk-est-start-${i}`} type="month" value={r.start_month} onChange={(e) => setRanges((rr) => rr.map((x, j) => j === i ? { ...x, start_month: e.target.value } : x))} /></div>
                  <div><Label className="text-[10px]">End Month</Label><Input id={`bulk-est-end-${i}`} type="month" value={r.end_month} onChange={(e) => setRanges((rr) => rr.map((x, j) => j === i ? { ...x, end_month: e.target.value } : x))} /></div>
                  {ranges.length > 1 && <Button size="sm" variant="ghost" onClick={() => setRanges((rr) => rr.filter((_, j) => j !== i))}><Trash2 className="w-3 h-3 text-red-500" /></Button>}
                </div>
              ))}
              <Button size="sm" variant="outline" id="btn-add-estimate-range" onClick={() => setRanges((rr) => [...rr, { amount: "", start_month: "", end_month: "" }])}>
                <Plus className="w-3 h-3 mr-1" /> Add Effective Range
              </Button>
              <div><Label>Reason / Source (required)</Label><Textarea id="bulk-est-reason" rows={2} value={bulkForm.reason} onChange={(e) => setBulkForm({ ...bulkForm, reason: e.target.value })} placeholder="e.g. Per lease escalation schedule, confirmed with tenant." /></div>
              {previewRows.length > 0 && (
                <div className="text-xs text-slate-500 border rounded p-2 max-h-32 overflow-y-auto">
                  <span id="bulk-est-preview-count" className="font-medium">{previewRows.length} monthly rows will be created</span>: {previewRows.map((r) => `${r.month_date.slice(0, 7)}=$${r.amount}`).join(", ")}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEstimateDialog(false)}>Cancel</Button>
              <Button
                id="btn-save-bulk-estimate"
                disabled={!bulkForm.lease_id || !bulkForm.reason.trim() || previewRows.length === 0}
                onClick={async () => {
                  await doAction("create_estimate_schedules_bulk", { lease_id: bulkForm.lease_id, recovery_period_id: periodId, rows: previewRows, reason: bulkForm.reason }, [["cam_estimate_schedules", periodId]], `${previewRows.length} estimate rows created`);
                  setEstimateDialog(false);
                  setRanges([{ amount: "", start_month: "", end_month: "" }]);
                  setBulkForm({ lease_id: "", reason: "" });
                  refetchEstimates();
                }}
              >
                Create {previewRows.length || ""} Rows
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ============================================================================
  // Step 7 — Readiness Action Center (Requirement 9)
  // ============================================================================
  function Step7() {
    if (!propertyId || !periodId) return <p className="text-sm text-slate-500">Select a property and period first (Step 1).</p>;

    const blocking = readiness.items.filter((i) => i.severity === "blocking");
    const warnings = readiness.items.filter((i) => i.severity === "warning");
    const completed = [
      { label: "Recovery period selected", done: Boolean(periodId) },
      { label: "At least one recovery pool configured", done: pools.length > 0 },
      { label: "Every published expense assigned to a pool", done: summary.unassigned === 0 },
    ];

    function resolutionLink(item) {
      const map = {
        POLICY_MISSING: 4, POLICY_CONFLICT: 4, PREMISES_MISSING: 4, AREA_MISSING: 4,
        POOL_CATEGORY_MISSING: 2, POOL_ASSIGNMENT_MISSING: 5, ALLOCATION_UNBALANCED: 5,
        BASE_YEAR_MISSING: 4, CAP_HISTORY_MISSING: 4, PRIOR_ADJUSTMENT_UNKNOWN: 4,
        EXPENSE_CATEGORY_MISSING: 5, EXPENSE_SERVICE_PERIOD_MISSING: 5, OCCUPANCY_UNKNOWN: 3,
      };
      return map[item.code] ?? null;
    }

    return (
      <div className="space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Setup Readiness</CardTitle>
            <Button size="sm" variant="outline" id="btn-recheck-readiness" onClick={() => refetchReadiness()} disabled={readinessLoading}>
              {readinessLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />} Re-check
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <StatusBadge ready={readiness.ready} />
              {readiness.ready && <span id="readiness-ready-text" className="text-sm text-emerald-700 font-medium">CAM Setup is READY</span>}
            </div>

            <div>
              <p className="text-sm font-semibold text-slate-700 mb-2">Completed Requirements</p>
              <div className="space-y-1">
                {completed.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    {c.done ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : <XCircle className="w-4 h-4 text-slate-300" />}
                    <span className={c.done ? "" : "text-slate-400"}>{c.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {blocking.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-red-700 mb-2">Blocking Issues ({blocking.length})</p>
                <div className="space-y-1">
                  {blocking.map((item, i) => {
                    const jump = resolutionLink(item);
                    const isPolicyConflict = item.code === "POLICY_CONFLICT" && policyConflictsByLeaseId.has(item.entityId);
                    return (
                      <div key={i} className="flex items-start justify-between gap-2 p-2 bg-red-50 rounded text-sm">
                        <div className="flex items-start gap-2">
                          <XCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
                          <div>
                            <div>{item.message}</div>
                            <div className="text-xs text-slate-500">{item.rawMessage}</div>
                          </div>
                        </div>
                        {isPolicyConflict ? (
                          <Button size="sm" variant="outline" id="btn-resolve-policy-conflict" onClick={() => setPolicyConflictLeaseId(item.entityId)}>Resolve Conflict →</Button>
                        ) : (
                          jump && <Button size="sm" variant="outline" onClick={() => setStep(jump)}>Resolve →</Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {warnings.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-amber-700 mb-2">Warnings ({warnings.length})</p>
                <div className="space-y-1">
                  {warnings.map((item, i) => (
                    <div key={i} className="flex items-start gap-2 p-2 bg-amber-50 rounded text-sm">
                      <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                      <span>{item.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {readiness.ready && (
              <Link to={createPageUrl("CAMRun") + `?property_id=${propertyId}&recovery_period_id=${periodId}`} id="btn-go-to-cam-run">
                <Button size="lg" className="mt-2" id="btn-launch-cam-run">Start CAM Run →</Button>
              </Link>
            )}
          </CardContent>
        </Card>

        <Dialog open={Boolean(policyConflictLeaseId)} onOpenChange={(open) => { if (!open) setPolicyConflictLeaseId(null); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>Resolve Policy Conflict</DialogTitle></DialogHeader>
            <p className="text-xs text-slate-500">
              These two active policies cover the same lease and expense category with overlapping effective dates. Choose which one to supersede and provide a reason — this is recorded as a versioned, audited override, not a silent change.
            </p>
            {(policyConflictsByLeaseId.get(policyConflictLeaseId)?.[0] ?? []).map((pol) => {
              const summ = summarizePolicy(pol, pol.lease_recovery_policy_steps, categoryNamesById);
              return (
                <div key={pol.id} className="border rounded p-3 space-y-2">
                  <p className="text-sm font-semibold">{pol.leases?.tenant_name ?? "—"} — {summ.hasCategory ? summ.categoryName : "Category not derivable"}</p>
                  <p className="text-xs text-slate-600">{summ.shareDescription} · Effective {summ.effectiveFrom}{summ.effectiveTo ? ` → ${summ.effectiveTo}` : ""}</p>
                  <p className="text-xs text-slate-500">Source evidence: {pol.source_evidence?.exact_source_text || "—"}</p>
                  <Textarea
                    placeholder="Reason for superseding this policy (required)"
                    value={conflictReasons[pol.id] || ""}
                    onChange={(e) => setConflictReasons({ ...conflictReasons, [pol.id]: e.target.value })}
                  />
                  <Button
                    size="sm" variant="outline" id={`btn-supersede-policy-${pol.id}`}
                    disabled={!conflictReasons[pol.id]?.trim() || resolveConflictMutation.isPending}
                    onClick={() => resolveConflictMutation.mutate({ policyId: pol.id, reason: conflictReasons[pol.id] })}
                  >
                    Supersede This Policy
                  </Button>
                </div>
              );
            })}
            <DialogFooter>
              <Button variant="outline" onClick={() => setPolicyConflictLeaseId(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ============================================================================
  // RECONCILIATION WORKBENCH — the default, business-facing view. Every tab
  // below reads data already queried above (same tables, same shapes as the
  // 7-step wizard and CAMRun.jsx) and reuses the same step components where
  // the step's existing content already IS the target section. Nothing here
  // performs a calculation — Calculate CAM Preview calls the same
  // run-cam-calculation-v2 edge function CAMRun.jsx uses, and every number
  // shown is read back from cam_run_pool_results / cam_run_lease_results.
  // ============================================================================

  // ---- Readiness banner: summary + inline resolvable issues ------------------
  function WorkbenchReadinessBanner() {
    if (!propertyId || !periodId) return null;
    const blocking = readiness.items.filter((i) => i.severity === "blocking");
    const warnings = readiness.items.filter((i) => i.severity === "warning");
    const jumpTab = {
      POLICY_MISSING: "policies", POLICY_CONFLICT: "policies", PREMISES_MISSING: "policies", AREA_MISSING: "policies",
      POOL_CATEGORY_MISSING: "pools", POOL_ASSIGNMENT_MISSING: "expenses", ALLOCATION_UNBALANCED: "expenses",
      BASE_YEAR_MISSING: "policies", CAP_HISTORY_MISSING: "policies", PRIOR_ADJUSTMENT_UNKNOWN: "policies",
      EXPENSE_CATEGORY_MISSING: "expenses", EXPENSE_SERVICE_PERIOD_MISSING: "expenses", OCCUPANCY_UNKNOWN: "pools",
    };
    return (
      <Card className={readiness.ready ? "border-emerald-200 bg-emerald-50/40" : blocking.length > 0 ? "border-red-200 bg-red-50/40" : "border-amber-200 bg-amber-50/40"}>
        <CardContent className="p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge ready={readiness.ready} />
            {readiness.ready ? (
              <span className="text-sm text-emerald-700 font-medium">Ready to calculate CAM for this property and period.</span>
            ) : (
              <span className="text-sm text-slate-700">
                {blocking.length} blocking issue{blocking.length === 1 ? "" : "s"}{warnings.length > 0 ? `, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""} must be resolved before calculation is fully authoritative.
              </span>
            )}
            <Button
              size="sm" variant="outline" className="ml-auto text-xs" id="btn-wb-prepare-cam-automatically"
              onClick={() => prepareCamMutation.mutate()} disabled={prepareCamMutation.isPending}
              title="Re-derive pools, policies, and expense assignments from approved lease documents and the expense modules. Additive and safe to run repeatedly — nothing existing is deleted."
            >
              {prepareCamMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1" />}
              Prepare CAM Automatically
            </Button>
            <Button size="sm" variant="ghost" className="text-xs" id="btn-open-advanced-readiness" onClick={() => setAdvancedReadinessOpen(true)}>
              <SlidersHorizontal className="w-3.5 h-3.5 mr-1" /> Advanced Readiness
            </Button>
          </div>
          {blocking.length > 0 && (
            <div className="space-y-1">
              {blocking.slice(0, 4).map((item, i) => {
                const isPolicyConflict = item.code === "POLICY_CONFLICT" && policyConflictsByLeaseId.has(item.entityId);
                return (
                  <div key={i} className="flex items-start justify-between gap-2 rounded bg-white/70 p-2 text-xs">
                    <div className="flex items-start gap-1.5"><XCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" /><span>{item.message}</span></div>
                    {isPolicyConflict ? (
                      <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => { setPolicyConflictLeaseId(item.entityId); setAdvancedReadinessOpen(true); }}>Resolve Conflict →</Button>
                    ) : jumpTab[item.code] ? (
                      <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => setWorkbenchTab(jumpTab[item.code])}>Resolve →</Button>
                    ) : null}
                  </div>
                );
              })}
              {blocking.length > 4 && <p className="text-xs text-slate-500">+{blocking.length - 4} more — see Advanced Readiness.</p>}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // Hoisted out of Step1 (was previously only reachable/renderable there) so
  // "Prepare CAM Automatically" can also be triggered from the Workbench --
  // prepareCamMutation/prepareCamResult are already page-level state, only
  // the dialog markup needed to move. Behavior/content unchanged.
  function PrepareCamResultDialog() {
    return (
      <Dialog open={Boolean(prepareCamResult)} onOpenChange={(open) => { if (!open) setPrepareCamResult(null); }}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Prepare CAM Automatically — Results</DialogTitle></DialogHeader>
          {prepareCamResult && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div className="border rounded p-2"><p className="text-xs text-slate-500">Policies materialized</p><p className="text-lg font-semibold">{prepareCamResult.created?.policies_materialized ?? 0}</p></div>
                <div className="border rounded p-2"><p className="text-xs text-slate-500">Suggested pools</p><p className="text-lg font-semibold">{prepareCamResult.suggested?.pools?.length ?? 0}</p></div>
                <div className="border rounded p-2"><p className="text-xs text-slate-500">Suggested expense assignments</p><p className="text-lg font-semibold">{prepareCamResult.suggested?.expense_assignments?.length ?? 0}</p></div>
                <div className="border rounded p-2"><p className="text-xs text-slate-500 flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-red-600" /> Blocking exceptions</p><p className="text-lg font-semibold">{prepareCamResult.blocking?.length ?? 0}</p></div>
              </div>

              {prepareCamResult.conflicting?.duplicate_lease_groups?.length > 0 && (
                <div className="border border-amber-300 bg-amber-50 rounded p-3">
                  <p className="font-semibold text-amber-900 mb-1.5">Possible duplicate leases found ({prepareCamResult.conflicting.duplicate_lease_groups.length})</p>
                  <p className="text-xs text-amber-800 mb-2">These were excluded from suggestions until resolved. Nothing was merged or deleted automatically.</p>
                  <ul className="space-y-1.5">
                    {prepareCamResult.conflicting.duplicate_lease_groups.map((g, i) => (
                      <li key={i} className="text-xs text-amber-900">
                        <span className="font-medium">{g.tenant_name}</span> — {g.lease_count} lease records{g.likely_duplicate ? " (likely duplicate)" : " (possible multi-premises)"}
                        <br /><span className="text-amber-700">{g.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {prepareCamResult.conflicting?.materialization_blocked?.length > 0 && (
                <div className="border border-red-300 bg-red-50 rounded p-3">
                  <p className="font-semibold text-red-900 mb-1.5">Rules that could not be materialized ({prepareCamResult.conflicting.materialization_blocked.length})</p>
                  <ul className="space-y-1 text-xs text-red-800">
                    {prepareCamResult.conflicting.materialization_blocked.map((m, i) => <li key={i}>{m.reason}</li>)}
                  </ul>
                </div>
              )}

              {prepareCamResult.suggested?.pools?.length > 0 && (
                <div>
                  <p className="font-semibold mb-1.5">Suggested pools</p>
                  <ul className="space-y-1 text-xs">
                    {prepareCamResult.suggested.pools.map((p, i) => (
                      <li key={i} className="flex justify-between border-b py-1">
                        <span>{p.category_name || p.expense_category_id}</span>
                        <span className="text-slate-500">{p.expense_count} expenses · {fmtCurrency(p.expense_total)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-slate-500 mt-1.5">Review pool suggestions to confirm them.</p>
                </div>
              )}

              {prepareCamResult.missing?.leases_without_any_policy?.length > 0 && (
                <div className="border border-slate-200 rounded p-3">
                  <p className="font-semibold mb-1.5">Leases still missing any recovery policy ({prepareCamResult.missing.leases_without_any_policy.length})</p>
                  <ul className="text-xs text-slate-600 space-y-0.5">
                    {prepareCamResult.missing.leases_without_any_policy.map((l, i) => <li key={i}>{l.tenant_name}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrepareCamResult(null)}>Close</Button>
            <Button
              id="btn-prepare-cam-goto-pools"
              onClick={() => {
                setPrepareCamResult(null);
                if (workbenchView) setWorkbenchTab("pools"); else setStep(2);
              }}
            >
              Review Pools →
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  function WorkbenchAdvancedReadinessDrawer() {
    return (
      <Sheet open={advancedReadinessOpen} onOpenChange={setAdvancedReadinessOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader><SheetTitle>Advanced Readiness</SheetTitle></SheetHeader>
          <div className="mt-4"><Step7 /></div>
        </SheetContent>
      </Sheet>
    );
  }

  // ---- A. CAM Inputs -----------------------------------------------------------
  // A published cam_expense_inputs row can only exist once its classification
  // already passed the cam_eligible='yes' gate (enforced server-side by
  // send_expense_classification_to_cam_workflow / the publish RPC) -- so a
  // row reaching this tab is never "not eligible" by construction. The only
  // real distinction left to make here is calculation-readiness:
  //   conditional -- eligible, but missing a piece calculation needs (no
  //                  canonical category, no service period, or not yet
  //                  assigned to a pool) -- a genuine readiness blocker.
  //   eligible    -- categorized, dated, and pool-assigned; calculation-ready.
  // The true "not eligible" set (rule 5: stays in the Expense module) is a
  // different, upstream population -- expense_classifications rows that were
  // never sent to CAM at all -- queried separately as excludedClassifications
  // and shown only in the audit drawer below, never mixed into this table.
  function camExpenseStatus(exp) {
    const recov = String(exp._classification?.recoverability_result || exp._classification?.recovery_status || "").toLowerCase();
    const hasGap = !exp.category || !exp.service_period_start || !exp.service_period_end;
    const unassigned = (exp.cam_input_pool_assignments || []).length === 0;
    if (hasGap || unassigned || recov === "conditional" || recov === "needs_review") return "conditional";
    return "eligible";
  }

  function WorkbenchExpensesTab() {
    const [expenseDialog, setExpenseDialog] = useState(null);
    const [splitRows, setSplitRows] = useState([{ recovery_pool_id: "", amount: "" }]);
    const [excludedOpen, setExcludedOpen] = useState(false);

    const visible = publishedExpenses.map((exp) => ({ exp, status: camExpenseStatus(exp) }));

    return (
      <div className="space-y-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Published Expense Inputs</CardTitle>
              <p className="text-xs text-slate-500 font-normal mt-0.5">Eligible and conditional expenses only. Only finalized, published expense inputs appear here — use the Expenses module to create source expenses.</p>
            </div>
            {excludedClassifications.length > 0 && (
              <Button size="sm" variant="outline" id="btn-view-excluded-expenses" onClick={() => setExcludedOpen(true)}>
                Excluded Source Expenses ({excludedClassifications.length})
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor / Description</TableHead><TableHead>Category</TableHead><TableHead>Scope</TableHead>
                    <TableHead>Service Period</TableHead><TableHead>Amount</TableHead><TableHead>CAM Status</TableHead>
                    <TableHead>Pool Assignment</TableHead><TableHead /><TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.length === 0 && <TableRow><TableCell colSpan={9} className="text-sm text-slate-500 text-center py-4">No eligible or conditional published expenses for this property.</TableCell></TableRow>}
                  {visible.map(({ exp, status }) => {
                    const assigned = (exp.cam_input_pool_assignments || []).reduce((s, a) => s + Number(a.amount || 0), 0);
                    const unassignedBalance = Number(exp.amount || 0) - assigned;
                    const vendor = exp._sourceExpense?.vendor || exp._sourceExpense?.vendor_name || "—";
                    const description = exp._sourceExpense?.description || "—";
                    return (
                      <TableRow key={exp.id} className={status === "conditional" ? "bg-amber-50" : ""}>
                        <TableCell>
                          <div className="text-sm font-medium">{vendor}</div>
                          <div className="text-xs text-slate-500">{description}</div>
                        </TableCell>
                        <TableCell>{exp.category ? (categoryNamesById.get(exp.category) || exp.category.slice(0, 8)) : <Badge className="text-[10px] bg-red-100 text-red-700">Missing</Badge>}</TableCell>
                        <TableCell className="text-xs">{exp.building_id ? "Building" : "Property-Wide"}</TableCell>
                        <TableCell className="text-xs">
                          {exp.service_period_start && exp.service_period_end
                            ? `${exp.service_period_start} → ${exp.service_period_end}`
                            : <Badge className="text-[10px] bg-amber-100 text-amber-800">Missing</Badge>}
                        </TableCell>
                        <TableCell className="font-medium">{fmtCurrency(exp.amount)}</TableCell>
                        <TableCell>
                          <Badge className={`text-[10px] ${status === "eligible" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>
                            {status === "eligible" ? "Eligible" : "Conditional"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {(exp.cam_input_pool_assignments ?? []).length === 0
                            ? <Badge className="text-[10px] bg-amber-100 text-amber-800">Unassigned</Badge>
                            : (
                              <div className="text-xs">
                                {exp.cam_input_pool_assignments.map((a, i) => <div key={i}>{a.recovery_pools?.name}: {fmtCurrency(a.amount)}</div>)}
                                {unassignedBalance > 0.005 && <div className="text-amber-700">Unassigned balance: {fmtCurrency(unassignedBalance)}</div>}
                              </div>
                            )}
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="outline" id={`btn-wb-assign-expense-${exp.id}`} onClick={() => { setExpenseDialog(exp); setSplitRows([{ recovery_pool_id: "", amount: String(unassignedBalance || exp.amount) }]); }}>
                            {(exp.cam_input_pool_assignments ?? []).length === 0 ? "Assign / Split" : "Adjust Split"}
                          </Button>
                        </TableCell>
                        <TableCell>
                          <Link to={createPageUrl("Expenses") + (exp.actual_expense_id ? `?expense_id=${exp.actual_expense_id}` : "")} className="text-xs text-blue-600 underline flex items-center gap-1">
                            Expense Module <ExternalLink className="w-3 h-3" />
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Dialog open={Boolean(expenseDialog)} onOpenChange={() => setExpenseDialog(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Assign / Split Expense</DialogTitle></DialogHeader>
            <p className="text-sm text-slate-600">Total amount: <strong>{fmtCurrency(expenseDialog?.amount)}</strong></p>
            <div className="space-y-2 mt-2">
              {splitRows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select value={row.recovery_pool_id} onValueChange={(v) => setSplitRows((r) => r.map((x, j) => j === i ? { ...x, recovery_pool_id: v } : x))}>
                    <SelectTrigger id={`wb-split-pool-${i}`} className="flex-1"><SelectValue placeholder="Pool..." /></SelectTrigger>
                    <SelectContent>{pools.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
                  </Select>
                  <Input id={`wb-split-amount-${i}`} type="number" min={0.01} className="w-32" value={row.amount} onChange={(e) => setSplitRows((r) => r.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
                  {splitRows.length > 1 && <Button size="sm" variant="ghost" onClick={() => setSplitRows((r) => r.filter((_, j) => j !== i))}><Trash2 className="w-3 h-3 text-red-500" /></Button>}
                </div>
              ))}
              <Button size="sm" variant="outline" id="btn-wb-add-split-row" onClick={() => setSplitRows((r) => [...r, { recovery_pool_id: "", amount: "" }])}>
                <Plus className="w-3 h-3 mr-1" /> Split Across Another Pool
              </Button>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setExpenseDialog(null)}>Cancel</Button>
              <Button id="btn-wb-save-assign-expense" onClick={async () => {
                for (const row of splitRows) {
                  if (!row.recovery_pool_id || !row.amount) continue;
                  await doAction("assign_expense_to_pool", { cam_expense_input_id: expenseDialog.id, recovery_pool_id: row.recovery_pool_id, amount: Number(row.amount) }, [], null);
                }
                queryClient.invalidateQueries({ queryKey: ["cam_expense_inputs_published", propertyId] });
                setExpenseDialog(null);
                toast.success("Expense assignment saved");
              }}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Sheet open={excludedOpen} onOpenChange={setExcludedOpen}>
          <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
            <SheetHeader><SheetTitle>Excluded Source Expenses ({excludedClassifications.length})</SheetTitle></SheetHeader>
            <p className="text-xs text-slate-500 mt-2">Never sent to CAM — not CAM-eligible per Expense Classification. These stay in the Expense module; resolve or reclassify them there, not here.</p>
            <div className="mt-4 space-y-2">
              {excludedClassifications.map((c) => (
                <div key={c.id} className="flex items-center justify-between border rounded p-2 text-sm">
                  <div>
                    <div className="font-medium">{c._sourceExpense?.vendor || c._sourceExpense?.vendor_name || "—"}</div>
                    <div className="text-xs text-slate-500">{c._sourceExpense?.description || "—"}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-medium">{fmtCurrency(c._sourceExpense?.amount)}</div>
                    <Badge className="text-[10px] bg-red-100 text-red-700">{recoverabilityLabel(c.recoverability_result || c.recovery_status)}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  // ---- C. Pool Calculation ----------------------------------------------------
  function WorkbenchPoolCalculationTab() {
    return (
      <div className="space-y-6">
        <Step2 />
        <Step3 />
        {poolResults.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">Calculated Pool Results (latest run)</CardTitle></CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Pool</TableHead><TableHead className="text-right">Source Total</TableHead>
                      <TableHead className="text-right">Excluded</TableHead><TableHead className="text-right">Included</TableHead>
                      <TableHead className="text-right">Gross-Up Adj.</TableHead><TableHead className="text-right">Adjusted Pool</TableHead>
                      <TableHead>Participants</TableHead><TableHead>Denominator</TableHead><TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {poolResults.map((pr) => (
                      <TableRow key={pr.id}>
                        <TableCell className="font-medium">{pr.recovery_pools?.name || pr.pool_id.slice(0, 8)}</TableCell>
                        <TableCell className="text-right">{fmtCurrency(pr.actual_amount)}</TableCell>
                        <TableCell className="text-right">{fmtCurrency(pr.excluded_amount)}</TableCell>
                        <TableCell className="text-right">{fmtCurrency(Number(pr.actual_amount || 0) - Number(pr.excluded_amount || 0))}</TableCell>
                        <TableCell className="text-right">{fmtCurrency(pr.gross_up_adjustment)}</TableCell>
                        <TableCell className="text-right font-semibold">{fmtCurrency(pr.adjusted_pool)}</TableCell>
                        <TableCell className="text-sm">{participantCountsByPoolId.get(pr.pool_id) ?? 0}</TableCell>
                        <TableCell className="text-xs">{pr.denominator_metrics?.denominator_area ? `${Number(pr.denominator_metrics.denominator_area).toLocaleString()} sqft` : "—"}</TableCell>
                        <TableCell><Link to={`${createPageUrl("CAMPoolDetail")}?cam_run_id=${activeRun?.id}&pool_result_id=${pr.id}`} className="text-xs text-blue-600 underline">Detail</Link></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  // ---- D. Calculation Parameters -----------------------------------------------
  function WorkbenchCalcParamsTab() {
    // Reuses propertyLeaseIds (already building-aware, see its definition
    // near the top of the component) rather than re-deriving property-only
    // -- otherwise a lease correctly excluded from `policies`/`estimateSchedules`
    // by the building filter still shows up here, e.g. as a false "missing
    // policy" for a lease that simply belongs to a different building.
    const propLeases = activeLeases.filter((l) => propertyLeaseIds.includes(l.id));
    const [leaseId, setLeaseId] = useState("");
    React.useEffect(() => {
      if (!leaseId && propLeases.length > 0) setLeaseId(propLeases[0].id);
    }, [propLeases]);

    const leasePolicies = policies.filter((p) => p.lease_id === leaseId && p.status !== "superseded");
    const approvedForLease = leasePolicies.filter((p) => p.status === "approved");
    const hasConflict = policyConflictsByLeaseId.has(leaseId);
    // Auto-select the single applicable policy; never an open pick-any list.
    const applicablePolicy = approvedForLease.length === 1 && !hasConflict ? approvedForLease[0] : null;
    const summ = applicablePolicy ? summarizePolicy(applicablePolicy, applicablePolicy.lease_recovery_policy_steps, categoryNamesById) : null;

    return (
      <div className="space-y-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Select Tenant</CardTitle></CardHeader>
          <CardContent>
            <Select value={leaseId} onValueChange={setLeaseId}>
              <SelectTrigger id="calc-params-lease" className="w-full max-w-md"><SelectValue placeholder="Choose tenant..." /></SelectTrigger>
              <SelectContent>{propLeases.map((l) => <SelectItem key={l.id} value={l.id}>{l.tenant_name ?? l.id.slice(0, 8)}</SelectItem>)}</SelectContent>
            </Select>
          </CardContent>
        </Card>

        {leaseId && approvedForLease.length === 0 && (
          <Card className="border-amber-300 bg-amber-50">
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <p className="text-sm text-amber-900">No approved recovery policy exists for this lease yet — nothing to populate.</p>
              <Link to={createPageUrl("LeaseExpenseRules") + `?lease_id=${leaseId}`} className="text-xs text-blue-600 underline flex items-center gap-1 flex-shrink-0">
                Resolve in Lease Expense Rules <ExternalLink className="w-3 h-3" />
              </Link>
            </CardContent>
          </Card>
        )}

        {leaseId && hasConflict && (
          <Card className="border-red-300 bg-red-50">
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <p className="text-sm text-red-900">This lease has more than one active, conflicting recovery policy — resolve the conflict before parameters can be shown.</p>
              <Button size="sm" variant="outline" onClick={() => { setPolicyConflictLeaseId(leaseId); setAdvancedReadinessOpen(true); }}>Resolve Conflict →</Button>
            </CardContent>
          </Card>
        )}

        {applicablePolicy && summ && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Applicable Calculation Parameters</CardTitle>
              <div className="flex items-center gap-2">
                <Badge className={`text-[10px] ${applicablePolicy.status === "approved" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>{policyStatusLabel(applicablePolicy.status)}</Badge>
                <Link to={createPageUrl("LeaseExpenseRules") + `?lease_id=${leaseId}`}>
                  <Button size="sm" variant="outline" id="btn-edit-calc-params"><ExternalLink className="w-3 h-3 mr-1" /> Edit</Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-slate-500 mb-3">Read-only — populated directly from the approved lease recovery policy. To change a value, edit and re-approve the source lease rule; it will re-materialize here automatically.</p>
              <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
                <div><span className="text-slate-400 text-xs">Category</span><div>{summ.hasCategory ? summ.categoryName : "—"}</div></div>
                <div><span className="text-slate-400 text-xs">Allocation Method / Share</span><div>{summ.shareDescription}</div></div>
                <div><span className="text-slate-400 text-xs">Numerator / Denominator</span><div className="text-xs">{summ.numeratorDenominatorSource}</div></div>
                <div><span className="text-slate-400 text-xs">Gross-Up Target</span><div>{summ.grossUpTarget}</div></div>
                <div><span className="text-slate-400 text-xs">Base Year</span><div>{summ.baseYear}</div></div>
                <div><span className="text-slate-400 text-xs">Expense Stop</span><div>{summ.expenseStop}</div></div>
                <div><span className="text-slate-400 text-xs">Cap</span><div>{summ.cap}</div></div>
                <div><span className="text-slate-400 text-xs">Floor</span><div>{summ.floor}</div></div>
                <div><span className="text-slate-400 text-xs">Deductible</span><div>{summ.deductible}</div></div>
                <div><span className="text-slate-400 text-xs">Admin / Management Fee</span><div>{summ.adminFee}</div></div>
                <div><span className="text-slate-400 text-xs">Effective Dates</span><div>{summ.effectiveFrom} → {summ.effectiveTo || "open"}</div></div>
                <div><span className="text-slate-400 text-xs">Proration</span><div className="text-xs">Daily, per policy step (see Lease Recovery Rules)</div></div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  // ---- E. Calculate CAM --------------------------------------------------------
  function WorkbenchCalculateTab() {
    const openExceptions = runExceptions.filter((e) => e.resolution_status === "open");
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Calculate CAM Preview</CardTitle>
            {activeRun && <RunStatusBadge status={activeRun.status} />}
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-slate-600">
              Runs the authoritative CAM Engine (same engine and edge function used by CAM Runs) against the confirmed pools, participants, policies, expense assignments, and estimates for this property and period. This creates a real, persisted CAM run — nothing is calculated in the browser.
            </p>
            {activeRun && (
              <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4 border-t pt-3">
                <div><span className="text-slate-400 text-xs">Run Type</span><div className="font-medium">{activeRun.run_type}</div></div>
                <div><span className="text-slate-400 text-xs">Engine Version</span><div className="font-mono text-xs">{activeRun.engine_version || "—"}</div></div>
                <div><span className="text-slate-400 text-xs">Created</span><div className="text-xs">{fmtDateTime(activeRun.created_at)}</div></div>
                <div><span className="text-slate-400 text-xs">Last Recalculated</span><div className="text-xs">{fmtDateTime(activeRun.updated_at)}</div></div>
              </div>
            )}
            <Button size="lg" id="btn-calculate-cam-preview" onClick={() => calculateMutation.mutate()} disabled={calculateMutation.isPending || !propertyId || !periodId}>
              {calculateMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Calculator className="w-4 h-4 mr-2" />}
              {activeRun?.status === "calculated" ? "Recalculate CAM Preview" : "Calculate CAM Preview"}
            </Button>
            {openExceptions.length > 0 && (
              <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 p-2.5 rounded border border-amber-200">
                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                <span>{openExceptions.length} unresolved exception(s) on this run.</span>
                {activeRun && <Link to={`${createPageUrl("CAMExceptionReview")}?cam_run_id=${activeRun.id}`} className="underline text-xs ml-1">Review →</Link>}
              </div>
            )}
            <p className="text-xs text-slate-400">
              Need to submit for review, approve, or post this run? Continue in{" "}
              <Link to={`${createPageUrl("CAMRun")}?property_id=${propertyId}&recovery_period_id=${periodId}`} className="text-blue-600 underline">CAM Runs →</Link>
            </p>
          </CardContent>
        </Card>

        {workbenchRuns.length > 1 && (
          <Card>
            <CardHeader><CardTitle className="text-base">Run History ({workbenchRuns.length})</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Status</TableHead><TableHead>Type</TableHead><TableHead>Created</TableHead></TableRow></TableHeader>
                <TableBody>
                  {workbenchRuns.map((r) => (
                    <TableRow key={r.id} className={r.id === activeRun?.id ? "bg-blue-50" : ""}>
                      <TableCell><RunStatusBadge status={r.status} /></TableCell>
                      <TableCell className="text-sm">{r.run_type}</TableCell>
                      <TableCell className="text-sm">{fmtDateTime(r.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  // ---- F. Tenant Results -------------------------------------------------------
  function WorkbenchResultsTab() {
    if (!activeRun) {
      return <p className="text-sm text-slate-500 py-8 text-center">No CAM run yet for this property and period. Use Calculate CAM to produce results.</p>;
    }
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Recovery by Pool ({poolResults.length})</CardTitle></CardHeader>
          <CardContent>
            {poolResults.length === 0 ? <p className="text-sm text-slate-400 py-4 text-center">No pool results.</p> : (
              <Table>
                <TableHeader><TableRow><TableHead>Pool</TableHead><TableHead className="text-right">Adjusted Pool</TableHead><TableHead className="text-right">Gross-Up Adj.</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>
                  {poolResults.map((pr) => (
                    <TableRow key={pr.id}>
                      <TableCell className="font-medium text-sm">{pr.recovery_pools?.name || pr.pool_id.slice(0, 8)}</TableCell>
                      <TableCell className="text-right text-sm font-semibold">{fmtCurrency(pr.adjusted_pool)}</TableCell>
                      <TableCell className="text-right text-sm">{fmtCurrency(pr.gross_up_adjustment)}</TableCell>
                      <TableCell className="text-right"><Link to={`${createPageUrl("CAMPoolDetail")}?cam_run_id=${activeRun.id}&pool_result_id=${pr.id}`} className="text-xs text-blue-600 underline">Explanation →</Link></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Recovery by Tenant ({leaseResults.length})</CardTitle></CardHeader>
          <CardContent>
            {leaseResults.length === 0 ? <p className="text-sm text-slate-400 py-4 text-center">No lease results.</p> : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tenant</TableHead><TableHead className="text-right">Gross Recovery (Final)</TableHead>
                      <TableHead className="text-right">Estimates Charged</TableHead><TableHead className="text-right">Due / (Credit)</TableHead>
                      <TableHead>Status</TableHead><TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {leaseResults.map((lr) => (
                      <TableRow key={lr.id}>
                        <TableCell className="font-medium text-sm">{lr.leases?.tenant_name || lr.lease_id.slice(0, 8)}</TableCell>
                        <TableCell className="text-right text-sm">{fmtCurrency(lr.final_recovery)}</TableCell>
                        <TableCell className="text-right text-sm">{fmtCurrency(lr.estimates_billed)}</TableCell>
                        <TableCell className={`text-right text-sm font-semibold ${Number(lr.amount_due_credit) < 0 ? "text-emerald-700" : Number(lr.amount_due_credit) > 0 ? "text-amber-700" : ""}`}>{fmtCurrency(lr.amount_due_credit)}</TableCell>
                        <TableCell><Badge className="text-[10px]">{lr.status}</Badge></TableCell>
                        <TableCell><Link to={`${createPageUrl("CAMLeaseDetail")}?cam_run_id=${activeRun.id}&lease_result_id=${lr.id}`} className="text-xs text-blue-600 underline">Explanation →</Link></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---- G. Monthly Estimates & Variance ------------------------------------------
  function WorkbenchVarianceTab() {
    // Reuses propertyLeaseIds (already building-aware, see its definition
    // near the top of the component) rather than re-deriving property-only
    // -- otherwise a lease correctly excluded from `policies`/`estimateSchedules`
    // by the building filter still shows up here, e.g. as a false "missing
    // policy" for a lease that simply belongs to a different building.
    const propLeases = activeLeases.filter((l) => propertyLeaseIds.includes(l.id));
    const varianceRows = useMemo(() => {
      return propLeases.map((l) => {
        const annualEstimate = estimateSchedules.filter((es) => es.lease_id === l.id).reduce((s, es) => s + Number(es.amount || 0), 0);
        const leaseResult = leaseResults.find((lr) => lr.lease_id === l.id);
        const annualCalculated = leaseResult ? Number(leaseResult.final_recovery || 0) : null;
        return {
          leaseId: l.id,
          tenantName: l.tenant_name || l.id.slice(0, 8),
          annualEstimate,
          annualCalculated,
          variance: annualCalculated != null ? annualCalculated - annualEstimate : null,
        };
      }).filter((r) => r.annualEstimate > 0 || r.annualCalculated != null);
    }, [propLeases, estimateSchedules, leaseResults]);

    // Monthly figures are a reporting ALLOCATION of the engine's real annual
    // final_recovery, spread across months in proportion to what was
    // actually billed that month -- not a re-run of the calculation. The
    // engine's own authoritative number (and its rounding policy) is
    // annualCalculated above; this table never overrides it, only slices it
    // for month-by-month reporting per the annual-vs-monthly display rule.
    const monthlyRows = useMemo(() => {
      const rows = [];
      for (const l of propLeases) {
        const leaseEstimates = estimateSchedules.filter((es) => es.lease_id === l.id).sort((a, b) => a.month_date.localeCompare(b.month_date));
        if (leaseEstimates.length === 0) continue;
        const annualEstimate = leaseEstimates.reduce((s, es) => s + Number(es.amount || 0), 0);
        const leaseResult = leaseResults.find((lr) => lr.lease_id === l.id);
        const annualCalculated = leaseResult ? Number(leaseResult.final_recovery || 0) : null;
        let cumulative = 0;
        for (const es of leaseEstimates) {
          const monthlyEstimate = Number(es.amount || 0);
          const allocated = annualCalculated != null && annualEstimate > 0 ? annualCalculated * (monthlyEstimate / annualEstimate) : null;
          const variance = allocated != null ? allocated - monthlyEstimate : null;
          if (variance != null) cumulative += variance;
          rows.push({
            key: es.id, tenantName: l.tenant_name || l.id.slice(0, 8), month: es.month_date,
            monthlyEstimate, allocated, variance, cumulative: variance != null ? cumulative : null,
          });
        }
      }
      return rows;
    }, [propLeases, estimateSchedules, leaseResults]);

    return (
      <div className="space-y-6">
        <Step6 />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Annual Estimate vs. Calculated Recovery</CardTitle>
            <p className="text-xs text-slate-500 font-normal">
              Compares the sum of monthly estimates charged against the engine's authoritative annual calculated recovery for this run. The engine computes and rounds annually (per this run's rounding policy) — monthly figures above are the estimate schedule as billed, not a recalculated monthly split.
            </p>
          </CardHeader>
          <CardContent>
            {varianceRows.length === 0 ? <p className="text-sm text-slate-400 py-4 text-center">No estimates or calculated results yet for this period.</p> : (
              <Table>
                <TableHeader><TableRow><TableHead>Tenant</TableHead><TableHead className="text-right">Annual Estimate Total</TableHead><TableHead className="text-right">Annual Calculated Recovery</TableHead><TableHead className="text-right">Annual Variance</TableHead></TableRow></TableHeader>
                <TableBody>
                  {varianceRows.map((r) => (
                    <TableRow key={r.leaseId}>
                      <TableCell className="font-medium text-sm">{r.tenantName}</TableCell>
                      <TableCell className="text-right text-sm">{fmtCurrency(r.annualEstimate)}</TableCell>
                      <TableCell className="text-right text-sm">{r.annualCalculated != null ? fmtCurrency(r.annualCalculated) : "Not yet calculated"}</TableCell>
                      <TableCell className={`text-right text-sm font-semibold ${r.variance == null ? "" : r.variance > 0 ? "text-amber-700" : r.variance < 0 ? "text-emerald-700" : ""}`}>{r.variance != null ? fmtCurrency(r.variance) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Monthly Allocated CAM &amp; Variance</CardTitle>
            <p className="text-xs text-slate-500 font-normal">Each month's calculated CAM is the annual calculated recovery allocated in proportion to that month's billed estimate — a reporting view, not a separate calculation.</p>
          </CardHeader>
          <CardContent>
            {monthlyRows.length === 0 ? <p className="text-sm text-slate-400 py-4 text-center">No monthly estimate schedule yet for this period.</p> : (
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>Tenant</TableHead><TableHead>Month</TableHead><TableHead className="text-right">Monthly Estimate</TableHead><TableHead className="text-right">Monthly Allocated CAM</TableHead><TableHead className="text-right">Monthly Variance</TableHead><TableHead className="text-right">Cumulative Variance</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {monthlyRows.map((r) => (
                      <TableRow key={r.key}>
                        <TableCell className="text-sm">{r.tenantName}</TableCell>
                        <TableCell className="text-sm">{r.month}</TableCell>
                        <TableCell className="text-right text-sm">{fmtCurrency(r.monthlyEstimate)}</TableCell>
                        <TableCell className="text-right text-sm">{r.allocated != null ? fmtCurrency(r.allocated) : "—"}</TableCell>
                        <TableCell className={`text-right text-sm ${r.variance == null ? "" : r.variance > 0 ? "text-amber-700" : "text-emerald-700"}`}>{r.variance != null ? fmtCurrency(r.variance) : "—"}</TableCell>
                        <TableCell className={`text-right text-sm font-medium ${r.cumulative == null ? "" : r.cumulative > 0 ? "text-amber-700" : "text-emerald-700"}`}>{r.cumulative != null ? fmtCurrency(r.cumulative) : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---- H. Reconciliation — Who Pays --------------------------------------------
  function WorkbenchReconciliationTab() {
    if (!activeRun || leaseResults.length === 0) {
      return <p className="text-sm text-slate-500 py-8 text-center">No calculated results yet — use Calculate CAM to produce a reconciliation.</p>;
    }
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Reconciliation — Who Pays</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead><TableHead className="text-right">Calculated Recovery</TableHead>
                  <TableHead className="text-right">Estimates Charged</TableHead><TableHead className="text-right">Prior Adjustments</TableHead>
                  <TableHead className="text-right">Final Amount</TableHead><TableHead>Payment Direction</TableHead>
                  <TableHead>Status</TableHead><TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {leaseResults.map((lr) => {
                  const priorAdj = priorAdjustments.filter((a) => a.lease_id === lr.lease_id && a.state === "KNOWN_AMOUNT").reduce((s, a) => s + Number(a.amount || 0), 0);
                  return (
                    <TableRow key={lr.id}>
                      <TableCell className="font-medium text-sm">{lr.leases?.tenant_name || lr.lease_id.slice(0, 8)}</TableCell>
                      <TableCell className="text-right text-sm">{fmtCurrency(lr.final_recovery)}</TableCell>
                      <TableCell className="text-right text-sm">{fmtCurrency(lr.estimates_billed)}</TableCell>
                      <TableCell className="text-right text-sm">{priorAdj !== 0 ? fmtCurrency(priorAdj) : "—"}</TableCell>
                      <TableCell className="text-right text-sm font-bold">{fmtCurrency(lr.amount_due_credit)}</TableCell>
                      <TableCell><Badge className={`text-[10px] font-medium ${paymentDirectionTone(lr.amount_due_credit)}`}>{paymentDirectionLabel(lr.amount_due_credit)}</Badge></TableCell>
                      <TableCell><Badge className="text-[10px]">{lr.status}</Badge></TableCell>
                      <TableCell>
                        <Link to={`${createPageUrl("CAMRun")}?property_id=${propertyId}&recovery_period_id=${periodId}&cam_run_id=${activeRun.id}`} className="text-xs text-blue-600 underline">
                          Statement / Export →
                        </Link>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-slate-400 mt-3">
            A charge is only considered billed once confirmed through the CAM Runs statement/export workflow (posted run required) — this table shows the calculated reconciliation, not billing confirmation.
          </p>
        </CardContent>
      </Card>
    );
  }

  // ---- KPI stat rows: pure aggregation over data already queried above for
  // this same tab's table (no new queries, nothing computed that isn't
  // already on screen below it) -- purely a summary strip, matching the
  // reference dashboard's stat-card layout.
  function ExpensesStatRow() {
    const total = publishedExpenses.reduce((s, e) => s + Number(e.amount || 0), 0);
    const assigned = publishedExpenses.reduce((s, e) => s + (e.cam_input_pool_assignments || []).reduce((a, x) => a + Number(x.amount || 0), 0), 0);
    const unassigned = Math.max(0, total - assigned);
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total Published Expenses" value={fmtCurrency(total)} />
        <StatCard label="Assigned to Pools" value={fmtCurrency(assigned)} accent="border-emerald-400" />
        <StatCard label="Unassigned / Needs Review" value={fmtCurrency(unassigned)} accent={unassigned > 0 ? "border-amber-400" : undefined} />
        <StatCard label="Line Items" value={publishedExpenses.length} />
      </div>
    );
  }

  function PoolStatRow() {
    const assigned = poolResults.reduce((s, p) => s + Number(p.actual_amount || 0), 0);
    const excluded = poolResults.reduce((s, p) => s + Number(p.excluded_amount || 0), 0);
    const adjusted = poolResults.reduce((s, p) => s + Number(p.adjusted_pool || 0), 0);
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Recovery Pools" value={pools.length} />
        <StatCard label="Assigned Amount" value={fmtCurrency(assigned)} />
        <StatCard label="Excluded Amount" value={fmtCurrency(excluded)} accent={excluded > 0 ? "border-amber-400" : undefined} />
        <StatCard label="Adjusted Pool Total" value={fmtCurrency(adjusted)} accent="border-emerald-400" />
      </div>
    );
  }

  function ResultsStatRow() {
    const totalRecovery = leaseResults.reduce((s, l) => s + Number(l.final_recovery || 0), 0);
    const totalDue = leaseResults.reduce((s, l) => s + Math.max(0, Number(l.amount_due_credit || 0)), 0);
    const totalCredit = leaseResults.reduce((s, l) => s + Math.max(0, -Number(l.amount_due_credit || 0)), 0);
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard label="Total CAM Recovery" value={fmtCurrency(totalRecovery)} />
        <StatCard label="Total Due (from Tenants)" value={fmtCurrency(totalDue)} accent={totalDue > 0 ? "border-amber-400" : undefined} />
        <StatCard label="Total Credits (to Tenants)" value={fmtCurrency(totalCredit)} accent={totalCredit > 0 ? "border-emerald-400" : undefined} />
        <StatCard label="Tenants" value={leaseResults.length} />
        <Card><CardContent className="p-3">
          <Donut
            centerValue={fmtCurrency(totalDue + totalCredit)}
            centerLabel="Total Recovery"
            segments={[{ value: totalDue, color: "#f59e0b" }, { value: totalCredit, color: "#10b981" }]}
          />
        </CardContent></Card>
      </div>
    );
  }

  function ReconciliationStatRow() {
    const owed = leaseResults.reduce((s, l) => s + Math.max(0, Number(l.amount_due_credit || 0)), 0);
    const credit = leaseResults.reduce((s, l) => s + Math.max(0, -Number(l.amount_due_credit || 0)), 0);
    const tenantsOwe = leaseResults.filter((l) => Number(l.amount_due_credit || 0) > 0).length;
    const tenantsCredited = leaseResults.filter((l) => Number(l.amount_due_credit || 0) < 0).length;
    const noAction = leaseResults.length - tenantsOwe - tenantsCredited;
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard label="Net Amount Due from Tenants" value={fmtCurrency(owed)} accent="border-amber-400" />
        <StatCard label="Total Credits to Tenants" value={fmtCurrency(credit)} accent="border-emerald-400" />
        <StatCard label="Tenants Owing" value={tenantsOwe} />
        <StatCard label="Tenants to Credit" value={tenantsCredited} />
        <Card><CardContent className="p-3">
          <Donut
            centerValue={leaseResults.length}
            centerLabel="Tenants"
            segments={[
              { value: tenantsOwe, color: "#f59e0b" },
              { value: tenantsCredited, color: "#10b981" },
              { value: noAction, color: "#e2e8f0" },
            ]}
          />
        </CardContent></Card>
      </div>
    );
  }

  const WORKBENCH_TABS = [
    { value: "expenses", label: "CAM Expenses", icon: DollarSign },
    { value: "policies", label: "Lease Recovery Rules", icon: ClipboardList },
    { value: "pools", label: "Pool Calculation", icon: Boxes },
    { value: "parameters", label: "Calculation Parameters", icon: Settings2 },
    { value: "calculate", label: "Calculate CAM", icon: Calculator },
    { value: "results", label: "Tenant Results", icon: LayoutGrid },
    { value: "variance", label: "Monthly Estimates & Variance", icon: TrendingUp },
    { value: "reconciliation", label: "Reconciliation", icon: HandCoins },
  ];

  function ReconciliationWorkbench() {
    if (!propertyId) {
      return <Card><CardContent className="py-12 text-center text-sm text-slate-400">Select a property above to begin.</CardContent></Card>;
    }
    if (!periodId) {
      return (
        <div className="space-y-4">
          <Card><CardContent className="py-8 text-center text-sm text-slate-400">Select or create a recovery period to begin.</CardContent></Card>
          <Step1 />
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <WorkbenchReadinessBanner />
        <Tabs value={workbenchTab} onValueChange={setWorkbenchTab} className="space-y-4">
          <TabsList id="workbench-tabs" className="flex-wrap h-auto">
            {WORKBENCH_TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="gap-1.5"><t.icon className="w-3.5 h-3.5" />{t.label}</TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="expenses" className="space-y-4"><ExpensesStatRow /><WorkbenchExpensesTab /></TabsContent>
          <TabsContent value="policies"><Step4 /></TabsContent>
          <TabsContent value="pools" className="space-y-4"><PoolStatRow /><WorkbenchPoolCalculationTab /></TabsContent>
          <TabsContent value="parameters"><WorkbenchCalcParamsTab /></TabsContent>
          <TabsContent value="calculate"><WorkbenchCalculateTab /></TabsContent>
          <TabsContent value="results" className="space-y-4"><ResultsStatRow /><WorkbenchResultsTab /></TabsContent>
          <TabsContent value="variance"><WorkbenchVarianceTab /></TabsContent>
          <TabsContent value="reconciliation" className="space-y-4"><ReconciliationStatRow /><WorkbenchReconciliationTab /></TabsContent>
        </Tabs>
      </div>
    );
  }

  // ---- Step renderer --------------------------------------------------------
  const stepComponents = [null, Step1, Step2, Step3, Step4, Step5, Step6, Step7];
  const StepComponent = stepComponents[step];

  return (
    <div className="space-y-4 p-4 lg:p-6">
      {workbenchView ? (
        <PageHeader
          icon={Calculator}
          title="CAM Reconciliation Workbench"
          subtitle="Select scope and period, review expenses and recovery rules, calculate CAM, and see who owes what"
        />
      ) : (
        <PageHeader title="CAM Setup — Advanced" subtitle="Guided, step-by-step technical configuration" />
      )}

      {/* Requirement 1: persistent scope bar — shared by both views */}
      <Card className="sticky top-0 z-10 border-slate-300 shadow-sm">
        <CardContent className="p-3">
          <div className="flex flex-wrap items-center gap-2">
            <ScopeSelector
              portfolios={portfolios}
              properties={properties}
              buildings={buildings}
              units={scopeUnits}
              selectedProperty={propertyId || "all"}
              selectedBuilding={buildingId || "all"}
              selectedUnit={unitId || "all"}
              onPropertyChange={(value) => setPropertyId(value === "all" ? "" : value)}
              onBuildingChange={(value) => setBuildingId(value === "all" ? "" : value)}
              onUnitChange={(value) => setUnitId(value === "all" ? "" : value)}
              syncToUrl
              queryParamNames={{ portfolio: "portfolio_id", property: "property_id", building: "building_id", unit: "unit_id" }}
            />
            <Select value={activeCalendar?.id || ""} disabled>
              <SelectTrigger id="scope-calendar" className="w-40"><SelectValue placeholder="Calendar" /></SelectTrigger>
              <SelectContent>{activeCalendar && <SelectItem value={activeCalendar.id}>{activeCalendar.name}</SelectItem>}</SelectContent>
            </Select>
            <Select value={periodId} onValueChange={selectRecoveryPeriod} disabled={!activeCalendar}>
              <SelectTrigger id="scope-period" className="w-44"><SelectValue placeholder="Period..." /></SelectTrigger>
              <SelectContent>
                {periodSelectOptions.map((option) => (
                  <SelectItem key={option.key} value={option.value}>{option.label}{option.existing ? "" : " (create)"}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {propertyId && periodId && (
              <div id="scope-readiness-badge" className="ml-auto flex items-center gap-2">
                <StatusBadge ready={readiness.ready} />
                {!readiness.ready && readiness.blockingCount > 0 && <span className="text-xs text-red-600">{readiness.blockingCount} blocking</span>}
              </div>
            )}
            <Button
              size="sm"
              variant="outline"
              className="border-amber-300 bg-amber-50/50 text-amber-800 hover:bg-amber-100 text-xs font-semibold"
              disabled={!propertyId || !periodId || resetAndReimportMutation.isPending}
              onClick={() => {
                if (window.confirm("Are you sure you want to clear existing CAM pools, participants, and pool assignments for this property/period and re-import fresh from Leases and Expenses?")) {
                  resetAndReimportMutation.mutate();
                }
              }}
              title="Clear pools and pool assignments for this property/period and re-import fresh source data"
            >
              {resetAndReimportMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin text-amber-600" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 mr-1 text-amber-600" />
              )}
              Reset & Re-Import
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="border-blue-300 bg-blue-50/50 text-blue-800 hover:bg-blue-100 text-xs font-semibold"
              disabled={!propertyId || !periodId || prepareCamMutation.isPending}
              onClick={() => prepareCamMutation.mutate()}
              title="Run automatic CAM preparation to bring in latest leases, approved rules, and finalized expenses"
            >
              {prepareCamMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin text-blue-600" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 mr-1 text-blue-600" />
              )}
              Re-Sync Source Data
            </Button>
            <Button
              size="sm"
              variant="outline"
              id="btn-toggle-advanced-setup"
              onClick={() => setWorkbenchView(!workbenchView)}
              title={workbenchView ? "Open the detailed 7-step technical configuration" : "Return to the Reconciliation Workbench"}
            >
              {workbenchView ? <><Settings2 className="w-3.5 h-3.5 mr-1" /> Advanced Setup</> : <><LayoutGrid className="w-3.5 h-3.5 mr-1" /> Back to Workbench</>}
            </Button>
          </div>
        </CardContent>
      </Card>

      <PrepareCamResultDialog />

      {workbenchView ? (
        <>
          <ReconciliationWorkbench />
          <WorkbenchAdvancedReadinessDrawer />
        </>
      ) : (
        <>
          {/* Step progress bar — unchanged from the original 7-step wizard */}
          <div className="flex items-center gap-1 overflow-x-auto pb-2">
            {STEPS.map((s, idx) => {
              const Icon = s.icon;
              const isActive = s.id === step;
              const isDone = s.id < step;
              return (
                <React.Fragment key={s.id}>
                  <button id={`step-tab-${s.id}`} onClick={() => setStep(s.id)}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors
                      ${isActive ? "bg-blue-600 text-white" : isDone ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>
                    <Icon className="w-3.5 h-3.5" /> {s.label}
                  </button>
                  {idx < STEPS.length - 1 && <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0" />}
                </React.Fragment>
              );
            })}
          </div>

          <div className="min-h-[300px]">{StepComponent && <StepComponent />}</div>

          <div className="flex justify-between pt-2 border-t">
            <Button variant="outline" onClick={() => setStep(step - 1)} disabled={!canGoBack} id="btn-step-back">
              <ChevronLeft className="w-4 h-4 mr-1" /> Back
            </Button>
            <Button onClick={() => setStep(step + 1)} disabled={!canProceed} id="btn-step-next">
              Next <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
