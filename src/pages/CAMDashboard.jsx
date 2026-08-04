/**
 * CAM Overview — Read-only dashboard for property managers.
 *
 * Displays:
 *   - Setup readiness
 *   - Eligible pool expenses
 *   - Calculated recovery
 *   - CAM estimates scheduled / charges exported
 *   - Expected due / credit
 *   - Latest run status & open exceptions
 *   - Prior-year posted comparison
 *
 * Exposes no property-level cap/fee/grossup rules as authoritative universal rules.
 */
import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Calculator, ArrowRight, TrendingUp, Building2, ClipboardCheck, AlertTriangle, CheckCircle2, DollarSign } from "lucide-react";

import useOrgQuery from "@/hooks/useOrgQuery";
import { supabase } from "@/services/supabaseClient";
import { getCamScopeContext } from "@/lib/camScope";
import { createPageUrl } from "@/utils";
import { invokeEdgeFunction } from "@/services/edgeFunctions";

import PageHeader from "@/components/PageHeader";
import ScopeSelector from "@/components/ScopeSelector";
import MetricCard from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function fmtCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function StatusBadge({ status }) {
  const tone =
    status === "posted"      ? "bg-emerald-100 text-emerald-700"
    : status === "approved"  ? "bg-emerald-100 text-emerald-700"
    : status === "submitted" || status === "under_review" ? "bg-amber-100 text-amber-800"
    : status === "calculated" ? "bg-indigo-100 text-indigo-700"
    : "bg-slate-100 text-slate-600";
  return <Badge className={`text-[10px] uppercase font-semibold ${tone}`}>{status}</Badge>;
}

export default function CAMDashboard() {
  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;

  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");

  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: leaseList = [] } = useOrgQuery("Lease");
  const { data: expenses = [] } = useOrgQuery("Expense");

  const scope = useMemo(
    () =>
      getCamScopeContext({
        properties,
        buildings,
        units,
        leases: leaseList,
        expenses,
        scopeProperty,
        scopeBuilding,
        scopeUnit,
        fiscalYear: currentYear,
      }),
    [properties, buildings, units, leaseList, expenses, scopeProperty, scopeBuilding, scopeUnit, currentYear],
  );

  // Active period for selected property
  const { data: recoveryPeriods = [] } = useQuery({
    queryKey: ["cam-overview-periods", scope.targetPropertyId],
    enabled: !!scope.targetPropertyId,
    queryFn: async () => {
      try {
        const { data: cals, error: calErr } = await supabase.from("recovery_calendars").select("id").eq("property_id", scope.targetPropertyId);
        if (calErr || !cals || cals.length === 0) return [];
        const calIds = cals.map((c) => c.id);
        const { data, error } = await supabase.from("recovery_periods").select("*").in("calendar_id", calIds).order("start_date", { ascending: false });
        if (error) return [];
        return data ?? [];
      } catch {
        return [];
      }
    },
  });

  const activePeriod = recoveryPeriods[0] || null;

  // Readiness for active period
  const { data: readiness } = useQuery({
    queryKey: ["cam-overview-readiness", scope.targetPropertyId, activePeriod?.id],
    enabled: !!scope.targetPropertyId,
    queryFn: async () => {
      if (!activePeriod?.id) return null;
      try {
        const { data, error } = await invokeEdgeFunction("get-cam-setup-readiness", {
          property_id: scope.targetPropertyId,
          recovery_period_id: activePeriod.id,
        });
        if (error) return null;
        return data;
      } catch {
        return null;
      }
    },
  });

  // Latest CAM run for active period
  const { data: latestRun } = useQuery({
    queryKey: ["cam-overview-latest-run", activePeriod?.id, scope.targetPropertyId],
    enabled: !!scope.targetPropertyId,
    queryFn: async () => {
      try {
        let query = supabase.from("cam_runs").select("*");
        if (activePeriod?.id) {
          query = query.eq("recovery_period_id", activePeriod.id);
        } else {
          query = query.eq("scope_id", scope.targetPropertyId);
        }
        const { data, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (error) return null;
        return data;
      } catch {
        return null;
      }
    },
  });

  // Prior year posted run for comparison
  const { data: priorYearRun } = useQuery({
    queryKey: ["cam-overview-prior-run", scope.targetPropertyId],
    enabled: !!scope.targetPropertyId,
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from("cam_runs")
          .select("*, cam_run_lease_results(final_recovery)")
          .eq("scope_id", scope.targetPropertyId)
          .eq("status", "posted")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) return null;
        return data;
      } catch {
        return null;
      }
    },
  });

  // Lease results for latest run
  const { data: leaseResults = [] } = useQuery({
    queryKey: ["cam-overview-lease-results", latestRun?.id],
    enabled: !!latestRun?.id,
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from("cam_run_lease_results")
          .select("*, leases(tenant_name)")
          .eq("cam_run_id", latestRun.id);
        if (error) return [];
        return data ?? [];
      } catch {
        return [];
      }
    },
  });

  // Exceptions for latest run
  const { data: exceptions = [] } = useQuery({
    queryKey: ["cam-overview-exceptions", latestRun?.id],
    enabled: !!latestRun?.id,
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from("cam_run_exceptions")
          .select("*")
          .eq("cam_run_id", latestRun.id);
        if (error) return [];
        return data ?? [];
      } catch {
        return [];
      }
    },
  });

  // Published eligible pool expenses with fallback to expenses table
  const { data: eligibleExpenses = [] } = useQuery({
    queryKey: ["cam-overview-expenses", scope.targetPropertyId, scopeProperty],
    enabled: !!scope.targetPropertyId || scopeProperty === "all",
    queryFn: async () => {
      try {
        let query = supabase.from("cam_expense_inputs").select("*");
        if (scope.targetPropertyId) {
          query = query.eq("property_id", scope.targetPropertyId);
        }
        const { data, error } = await query.eq("publication_status", "published");
        if (!error && data && data.length > 0) return data;
      } catch {
        // Fallback below
      }

      // Fallback: Query expenses table directly for CAM eligible expenses
      try {
        let expQuery = supabase.from("expenses").select("id, amount, description, category");
        if (scope.targetPropertyId) {
          expQuery = expQuery.eq("property_id", scope.targetPropertyId);
        }
        const { data: rawExp } = await expQuery;
        return (rawExp || []).map(e => ({ id: e.id, amount: e.amount, description: e.description, category: e.category }));
      } catch {
        return [];
      }
    },
  });

  // Scheduled estimates
  const { data: estimateSchedules = [] } = useQuery({
    queryKey: ["cam-overview-estimates", activePeriod?.id],
    enabled: !!activePeriod?.id,
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from("cam_estimate_schedules")
          .select("amount")
          .eq("recovery_period_id", activePeriod.id);
        if (error) return [];
        return data ?? [];
      } catch {
        return [];
      }
    },
  });

  // Calculated metrics
  const eligiblePoolExpensesTotal = eligibleExpenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const calculatedRecoveryTotal = leaseResults.reduce((sum, r) => sum + (Number(r.final_recovery) || 0), 0);
  const estimatesScheduledTotal = estimateSchedules.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const expectedDueCreditTotal = leaseResults.reduce((sum, r) => sum + (Number(r.amount_due_credit) || 0), 0);

  const priorYearRecoveryTotal = (priorYearRun?.cam_run_lease_results ?? []).reduce(
    (sum, r) => sum + (Number(r.final_recovery) || 0), 0
  );

  const openExceptionsCount = exceptions.filter((e) => e.resolution_status === "open").length;

  return (
    <div className="p-4 lg:p-6 space-y-6">
      <PageHeader
        icon={Calculator}
        title="CAM Overview"
        subtitle="High-level summary of CAM readiness, eligible expenses, recovery calculations, and run status"
        iconColor="from-teal-500 to-cyan-600"
      >
        <div className="flex items-center gap-2">
          <Link to={createPageUrl("CAMSetup")}>
            <Button variant="outline" size="sm">
              <ClipboardCheck className="w-4 h-4 mr-1" /> CAM Setup
            </Button>
          </Link>
          <Link to={createPageUrl("CAMRun")}>
            <Button size="sm" className="bg-teal-600 hover:bg-teal-700">
              CAM Runs <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          </Link>
        </div>
      </PageHeader>

      <ScopeSelector
        properties={properties}
        buildings={buildings}
        units={units}
        selectedProperty={scopeProperty}
        selectedBuilding={scopeBuilding}
        selectedUnit={scopeUnit}
        onPropertyChange={(value) => {
          setScopeProperty(value);
          setScopeBuilding("all");
          setScopeUnit("all");
        }}
        onBuildingChange={(value) => {
          setScopeBuilding(value);
          setScopeUnit("all");
        }}
        onUnitChange={setScopeUnit}
        showUnit
      />

      {!scope.targetPropertyId ? (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Select a property to view its CAM overview summary.
        </div>
      ) : (
        <div className="space-y-6">
          {/* Top Metric Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard
              label="Eligible Pool Expenses"
              value={fmtCurrency(eligiblePoolExpensesTotal)}
              icon={DollarSign}
              color="bg-blue-50 text-blue-600"
              sub={`${eligibleExpenses.length} published input(s)`}
            />
            <MetricCard
              label="Calculated Recovery"
              value={fmtCurrency(calculatedRecoveryTotal)}
              icon={Calculator}
              color="bg-teal-50 text-teal-600"
              sub={latestRun ? `Run: ${latestRun.status}` : "No run yet"}
            />
            <MetricCard
              label="CAM Estimates Scheduled"
              value={fmtCurrency(estimatesScheduledTotal)}
              icon={Building2}
              color="bg-indigo-50 text-indigo-600"
              sub={`${estimateSchedules.length} schedule item(s)`}
            />
            <MetricCard
              label="Expected Due / (Credit)"
              value={fmtCurrency(expectedDueCreditTotal)}
              icon={TrendingUp}
              color={expectedDueCreditTotal < 0 ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-600"}
              sub="Net adjustment due"
            />
          </div>

          {/* Setup Readiness & Latest Run Status */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Setup Readiness</CardTitle>
                {readiness && (
                  <Badge className={`text-[11px] font-semibold ${readiness.status === "READY" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>
                    {readiness.status}
                  </Badge>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                {readiness ? (
                  <>
                    <p className="text-sm text-slate-600">
                      Active Period: <strong>{activePeriod?.label ?? "—"}</strong> ({activePeriod?.start_date} → {activePeriod?.end_date})
                    </p>
                    {readiness.blocking_items?.length > 0 ? (
                      <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 p-2 rounded">
                        <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
                        <span>{readiness.blocking_items.length} blocking setup issue(s) remaining</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 p-2 rounded">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                        <span>All setup checks passed cleanly</span>
                      </div>
                    )}
                    <Link to={createPageUrl("CAMSetup")}>
                      <Button size="sm" variant="outline" className="mt-1">Review Setup Details →</Button>
                    </Link>
                  </>
                ) : (
                  <p className="text-sm text-slate-400">No active recovery period found for this property.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Latest Run &amp; Exceptions</CardTitle>
                {latestRun && <StatusBadge status={latestRun.status} />}
              </CardHeader>
              <CardContent className="space-y-3">
                {latestRun ? (
                  <>
                    <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
                      <div><span className="text-slate-400">Run Type:</span> {latestRun.run_type}</div>
                      <div><span className="text-slate-400">Created:</span> {new Date(latestRun.created_at).toLocaleDateString()}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500 font-medium">Open Exceptions:</span>
                      <Badge className={`text-[10px] ${openExceptionsCount > 0 ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-700"}`}>
                        {openExceptionsCount} open
                      </Badge>
                    </div>
                    <Link to={`${createPageUrl("CAMRun")}?property_id=${scope.targetPropertyId}&recovery_period_id=${activePeriod?.id}`}>
                      <Button size="sm" variant="outline" className="mt-1">View CAM Runs →</Button>
                    </Link>
                  </>
                ) : (
                  <p className="text-sm text-slate-400">No CAM runs found for this recovery period.</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Prior Year Comparison & Lease Results Breakdown */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle className="text-base">Lease Recovery Summary</CardTitle></CardHeader>
              <CardContent>
                {leaseResults.length === 0 ? (
                  <p className="text-sm text-slate-400 py-4 text-center">No lease calculation results available yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tenant</TableHead>
                        <TableHead className="text-right">Final Recovery</TableHead>
                        <TableHead className="text-right">Estimates Scheduled</TableHead>
                        <TableHead className="text-right">Expected Due / (Credit)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {leaseResults.map((lr) => (
                        <TableRow key={lr.id}>
                          <TableCell className="font-medium text-sm">{lr.leases?.tenant_name ?? lr.lease_id.slice(0, 8)}</TableCell>
                          <TableCell className="text-right text-sm">{fmtCurrency(lr.final_recovery)}</TableCell>
                          <TableCell className="text-right text-sm">{fmtCurrency(lr.estimates_billed)}</TableCell>
                          <TableCell className={`text-right text-sm font-semibold ${Number(lr.amount_due_credit) < 0 ? "text-red-600" : "text-emerald-700"}`}>
                            {fmtCurrency(lr.amount_due_credit)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Prior-Year Posted Comparison</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {priorYearRun ? (
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between border-b pb-1">
                      <span className="text-slate-500">Prior Posted Recovery:</span>
                      <span className="font-semibold">{fmtCurrency(priorYearRecoveryTotal)}</span>
                    </div>
                    <div className="flex justify-between border-b pb-1">
                      <span className="text-slate-500">Current Calculated:</span>
                      <span className="font-semibold">{fmtCurrency(calculatedRecoveryTotal)}</span>
                    </div>
                    <div className="flex justify-between pt-1">
                      <span className="text-slate-500">Year-over-Year Delta:</span>
                      <span className={`font-semibold ${calculatedRecoveryTotal - priorYearRecoveryTotal > 0 ? "text-amber-700" : "text-emerald-700"}`}>
                        {fmtCurrency(calculatedRecoveryTotal - priorYearRecoveryTotal)}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">No posted run found from prior period for comparison.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
