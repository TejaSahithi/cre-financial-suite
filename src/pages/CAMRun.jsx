/**
 * CAMRun — Enterprise CAM & Budget Implementation Blueprint v1.0, Phase 4A.
 *
 * Create/select a CAM run for a property + recovery period, calculate it,
 * inspect the engine-computed pool/lease summaries and exceptions, and
 * drive the DRAFT -> CALCULATED -> IN_REVIEW -> APPROVED workflow. This
 * page does NOT compute any CAM figure itself — every number shown here is
 * read directly from cam_run_pool_results/cam_run_lease_results/
 * cam_run_exceptions, written by the real orchestrator via
 * run-cam-calculation-v2. Posting (APPROVED -> POSTED and beyond) is
 * intentionally not exposed anywhere in this UI yet — that is gated behind
 * Workstream B's release-readiness acceptance, per the Phase 4B gate.
 */
import React, { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Calculator, RefreshCw, Send, ExternalLink } from "lucide-react";

import useOrgQuery from "@/hooks/useOrgQuery";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { createPageUrl } from "@/utils";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function fmtCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  return num.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
function fmtDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

const STATUS_TONE = {
  draft: "bg-slate-100 text-slate-600",
  readiness_failed: "bg-red-100 text-red-700",
  ready: "bg-slate-100 text-slate-600",
  calculating: "bg-blue-100 text-blue-700",
  calculated: "bg-indigo-100 text-indigo-700",
  under_review: "bg-amber-100 text-amber-800",
  submitted: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-700",
  posted: "bg-emerald-100 text-emerald-700",
  superseded: "bg-slate-100 text-slate-500",
  voided: "bg-slate-100 text-slate-400",
};
function StatusBadge({ status }) {
  return <Badge className={`text-xs ${STATUS_TONE[status] || "bg-slate-100 text-slate-600"}`}>{status}</Badge>;
}

export default function CAMRun() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const propertyIdParam = searchParams.get("property_id") || "";
  const periodIdParam = searchParams.get("recovery_period_id") || "";
  const [propertyId, setPropertyId] = useState(propertyIdParam);
  const [periodId, setPeriodId] = useState(periodIdParam);
  const [runMode, setRunMode] = useState("posting_eligible");

  const { data: properties = [] } = useOrgQuery("Property");

  const { data: calendars = [] } = useQuery({
    queryKey: ["cam-run-calendars", propertyId],
    queryFn: async () => {
      const { data, error } = await supabase.from("recovery_calendars").select("*").eq("property_id", propertyId);
      if (error) throw error;
      return data || [];
    },
    enabled: Boolean(propertyId),
  });
  const calendarIds = calendars.map((c) => c.id);

  const { data: periods = [] } = useQuery({
    queryKey: ["cam-run-periods", calendarIds.join(",")],
    queryFn: async () => {
      if (calendarIds.length === 0) return [];
      const { data, error } = await supabase.from("recovery_periods").select("*").in("calendar_id", calendarIds).order("start_date", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: calendarIds.length > 0,
  });

  const { data: runs = [], refetch: refetchRuns } = useQuery({
    queryKey: ["cam-run-list", propertyId, periodId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cam_runs")
        .select("*")
        .eq("recovery_period_id", periodId)
        .eq("scope_type", "property")
        .eq("scope_id", propertyId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: Boolean(propertyId) && Boolean(periodId),
  });

  // The most recent non-voided run is what this page operates on -- a new
  // "Calculate" click always targets it (run-cam-calculation-v2 creates a
  // fresh draft only if none exists yet, matching the one-active-run-per-
  // series constraint already enforced at the database level).
  const activeRun = runs.find((r) => r.status !== "voided" && r.status !== "superseded") || null;

  const { data: poolResults = [] } = useQuery({
    queryKey: ["cam-run-pool-results", activeRun?.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_run_pool_results").select("*, recovery_pools(name)").eq("cam_run_id", activeRun.id);
      if (error) throw error;
      return data || [];
    },
    enabled: Boolean(activeRun?.id),
  });

  const { data: leaseResults = [] } = useQuery({
    queryKey: ["cam-run-lease-results", activeRun?.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_run_lease_results").select("*, leases(tenant_name)").eq("cam_run_id", activeRun.id);
      if (error) throw error;
      return data || [];
    },
    enabled: Boolean(activeRun?.id),
  });

  const { data: exceptionCounts = { blocking: 0, warning: 0, open: 0 } } = useQuery({
    queryKey: ["cam-run-exception-counts", activeRun?.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_run_exceptions").select("severity, resolution_status").eq("cam_run_id", activeRun.id);
      if (error) throw error;
      const rows = data || [];
      return {
        blocking: rows.filter((r) => r.severity === "blocking").length,
        warning: rows.filter((r) => r.severity === "warning").length,
        open: rows.filter((r) => r.resolution_status === "open").length,
      };
    },
    enabled: Boolean(activeRun?.id),
  });

  const calculateMutation = useMutation({
    mutationFn: () =>
      invokeEdgeFunction("run-cam-calculation-v2", {
        property_id: propertyId, recovery_period_id: periodId, scope_type: "property", scope_id: propertyId,
        run_type: "standard", run_mode: runMode,
      }),
    onSuccess: (result) => {
      if (result?.status === "readiness_failed") {
        toast.warning("Readiness check failed — see exceptions below before this run can be calculated.");
      } else {
        toast.success(result?.idempotent_rerun ? "Already up to date — no changes since the last calculation." : "Calculation complete.");
      }
      refetchRuns();
      queryClient.invalidateQueries({ queryKey: ["cam-run-pool-results"] });
      queryClient.invalidateQueries({ queryKey: ["cam-run-lease-results"] });
      queryClient.invalidateQueries({ queryKey: ["cam-run-exception-counts"] });
    },
    onError: (err) => toast.error(err?.message || "Calculation failed"),
  });

  const submitMutation = useMutation({
    mutationFn: () => invokeEdgeFunction("cam-run-workflow-v2", { cam_run_id: activeRun.id, action: "submit_for_review" }),
    onSuccess: () => { toast.success("Submitted for review."); refetchRuns(); },
    onError: (err) => toast.error(err?.message || "Could not submit for review"),
  });

  const canCalculate = activeRun == null || ["draft", "readiness_failed", "ready", "calculating", "calculated"].includes(activeRun.status);
  const canSubmit = activeRun?.status === "calculated";

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={Calculator} title="CAM Run" subtitle="Calculate, review, and approve a CAM recovery run — Phase 4A workflow" iconColor="from-blue-500 to-indigo-600" />

      <div className="flex flex-wrap items-center gap-3">
        <Select value={propertyId} onValueChange={(v) => { setPropertyId(v); setPeriodId(""); setSearchParams({ property_id: v }); }}>
          <SelectTrigger className="w-64"><SelectValue placeholder="Select property" /></SelectTrigger>
          <SelectContent>{properties.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={periodId} onValueChange={(v) => { setPeriodId(v); setSearchParams({ property_id: propertyId, recovery_period_id: v }); }} disabled={!propertyId || periods.length === 0}>
          <SelectTrigger className="w-64"><SelectValue placeholder={periods.length === 0 ? "No recovery periods yet" : "Select recovery period"} /></SelectTrigger>
          <SelectContent>{periods.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {!propertyId || !periodId ? (
        <Card><CardContent className="py-12 text-center text-sm text-slate-400">Select a property and recovery period to create or view a CAM run.</CardContent></Card>
      ) : (
        <>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Run status</CardTitle>
              {activeRun && <StatusBadge status={activeRun.status} />}
            </CardHeader>
            <CardContent className="space-y-4">
              {activeRun && (
                <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
                  <div><span className="text-slate-400">Run type</span><div>{activeRun.run_type}</div></div>
                  <div><span className="text-slate-400">Run mode (last calc)</span><div>{activeRun.run_mode}</div></div>
                  <div><span className="text-slate-400">Engine version</span><div className="font-mono text-xs">{activeRun.engine_version || "-"}</div></div>
                  <div><span className="text-slate-400">Input hash</span><div className="font-mono text-xs">{activeRun.input_hash ? `${activeRun.input_hash.slice(0, 12)}…` : "-"}</div></div>
                  <div><span className="text-slate-400">Created</span><div>{fmtDateTime(activeRun.created_at)}</div></div>
                  <div><span className="text-slate-400">Submitted</span><div>{fmtDateTime(activeRun.submitted_at)}</div></div>
                  <div><span className="text-slate-400">Approved</span><div>{fmtDateTime(activeRun.approved_at)}</div></div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 pt-2">
                {canCalculate && (
                  <>
                    <Select value={runMode} onValueChange={setRunMode}>
                      <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="posting_eligible">Posting-eligible (full checks)</SelectItem>
                        <SelectItem value="preview">Preview (relaxed checks)</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button onClick={() => calculateMutation.mutate()} disabled={calculateMutation.isPending}>
                      {activeRun?.status === "calculated" ? <RefreshCw className="mr-2 h-4 w-4" /> : <Calculator className="mr-2 h-4 w-4" />}
                      {activeRun == null ? "Calculate" : activeRun.status === "calculated" ? "Recalculate" : "Calculate"}
                    </Button>
                  </>
                )}
                {canSubmit && (
                  <Button variant="secondary" onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending}>
                    <Send className="mr-2 h-4 w-4" /> Submit for Review
                  </Button>
                )}
                {activeRun?.status === "under_review" && (
                  <Link to={`${createPageUrl("CAMExceptionReview")}?cam_run_id=${activeRun.id}`}>
                    <Button variant="secondary">Go to Exception Review <ExternalLink className="ml-2 h-3 w-3" /></Button>
                  </Link>
                )}
                {activeRun?.status === "submitted" && (
                  <Link to={`${createPageUrl("CAMApproval")}?cam_run_id=${activeRun.id}`}>
                    <Button variant="secondary">Go to Approval <ExternalLink className="ml-2 h-3 w-3" /></Button>
                  </Link>
                )}
                {activeRun?.status === "approved" && (
                  <Badge className="bg-emerald-100 text-emerald-700">Approved — posting is not yet enabled in this environment</Badge>
                )}
              </div>

              {activeRun && (exceptionCounts.blocking > 0 || exceptionCounts.warning > 0) && (
                <div className="flex flex-wrap gap-2 pt-2 text-sm">
                  {exceptionCounts.blocking > 0 && <Badge className="bg-red-100 text-red-700">{exceptionCounts.blocking} blocking</Badge>}
                  {exceptionCounts.warning > 0 && <Badge className="bg-amber-100 text-amber-800">{exceptionCounts.warning} warning</Badge>}
                  {exceptionCounts.open > 0 && <Badge className="bg-slate-100 text-slate-600">{exceptionCounts.open} unresolved</Badge>}
                  <Link to={`${createPageUrl("CAMExceptionReview")}?cam_run_id=${activeRun.id}`} className="text-xs text-blue-600 underline">Review exceptions</Link>
                </div>
              )}
            </CardContent>
          </Card>

          {activeRun && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader><CardTitle className="text-base">Pool results ({poolResults.length})</CardTitle></CardHeader>
                <CardContent>
                  {poolResults.length === 0 ? <p className="text-sm text-slate-400">No pool results yet.</p> : (
                    <Table>
                      <TableHeader><TableRow><TableHead>Pool</TableHead><TableHead>Actual</TableHead><TableHead>Gross-up</TableHead><TableHead>Adjusted</TableHead><TableHead /></TableRow></TableHeader>
                      <TableBody>
                        {poolResults.map((pr) => (
                          <TableRow key={pr.id}>
                            <TableCell className="text-sm font-medium">{pr.recovery_pools?.name || pr.pool_id.slice(0, 8)}</TableCell>
                            <TableCell className="text-sm">{fmtCurrency(pr.actual_amount)}</TableCell>
                            <TableCell className="text-sm">{fmtCurrency(pr.gross_up_adjustment)}</TableCell>
                            <TableCell className="text-sm font-medium">{fmtCurrency(pr.adjusted_pool)}</TableCell>
                            <TableCell>
                              <Link to={`${createPageUrl("CAMPoolDetail")}?cam_run_id=${activeRun.id}&pool_result_id=${pr.id}`} className="text-xs text-blue-600 underline">Detail</Link>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-base">Lease results ({leaseResults.length})</CardTitle></CardHeader>
                <CardContent>
                  {leaseResults.length === 0 ? <p className="text-sm text-slate-400">No lease results yet.</p> : (
                    <Table>
                      <TableHeader><TableRow><TableHead>Tenant</TableHead><TableHead>Final recovery</TableHead><TableHead>Est. billed</TableHead><TableHead>Due / credit</TableHead><TableHead /></TableRow></TableHeader>
                      <TableBody>
                        {leaseResults.map((lr) => (
                          <TableRow key={lr.id}>
                            <TableCell className="text-sm font-medium">{lr.leases?.tenant_name || lr.lease_id.slice(0, 8)}</TableCell>
                            <TableCell className="text-sm">{fmtCurrency(lr.final_recovery)}</TableCell>
                            <TableCell className="text-sm">{fmtCurrency(lr.estimates_billed)}</TableCell>
                            <TableCell className={`text-sm font-medium ${Number(lr.amount_due_credit) < 0 ? "text-emerald-600" : ""}`}>{fmtCurrency(lr.amount_due_credit)}</TableCell>
                            <TableCell>
                              <Link to={`${createPageUrl("CAMLeaseDetail")}?cam_run_id=${activeRun.id}&lease_result_id=${lr.id}`} className="text-xs text-blue-600 underline">Detail</Link>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {runs.length > 1 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Run history ({runs.length})</CardTitle></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow><TableHead>Status</TableHead><TableHead>Run type</TableHead><TableHead>Created</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {runs.map((r) => (
                      <TableRow key={r.id} className={r.id === activeRun?.id ? "bg-blue-50" : ""}>
                        <TableCell><StatusBadge status={r.status} /></TableCell>
                        <TableCell className="text-sm">{r.run_type}</TableCell>
                        <TableCell className="text-sm">{fmtDateTime(r.created_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
