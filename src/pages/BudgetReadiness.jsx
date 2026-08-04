/**
 * BudgetReadiness — property-level report of everything a Budget run
 * depends on: canonical active leases, rent schedule completeness,
 * materialized CAM policies, premises/area/occupancy completeness,
 * finalized-vs-published expense reconciliation, recovery pool readiness,
 * estimate schedule completeness, and unresolved source inconsistencies.
 *
 * A property is CAM-ready only when evaluate_cam_readiness reports no
 * blocking exceptions. A property is Budget-ready only when it is
 * CAM-ready AND every monetary source reconciles AND at least one CAM run
 * for this property+period has passed manual tie-out (status approved or
 * posted) AND there are zero unresolved source inconsistencies (duplicate
 * leases, cam_eligible contradictions, leases missing a policy). This page
 * never computes anything itself -- every figure comes from
 * get-budget-readiness-report, which is read-only.
 */
import React from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, AlertTriangle, ExternalLink } from "lucide-react";

import useOrgQuery from "@/hooks/useOrgQuery";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { createPageUrl } from "@/utils";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

function fmtCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function StatusBadge({ ready, readyLabel, notReadyLabel }) {
  return ready
    ? <Badge className="text-[11px] font-semibold bg-emerald-100 text-emerald-700">{readyLabel}</Badge>
    : <Badge className="text-[11px] font-semibold bg-red-100 text-red-700">{notReadyLabel}</Badge>;
}

function CompletenessRow({ label, completeCount, total, missing }) {
  const ok = missing.length === 0;
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b last:border-0">
      <div className="flex items-start gap-2">
        {ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5" /> : <XCircle className="w-4 h-4 text-red-500 mt-0.5" />}
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-slate-500">{completeCount} of {total} complete</p>
        </div>
      </div>
      {!ok && (
        <div className="text-xs text-red-700 text-right max-w-xs">
          {missing.slice(0, 5).map((m) => m.tenant_name || m.lease_id).join(", ")}
          {missing.length > 5 ? ` +${missing.length - 5} more` : ""}
        </div>
      )}
    </div>
  );
}

export default function BudgetReadiness() {
  const [searchParams, setSearchParams] = useSearchParams();
  const propertyId = searchParams.get("property_id") || "";
  const periodId = searchParams.get("recovery_period_id") || "";

  const setPropertyId = (v) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (v) next.set("property_id", v); else next.delete("property_id");
    next.delete("recovery_period_id");
    return next;
  });
  const setPeriodId = (v) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (v) next.set("recovery_period_id", v); else next.delete("recovery_period_id");
    return next;
  });

  const { data: properties = [] } = useOrgQuery("Property");

  const { data: calendars = [] } = useQuery({
    queryKey: ["recovery_calendars", propertyId],
    enabled: Boolean(propertyId),
    queryFn: async () => {
      const { data, error } = await supabase.from("recovery_calendars").select("id").eq("property_id", propertyId);
      if (error) return [];
      return data || [];
    },
  });
  const calendarIds = React.useMemo(() => calendars.map((c) => c.id), [calendars]);

  const { data: periods = [] } = useQuery({
    queryKey: ["recovery_periods", calendarIds.join(",")],
    enabled: calendarIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.from("recovery_periods").select("*").in("calendar_id", calendarIds).order("start_date", { ascending: false });
      if (error) return [];
      return data || [];
    },
  });

  const { data: report, isLoading, error } = useQuery({
    queryKey: ["budget_readiness_report", propertyId, periodId],
    enabled: Boolean(propertyId) && Boolean(periodId),
    queryFn: () => invokeEdgeFunction("get-budget-readiness-report", { property_id: propertyId, recovery_period_id: periodId }),
  });

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader title="Budget Readiness" description="Whether a property's leases, policies, premises, expenses and CAM run reconcile enough to trust a Budget run." />

      <Card>
        <CardContent className="pt-4 flex flex-wrap items-center gap-3">
          <Select value={propertyId} onValueChange={setPropertyId}>
            <SelectTrigger className="w-64" id="select-budget-readiness-property"><SelectValue placeholder="Select property" /></SelectTrigger>
            <SelectContent>
              {properties.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={periodId} onValueChange={setPeriodId} disabled={periods.length === 0}>
            <SelectTrigger className="w-56" id="select-budget-readiness-period"><SelectValue placeholder="Select recovery period" /></SelectTrigger>
            <SelectContent>
              {periods.map((p) => <SelectItem key={p.id} value={p.id}>{p.label} ({p.start_date} → {p.end_date})</SelectItem>)}
            </SelectContent>
          </Select>
          {propertyId && periodId && (
            <Link to={createPageUrl("CAMSetup") + `?property_id=${propertyId}&period_id=${periodId}`} className="text-xs text-blue-600 flex items-center gap-1 ml-auto">
              Open CAM Setup <ExternalLink className="w-3 h-3" />
            </Link>
          )}
        </CardContent>
      </Card>

      {!propertyId || !periodId ? (
        <p className="text-sm text-slate-500">Select a property and recovery period to see its budget readiness report.</p>
      ) : isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-600">{error.message || "Could not load budget readiness report"}</p>
      ) : report ? (
        <>
          <Card>
            <CardContent className="pt-4 flex items-center gap-6">
              <div>
                <p className="text-xs text-slate-500 mb-1">CAM Readiness</p>
                <StatusBadge ready={report.cam_ready} readyLabel="CAM READY" notReadyLabel="NOT CAM READY" />
              </div>
              <div>
                <p className="text-xs text-slate-500 mb-1">Budget Readiness</p>
                <StatusBadge ready={report.budget_ready} readyLabel="BUDGET READY" notReadyLabel="NOT BUDGET READY" />
              </div>
              <div>
                <p className="text-xs text-slate-500 mb-1">CAM Run Tie-Out</p>
                {report.cam_run_tie_out ? (
                  <Badge className="text-[11px] bg-emerald-100 text-emerald-700">Run {report.cam_run_tie_out.status} {new Date(report.cam_run_tie_out.updated_at).toLocaleDateString()}</Badge>
                ) : (
                  <Badge className="text-[11px] bg-red-100 text-red-700">No approved/posted CAM run yet</Badge>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Leases</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm">{report.leases.canonical_count} canonical active lease(s)</p>
              {report.leases.duplicate_groups_excluded.length > 0 && (
                <div className="mt-2 p-2 bg-amber-50 rounded text-xs text-amber-800">
                  {report.leases.duplicate_groups_excluded.length} possible duplicate lease group(s) excluded from this report — resolve via "Prepare CAM Automatically" in CAM Setup before trusting canonical counts.
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Completeness</CardTitle></CardHeader>
            <CardContent>
              <CompletenessRow label="Monthly rent schedules" completeCount={report.rent_schedules.complete_count} total={report.leases.canonical_count} missing={report.rent_schedules.missing} />
              <CompletenessRow label="Materialized CAM policies" completeCount={report.policies.materialized_approved_count} total={report.leases.canonical_count} missing={report.policies.missing} />
              <CompletenessRow label="Premises / area / occupancy" completeCount={report.premises.complete_count} total={report.leases.canonical_count} missing={report.premises.missing} />
              <CompletenessRow label="Estimate schedules" completeCount={report.estimates.complete_count} total={report.leases.canonical_count} missing={report.estimates.missing} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Expense Reconciliation</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between text-sm"><span>Finalized, CAM-eligible total (Expense Review)</span><span className="font-medium">{fmtCurrency(report.expenses.finalized_cam_eligible_total)}</span></div>
              <div className="flex justify-between text-sm"><span>Published-to-CAM total (CAM Setup)</span><span className="font-medium">{fmtCurrency(report.expenses.published_total)}</span></div>
              <div className="flex justify-between text-sm font-semibold">
                <span>Discrepancy</span>
                <span className={report.expenses.reconciled ? "text-emerald-600" : "text-red-600"}>{fmtCurrency(report.expenses.discrepancy)}</span>
              </div>
              {report.expenses.contradictory_classification_count > 0 && (
                <p className="text-xs text-red-700 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {report.expenses.contradictory_classification_count} classification(s) marked CAM-eligible despite being non-recoverable/excluded.</p>
              )}
            </CardContent>
          </Card>

          {report.unresolved_inconsistencies.length > 0 && (
            <Card className="border-red-200">
              <CardHeader><CardTitle className="text-base text-red-700">Unresolved Source Inconsistencies ({report.unresolved_inconsistencies.length})</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {report.unresolved_inconsistencies.map((item, i) => (
                  <div key={i} className="text-xs text-red-800 border-b last:border-0 py-1.5">
                    {item.type === "duplicate_lease_group" && <span>Possible duplicate leases: {item.tenant_name} ({item.lease_count} records) — {item.reason}</span>}
                    {item.type === "cam_eligible_contradiction" && <span>Classification {item.classification_id} marked CAM-eligible despite non-recoverable status ({fmtCurrency(item.amount)})</span>}
                    {item.type === "lease_missing_policy" && <span>{item.tenant_name} has no materialized recovery policy</span>}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {!report.budget_ready && (
            <p className="text-xs text-slate-500">
              Budget-ready requires: CAM readiness with no blocking exceptions, expense totals that reconcile, at least one CAM run that has passed manual tie-out (approved or posted), and zero unresolved source inconsistencies.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
