/**
 * BudgetPlanningPanel — Phase 4A: Next-Year Planning Budget Assembly
 *
 * Three-step panel that drives the planning-source budget generation flow:
 *   Step 1: Expense Basis (compute-budget-basis, Phase 3A)
 *   Step 2: CAM Recovery Estimate (compute-budget-cam-estimate, Phase 3B)
 *   Step 3: Revenue Baseline (compute-revenue — base_rent + other_income only,
 *            explicitly excludes cam_recovery to prevent double-counting)
 *
 * Once all three snapshot IDs are in state the Assembly Preview is displayed
 * and "Create Planning Budget" is enabled.  The button calls
 * compute-budget(action='generate') in planning_source mode, passing the
 * exact snapshot IDs returned by each call — never "latest snapshot" alone.
 *
 * No financial math is performed in this component.  All totals come from
 * server responses and validated snapshots.
 */
import React, { useState, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Calculator, TrendingUp, DollarSign, CheckCircle2, Loader2, AlertTriangle,
  ChevronDown, ChevronUp, RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { createPageUrl } from "@/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

// ─── Formatters ──────────────────────────────────────────────────────────────

const FMT = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
});
const FMT_SIGN = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
  signDisplay: "exceptZero",
});

function fmt(v) { return FMT.format(Number(v) || 0); }
function fmtSign(v) { return FMT_SIGN.format(Number(v) || 0); }
function n(v) { return Number(v) || 0; }

// ─── Step status helpers ──────────────────────────────────────────────────────

function StepBadge({ status }) {
  if (status === "done")
    return <Badge className="text-[10px] bg-emerald-100 text-emerald-700 border-emerald-200">Done</Badge>;
  if (status === "running")
    return <Badge className="text-[10px] bg-blue-100 text-blue-700 border-blue-200 animate-pulse">Running…</Badge>;
  if (status === "error")
    return <Badge className="text-[10px] bg-red-100 text-red-700 border-red-200">Error</Badge>;
  return <Badge className="text-[10px] bg-slate-100 text-slate-500 border-slate-200">Pending</Badge>;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PhaseCard({ stepNumber, title, description, status, error, children, action }) {
  const isDone = status === "done";
  return (
    <Card className={`border transition-colors duration-200 ${
      isDone ? "border-emerald-200 bg-emerald-50/30" : "border-slate-200"
    }`}>
      <CardHeader className="pb-2 flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex items-start gap-3">
          <div className={`mt-0.5 h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
            isDone ? "bg-emerald-500 text-white" : "bg-slate-100 text-slate-600"
          }`}>
            {isDone ? <CheckCircle2 className="h-4 w-4" /> : stepNumber}
          </div>
          <div>
            <CardTitle className="text-sm font-semibold">{title}</CardTitle>
            <p className="text-xs text-slate-500 mt-0.5">{description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StepBadge status={status} />
          {action}
        </div>
      </CardHeader>
      {error && (
        <CardContent className="pt-0 pb-3">
          <div className="rounded-md bg-red-50 border border-red-200 p-3 flex gap-2 text-xs text-red-700">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        </CardContent>
      )}
      {children && (
        <CardContent className="pt-0 pb-3">
          {children}
        </CardContent>
      )}
    </Card>
  );
}

function CategoryExpenseTable({ categories }) {
  const [expanded, setExpanded] = useState(false);
  if (!categories?.length) return null;
  const visible = expanded ? categories : categories.slice(0, 5);
  return (
    <div className="mt-3">
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50 hover:bg-slate-50">
              <TableHead className="text-[10px] uppercase tracking-wide py-2">Category</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wide py-2">Basis</TableHead>
              <TableHead className="text-right text-[10px] uppercase tracking-wide py-2">Prior Year</TableHead>
              <TableHead className="text-right text-[10px] uppercase tracking-wide py-2">Annual Budget</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((cat, i) => (
              <TableRow key={cat.expense_category_id || cat.normalized_key || i}>
                <TableCell className="text-xs font-medium py-1.5">
                  {cat.category_label || cat.normalized_key || "Other"}
                </TableCell>
                <TableCell className="text-xs text-slate-500 py-1.5">
                  {cat.baseline_type || "—"}
                </TableCell>
                <TableCell className="text-right text-xs font-mono py-1.5">
                  {cat.prior_year_actual != null ? fmt(cat.prior_year_actual) : "—"}
                </TableCell>
                <TableCell className="text-right text-xs font-mono font-semibold py-1.5">
                  {fmt(cat.annual_budget)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {categories.length > 5 && (
        <button
          className="mt-1.5 text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {expanded ? "Show less" : `Show ${categories.length - 5} more categories`}
        </button>
      )}
    </div>
  );
}

function TenantRecoveryTable({ tenants }) {
  if (!tenants?.length) return null;
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
      <Table>
        <TableHeader>
          <TableRow className="bg-slate-50 hover:bg-slate-50">
            <TableHead className="text-[10px] uppercase tracking-wide py-2">Tenant</TableHead>
            <TableHead className="text-right text-[10px] uppercase tracking-wide py-2">Pro-Rata %</TableHead>
            <TableHead className="text-right text-[10px] uppercase tracking-wide py-2">Est. Recovery</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tenants.map((t, i) => (
            <TableRow key={t.lease_id || t.tenant_name || i}>
              <TableCell className="text-xs font-medium py-1.5">{t.tenant_name || t.lease_id || "—"}</TableCell>
              <TableCell className="text-right text-xs py-1.5">
                {t.pro_rata_share != null ? `${(n(t.pro_rata_share) * 100).toFixed(2)}%` : "—"}
              </TableCell>
              <TableCell className="text-right text-xs font-mono font-semibold py-1.5">
                {t.estimated_annual_recovery != null ? fmt(t.estimated_annual_recovery) : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function AssemblyPreview({ baseRent, otherIncome, estimatedCamRecovery, totalExpenses, fiscalYear }) {
  const totalRevenue = n(baseRent) + n(otherIncome) + n(estimatedCamRecovery);
  const noi = totalRevenue - n(totalExpenses);
  const noiPositive = noi >= 0;

  return (
    <Card className="border-2 border-indigo-200 bg-gradient-to-br from-indigo-50 to-white shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-indigo-900 flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-indigo-600" />
          Planning Budget Preview — FY {fiscalYear}
        </CardTitle>
        <p className="text-xs text-indigo-600 font-medium">
          Assembled from Phase 3A expense basis + Phase 3B CAM estimate + approved revenue data.
          CAM recovery appears only once (Phase 3B estimate, not actual posted CAM).
        </p>
      </CardHeader>
      <CardContent className="space-y-1 pb-5">
        {/* Revenue section */}
        <div className="rounded-lg bg-white border border-slate-200 overflow-hidden">
          <div className="bg-teal-50 px-4 py-2 border-b border-slate-200">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-teal-700">Revenue</p>
          </div>
          <div className="divide-y divide-slate-100">
            <div className="flex justify-between px-4 py-2 text-xs">
              <span className="text-slate-600">Base Rent</span>
              <span className="font-mono">{fmt(baseRent)}</span>
            </div>
            <div className="flex justify-between px-4 py-2 text-xs">
              <span className="text-slate-600">Est. CAM Recovery (Phase 3B)</span>
              <span className="font-mono">{fmt(estimatedCamRecovery)}</span>
            </div>
            {n(otherIncome) > 0 && (
              <div className="flex justify-between px-4 py-2 text-xs">
                <span className="text-slate-600">Other Income</span>
                <span className="font-mono">{fmt(otherIncome)}</span>
              </div>
            )}
            <div className="flex justify-between px-4 py-2.5 text-sm font-semibold bg-teal-50/50">
              <span className="text-teal-800">Total Revenue</span>
              <span className="font-mono text-teal-800">{fmt(totalRevenue)}</span>
            </div>
          </div>
        </div>

        {/* Expenses section */}
        <div className="rounded-lg bg-white border border-slate-200 overflow-hidden">
          <div className="bg-rose-50 px-4 py-2 border-b border-slate-200">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-rose-700">Expenses (Phase 3A Basis)</p>
          </div>
          <div className="flex justify-between px-4 py-2.5 text-sm font-semibold">
            <span className="text-rose-800">Total Expenses</span>
            <span className="font-mono text-rose-800">{fmt(totalExpenses)}</span>
          </div>
        </div>

        {/* NOI */}
        <div className={`rounded-lg border-2 px-4 py-3.5 flex justify-between items-center ${
          noiPositive ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"
        }`}>
          <div>
            <p className={`text-xs font-semibold uppercase tracking-wide ${noiPositive ? "text-emerald-700" : "text-red-700"}`}>
              Net Operating Income (Planning)
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">
              Revenue − Expenses = NOI
            </p>
          </div>
          <span className={`text-xl font-bold font-mono ${noiPositive ? "text-emerald-700" : "text-red-700"}`}>
            {fmtSign(noi)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function BudgetPlanningPanel({ propertyId, fiscalYear }) {
  const navigate = useNavigate();
  const location = useLocation();

  // Step 1 — Phase 3A expense basis
  const [basisStatus, setBasisStatus] = useState("idle"); // idle | running | done | error
  const [basisError, setBasisError] = useState(null);
  const [basisSnapshotId, setBasisSnapshotId] = useState(null);
  const [basisOutputs, setBasisOutputs] = useState(null); // { totals, categories }

  // Step 2 — Phase 3B CAM estimate
  const [camEstStatus, setCamEstStatus] = useState("idle");
  const [camEstError, setCamEstError] = useState(null);
  const [camEstSnapshotId, setCamEstSnapshotId] = useState(null);
  const [camEstOutputs, setCamEstOutputs] = useState(null); // { property_summary, tenant_recoveries }

  // Step 3 — Revenue baseline
  const [revenueStatus, setRevenueStatus] = useState("idle");
  const [revenueError, setRevenueError] = useState(null);
  const [revenueSnapshotId, setRevenueSnapshotId] = useState(null);
  const [revenueOutputs, setRevenueOutputs] = useState(null); // { summary }

  // Budget creation
  const [creating, setCreating] = useState(false);

  const canRunCamEst = basisStatus === "done" && !!basisSnapshotId;
  const canAssemble =
    basisStatus === "done" && basisSnapshotId &&
    camEstStatus === "done" && camEstSnapshotId &&
    revenueStatus === "done" && revenueSnapshotId;

  // ── Step 1: Run Phase 3A expense basis ───────────────────────────
  const runExpenseBasis = useCallback(async () => {
    if (!propertyId) { toast.error("Select a property first."); return; }
    if (!fiscalYear) { toast.error("Select a fiscal year first."); return; }
    setBasisStatus("running");
    setBasisError(null);
    // Reset downstream when re-running Phase 3A
    setCamEstStatus("idle"); setCamEstSnapshotId(null); setCamEstOutputs(null);
    try {
      const result = await invokeEdgeFunction("compute-budget-basis", {
        property_id: propertyId,
        fiscal_year: fiscalYear,
      });
      if (result?.error) throw new Error(result.message || "Phase 3A failed");
      // Store the exact snapshot ID returned — do NOT re-query "latest"
      const snapshotId = result.budget_basis_id || result.snapshot_id;
      if (!snapshotId) throw new Error("Phase 3A response missing snapshot ID");
      setBasisSnapshotId(snapshotId);
      setBasisOutputs(result);
      setBasisStatus("done");
      toast.success("Expense basis calculated.");
    } catch (err) {
      setBasisError(err.message || "Expense basis calculation failed.");
      setBasisStatus("error");
      toast.error(err.message || "Expense basis calculation failed.");
    }
  }, [propertyId, fiscalYear]);

  // ── Step 2: Run Phase 3B CAM estimate ────────────────────────────
  const runCamEstimate = useCallback(async () => {
    if (!canRunCamEst) return;
    setCamEstStatus("running");
    setCamEstError(null);
    try {
      const result = await invokeEdgeFunction("compute-budget-cam-estimate", {
        property_id: propertyId,
        fiscal_year: fiscalYear,
      });
      if (result?.error) throw new Error(result.message || "Phase 3B failed");
      const snapshotId = result.budget_cam_estimate_id || result.snapshot_id;
      if (!snapshotId) throw new Error("Phase 3B response missing snapshot ID");
      // Verify Phase 3B was derived from the same Phase 3A basis
      const recordedBasisId = result.budget_basis_snapshot_id || result.inputs?.budget_basis_snapshot_id;
      if (recordedBasisId && recordedBasisId !== basisSnapshotId) {
        throw new Error(
          `Lineage mismatch: Phase 3B was derived from a different expense basis. ` +
          `Re-run Phase 3B after running Phase 3A, or re-run Phase 3A first.`,
        );
      }
      setCamEstSnapshotId(snapshotId);
      setCamEstOutputs(result);
      setCamEstStatus("done");
      toast.success("CAM recovery estimate calculated.");
    } catch (err) {
      setCamEstError(err.message || "CAM estimate calculation failed.");
      setCamEstStatus("error");
      toast.error(err.message || "CAM estimate calculation failed.");
    }
  }, [canRunCamEst, propertyId, fiscalYear, basisSnapshotId]);

  // ── Step 3: Revenue baseline ─────────────────────────────────────
  const runRevenue = useCallback(async () => {
    if (!propertyId) { toast.error("Select a property first."); return; }
    if (!fiscalYear) { toast.error("Select a fiscal year first."); return; }
    setRevenueStatus("running");
    setRevenueError(null);
    try {
      const result = await invokeEdgeFunction("compute-revenue", {
        property_id: propertyId,
        fiscal_year: fiscalYear,
      });
      if (result?.error) throw new Error(result.message || "Revenue calculation failed");
      const snapshotId = result.snapshot_id;
      if (!snapshotId) throw new Error("Revenue response missing snapshot ID");
      setRevenueSnapshotId(snapshotId);
      setRevenueOutputs(result);
      setRevenueStatus("done");
      toast.success("Revenue baseline calculated.");
    } catch (err) {
      setRevenueError(err.message || "Revenue calculation failed.");
      setRevenueStatus("error");
      toast.error(err.message || "Revenue calculation failed.");
    }
  }, [propertyId, fiscalYear]);

  // ── Create Planning Budget ────────────────────────────────────────
  const createPlanningBudget = useCallback(async () => {
    if (!canAssemble) return;
    setCreating(true);
    try {
      const result = await invokeEdgeFunction("compute-budget", {
        action: "generate",
        property_id: propertyId,
        fiscal_year: fiscalYear,
        scope: "property",
        period: "annual",
        // Planning-source mode: all three explicit snapshot IDs
        budget_basis_snapshot_id: basisSnapshotId,
        budget_cam_estimate_snapshot_id: camEstSnapshotId,
        revenue_snapshot_id: revenueSnapshotId,
      });
      if (result?.error) throw new Error(result.message || "Budget creation failed");
      toast.success("Planning budget created as draft.");
      navigate(createPageUrl("BudgetDashboard") + location.search);
    } catch (err) {
      toast.error(err.message || "Budget creation failed.");
    } finally {
      setCreating(false);
    }
  }, [
    canAssemble, propertyId, fiscalYear,
    basisSnapshotId, camEstSnapshotId, revenueSnapshotId,
    navigate, location.search,
  ]);

  // ── Derived values for Assembly Preview ──────────────────────────
  const baseRent = n(revenueOutputs?.summary?.revenue_by_type?.base_rent);
  const otherIncome = n(revenueOutputs?.summary?.revenue_by_type?.other_income);
  // Phase 3B estimated recoveries — NOT from revenue snapshot to avoid double-count
  const estimatedCamRecovery = n(camEstOutputs?.property_summary?.estimated_tenant_recoveries);
  const totalExpenses = n(basisOutputs?.totals?.annual_budget_total);
  const categories = basisOutputs?.categories ?? [];
  const tenantRecoveries = camEstOutputs?.tenant_recoveries ?? camEstOutputs?.tenants ?? [];

  // ── Guard: no property selected ──────────────────────────────────
  if (!propertyId) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">
        Select a property to start next-year planning.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header note */}
      <Card className="border-indigo-200 bg-indigo-50">
        <CardContent className="p-4 text-sm text-indigo-800">
          <p className="font-medium">Next-Year Planning Budget</p>
          <p className="text-xs mt-0.5">
            Runs three planning engines in sequence and assembles FY {fiscalYear} expense, CAM recovery
            and revenue into an authoritative draft budget. Run each step in order — Phase 3B depends on
            the expense basis from Phase 3A.
          </p>
        </CardContent>
      </Card>

      {/* Step 1 — Expense Basis */}
      <PhaseCard
        stepNumber="1"
        title="Expense Basis (Phase 3A)"
        description={`Projects FY ${fiscalYear} operating expenses from current-year actuals, applying category-level growth assumptions.`}
        status={basisStatus}
        error={basisError}
        action={
          <Button
            size="sm"
            variant={basisStatus === "done" ? "outline" : "default"}
            className="h-7 text-xs"
            onClick={runExpenseBasis}
            disabled={basisStatus === "running"}
          >
            {basisStatus === "running" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : (
              <Calculator className="h-3.5 w-3.5 mr-1.5" />
            )}
            {basisStatus === "done" ? "Re-run" : "Calculate Expense Basis"}
          </Button>
        }
      >
        {basisStatus === "done" && basisOutputs && (
          <div>
            <div className="flex items-center gap-4 flex-wrap">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Annual Budget Total</p>
                <p className="text-lg font-bold text-slate-800">{fmt(totalExpenses)}</p>
              </div>
              {basisOutputs.totals?.current_year_forecast != null && (
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">Current Yr Forecast</p>
                  <p className="text-sm font-semibold text-slate-600">{fmt(basisOutputs.totals.current_year_forecast)}</p>
                </div>
              )}
              <p className="text-[10px] text-slate-400 font-mono mt-auto">
                Snapshot: {basisSnapshotId?.slice(0, 8)}…
              </p>
            </div>
            <CategoryExpenseTable categories={categories} />
          </div>
        )}
      </PhaseCard>

      {/* Step 2 — CAM Estimate */}
      <PhaseCard
        stepNumber="2"
        title="CAM Recovery Estimate (Phase 3B)"
        description={`Projects tenant CAM recoveries for FY ${fiscalYear} using Phase 3A expense basis as the recoverable cost pool.`}
        status={camEstStatus}
        error={camEstError}
        action={
          <Button
            size="sm"
            variant={camEstStatus === "done" ? "outline" : "default"}
            className="h-7 text-xs"
            onClick={runCamEstimate}
            disabled={!canRunCamEst || camEstStatus === "running"}
            title={!canRunCamEst ? "Run Phase 3A expense basis first" : undefined}
          >
            {camEstStatus === "running" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : (
              <TrendingUp className="h-3.5 w-3.5 mr-1.5" />
            )}
            {camEstStatus === "done" ? "Re-run" : "Calculate CAM Estimate"}
          </Button>
        }
      >
        {!canRunCamEst && camEstStatus === "idle" && (
          <p className="text-xs text-slate-400">Complete Phase 3A first to unlock this step.</p>
        )}
        {camEstStatus === "done" && camEstOutputs && (
          <div>
            <div className="flex items-center gap-4 flex-wrap">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Est. Tenant Recoveries</p>
                <p className="text-lg font-bold text-slate-800">{fmt(estimatedCamRecovery)}</p>
              </div>
              {camEstOutputs.property_summary?.budgeted_recoverable_expense_basis != null && (
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">Recoverable Pool</p>
                  <p className="text-sm font-semibold text-slate-600">
                    {fmt(camEstOutputs.property_summary.budgeted_recoverable_expense_basis)}
                  </p>
                </div>
              )}
              {camEstOutputs.property_summary?.estimated_owner_nonrecoverable_share != null && (
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">Owner Non-recoverable</p>
                  <p className="text-sm font-semibold text-slate-600">
                    {fmt(camEstOutputs.property_summary.estimated_owner_nonrecoverable_share)}
                  </p>
                </div>
              )}
              <p className="text-[10px] text-slate-400 font-mono mt-auto">
                Snapshot: {camEstSnapshotId?.slice(0, 8)}…
              </p>
            </div>
            <TenantRecoveryTable tenants={tenantRecoveries} />
          </div>
        )}
      </PhaseCard>

      {/* Step 3 — Revenue Baseline */}
      <PhaseCard
        stepNumber="3"
        title="Revenue Baseline"
        description={`Base rent from approved lease abstracts. CAM recovery uses Phase 3B estimate — not the posted actual CAM — to avoid double-counting.`}
        status={revenueStatus}
        error={revenueError}
        action={
          <Button
            size="sm"
            variant={revenueStatus === "done" ? "outline" : "default"}
            className="h-7 text-xs"
            onClick={runRevenue}
            disabled={revenueStatus === "running"}
          >
            {revenueStatus === "running" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            )}
            {revenueStatus === "done" ? "Refresh" : "Calculate Revenue"}
          </Button>
        }
      >
        {revenueStatus === "done" && revenueOutputs && (
          <div className="flex items-center gap-4 flex-wrap">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Base Rent (annual)</p>
              <p className="text-lg font-bold text-slate-800">{fmt(baseRent)}</p>
            </div>
            {n(otherIncome) > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Other Income</p>
                <p className="text-sm font-semibold text-slate-600">{fmt(otherIncome)}</p>
              </div>
            )}
            <div>
              <p className="text-[10px] uppercase tracking-wide text-amber-600">
                ⚠ CAM recovery from revenue snapshot excluded
              </p>
              <p className="text-xs text-slate-400">
                Using Phase 3B estimate instead (no double-count)
              </p>
            </div>
            <p className="text-[10px] text-slate-400 font-mono mt-auto">
              Snapshot: {revenueSnapshotId?.slice(0, 8)}…
            </p>
          </div>
        )}
      </PhaseCard>

      {/* Assembly Preview */}
      {canAssemble && (
        <AssemblyPreview
          baseRent={baseRent}
          otherIncome={otherIncome}
          estimatedCamRecovery={estimatedCamRecovery}
          totalExpenses={totalExpenses}
          fiscalYear={fiscalYear}
        />
      )}

      {/* Create Planning Budget CTA */}
      {canAssemble && (
        <div className="flex justify-end pt-1">
          <Button
            onClick={createPlanningBudget}
            disabled={creating}
            className="bg-indigo-600 hover:bg-indigo-700 text-white h-10 px-6 text-sm font-semibold shadow-sm"
          >
            {creating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Creating Planning Budget…
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Create Planning Budget (Draft)
              </>
            )}
          </Button>
        </div>
      )}

      {/* Show a softer CTA when Phase 3A is done but other steps aren't */}
      {basisStatus === "done" && !canAssemble && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
          Complete all three steps above to enable planning budget creation.
        </div>
      )}
    </div>
  );
}
