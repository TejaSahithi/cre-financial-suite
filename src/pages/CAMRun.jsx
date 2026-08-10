/**
 * CAMRuns — Consolidated CAM Runs management page.
 *
 * Consolidates:
 *   - Run list / selection
 *   - Run summary & calculation
 *   - Pool results
 *   - Lease results
 *   - Exceptions
 *   - Approval workflow
 *   - Statements & Charge Export (CSV generation, download, delivery)
 *   - Lineage (Adjustment & Restatement run tracking)
 */
import React, { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Calculator, RefreshCw, Send, ExternalLink, FileDown,
  CheckCircle2, XCircle, AlertTriangle, Package, Lock,
} from "lucide-react";

import useOrgQuery from "@/hooks/useOrgQuery";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { createNotificationsForEvent } from "@/services/notificationService";
import { createPageUrl } from "@/utils";
import { buildCamActiveLeaseIdSet, filterCamActiveLeases, filterRowsToCamActiveLeases } from "@/lib/activeLease";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

function fmtCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function StatusBadge({ status }) {
  const tone =
    status === "posted"      ? "bg-emerald-100 text-emerald-700"
    : status === "approved"  ? "bg-emerald-100 text-emerald-700"
    : status === "submitted" || status === "under_review" ? "bg-amber-100 text-amber-800"
    : status === "calculated" ? "bg-indigo-100 text-indigo-700"
    : status === "readiness_failed" ? "bg-red-100 text-red-700"
    : "bg-slate-100 text-slate-600";
  return <Badge className={`text-xs uppercase font-semibold ${tone}`}>{status}</Badge>;
}

export default function CAMRun() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  // propertyId/periodId are derived DIRECTLY from the URL on every render,
  // not mirrored into useState. React Router does not remount this
  // component when only the query string changes on the same route (e.g.
  // arriving via a Link from CAM Setup with a newly-selected period while
  // this page was already mounted) -- a useState(paramFromUrl) initializer
  // only runs once at mount, so it would silently keep whatever period was
  // selected before, showing "select a recovery period" or the wrong
  // period even though an eligible one was just chosen. Deriving live from
  // searchParams (the same pattern CAMSetup.jsx uses) makes the URL the
  // single source of truth instead of a stale local copy of it.
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
  const [runMode, setRunMode] = useState("posting_eligible");

  // Dialog states for posting / lifecycle
  const [adjDialog, setAdjDialog] = useState(false);
  const [restateDialog, setRestateDialog] = useState(false);
  const [reasonForm, setReasonForm] = useState({ reason: "" });

  const { data: properties = [] } = useOrgQuery("Property");
  const { data: leases = [] } = useOrgQuery("Lease");
  const activeLeases = useMemo(() => filterCamActiveLeases(leases), [leases]);
  const activeLeaseIds = useMemo(() => buildCamActiveLeaseIdSet(activeLeases.filter((lease) => !propertyId || lease.property_id === propertyId)), [activeLeases, propertyId]);
  const activeLeaseKey = [...activeLeaseIds].sort().join(",");
  const activeProperty = properties.find((property) => property.id === propertyId) || null;

  const notifyCamEvent = (eventType, result, source) => {
    const run = result?.run || result || activeRun || {};
    createNotificationsForEvent({
      org_id: run.org_id || activeProperty?.org_id,
      event_type: eventType,
      entity_type: "cam",
      entity_id: run.id || activeRun?.id || null,
      entity_label: activeProperty?.name ? `${activeProperty.name} CAM` : "CAM Run",
      property_id: propertyId || run.property_id || null,
      action_url: `${createPageUrl("CAMRun")}?property_id=${propertyId}&recovery_period_id=${periodId}`,
      metadata: {
        source,
        property_name: activeProperty?.name || null,
        fiscal_year: run.fiscal_year || run.recovery_year || null,
        status: run.status || result?.status || null,
      },
    }).catch((error) => {
      console.warn("[CAMRun] notification event failed:", error?.message || error);
    });
  };

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
    enabled: true,
  });

  const { data: runs = [], refetch: refetchRuns } = useQuery({
    queryKey: ["cam-run-list", propertyId, periodId],
    queryFn: async () => {
      let query = supabase.from("cam_runs").select("*");
      if (periodId) {
        query = query.eq("recovery_period_id", periodId);
      } else if (propertyId) {
        query = query.eq("scope_id", propertyId);
      }
      const { data, error } = await query.order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: Boolean(propertyId) || true,
  });

  const activeRun = runs.find((r) => r.status !== "voided" && r.status !== "superseded") || runs[0] || null;

  const { data: poolResults = [] } = useQuery({
    queryKey: ["cam-run-pool-results", activeRun?.id],
    queryFn: async () => {
      try {
        const { data, error } = await supabase.from("cam_run_pool_results").select("*, recovery_pools(name)").eq("cam_run_id", activeRun.id);
        if (error) return [];
        return data || [];
      } catch {
        return [];
      }
    },
    enabled: Boolean(activeRun?.id),
  });

  const { data: leaseResults = [] } = useQuery({
    queryKey: ["cam-run-lease-results", activeRun?.id, activeLeaseKey],
    queryFn: async () => {
      try {
        const { data, error } = await supabase.from("cam_run_lease_results").select("*, leases(tenant_name)").eq("cam_run_id", activeRun.id);
        if (error) return [];
        return filterRowsToCamActiveLeases(data || [], activeLeaseIds);
      } catch {
        return [];
      }
    },
    enabled: Boolean(activeRun?.id),
  });

  const { data: exceptions = [] } = useQuery({
    queryKey: ["cam-run-exceptions-list", activeRun?.id],
    queryFn: async () => {
      try {
        const { data, error } = await supabase.from("cam_run_exceptions").select("*").eq("cam_run_id", activeRun.id);
        if (error) return [];
        return data || [];
      } catch {
        return [];
      }
    },
    enabled: Boolean(activeRun?.id),
  });

  const { data: statements = [], refetch: refetchStatements } = useQuery({
    queryKey: ["cam-run-statements", activeRun?.id],
    enabled: Boolean(activeRun?.id),
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from("cam_run_statements")
          .select("*, leases(tenant_name)")
          .eq("cam_run_id", activeRun.id)
          .neq("status", "void")
          .order("generated_at", { ascending: false });
        if (error) return [];
        return data ?? [];
      } catch {
        return [];
      }
    },
  });

  const { data: chargeExports = [], refetch: refetchExports } = useQuery({
    queryKey: ["cam-charge-exports", activeRun?.id],
    enabled: Boolean(activeRun?.id),
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from("cam_charge_exports")
          .select("*")
          .eq("cam_run_id", activeRun.id)
          .order("created_at", { ascending: false });
        if (error) return [];
        return data ?? [];
      } catch {
        return [];
      }
    },
  });

  const { data: lineage = {} } = useQuery({
    queryKey: ["cam-run-lineage", activeRun?.id],
    enabled: Boolean(activeRun?.id),
    queryFn: async () => {
      try {
        const [adj, restate] = await Promise.all([
          supabase.from("cam_adjustment_runs").select("*").eq("original_run_id", activeRun.id),
          supabase.from("cam_restatement_runs").select("*").eq("superseded_run_id", activeRun.id),
        ]);
        return { adjustments: adj.data ?? [], restatements: restate.data ?? [] };
      } catch {
        return { adjustments: [], restatements: [] };
      }
    },
  });

  // Calculation mutation
  const calculateMutation = useMutation({
    mutationFn: () =>
      invokeEdgeFunction("run-cam-calculation-v2", {
        property_id: propertyId, recovery_period_id: periodId, scope_type: "property", scope_id: propertyId,
        run_type: "standard", run_mode: runMode,
      }),
    onSuccess: (result) => {
      if (result?.status === "readiness_failed") {
        toast.warning("Readiness check failed — view exceptions for details.");
        notifyCamEvent("cam.review_required", result, "cam_calculation_readiness_failed");
      } else {
        toast.success(result?.idempotent_rerun ? "Up to date — no changes since last calculation." : "Calculation complete.");
        notifyCamEvent("cam.calculation_generated", result, "cam_calculation_generated");
      }
      refetchRuns();
      queryClient.invalidateQueries({ queryKey: ["cam-run-pool-results"] });
      queryClient.invalidateQueries({ queryKey: ["cam-run-lease-results"] });
      queryClient.invalidateQueries({ queryKey: ["cam-run-exceptions-list"] });
    },
    onError: (err) => toast.error(err?.message || "Calculation failed"),
  });

  // Workflow actions mutation
  const actionMutation = useMutation({
    mutationFn: ({ action, payload }) =>
      invokeEdgeFunction("cam-run-workflow-v2", { action, cam_run_id: activeRun?.id, ...payload }),
    onSuccess: (result, variables) => {
      const eventByAction = {
        submit_for_review: "cam.final_approval_required",
        approve: "cam.approved",
        reject: "cam.review_required",
      };
      const eventType = eventByAction[variables?.action];
      if (eventType) notifyCamEvent(eventType, result, `cam_run_${variables.action}`);
      refetchRuns();
      refetchStatements();
      refetchExports();
      queryClient.invalidateQueries({ queryKey: ["cam-run-lineage"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const doAction = (action, payload, successMsg) =>
    actionMutation.mutateAsync({ action, payload }, {
      onSuccess: () => toast.success(successMsg ?? "Done"),
    });

  const canCalculate = activeRun == null || ["draft", "readiness_failed", "ready", "calculating", "calculated"].includes(activeRun.status);
  const canSubmit = activeRun?.status === "calculated";
  const isApproved = activeRun?.status === "approved";
  const isPosted = activeRun?.status === "posted";

  const blockingExceptions = exceptions.filter((e) => e.severity === "blocking" && e.resolution_status === "open");
  const openExceptions = exceptions.filter((e) => e.resolution_status === "open");

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <PageHeader
        icon={Calculator}
        title="CAM Runs"
        subtitle="Execute, review, approve, and issue CAM recovery runs"
        iconColor="from-blue-500 to-indigo-600"
      />

      {/* Selectors */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={propertyId} onValueChange={setPropertyId}>
          <SelectTrigger className="w-64"><SelectValue placeholder="Select property" /></SelectTrigger>
          <SelectContent>{properties.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={periodId} onValueChange={setPeriodId} disabled={!propertyId || periods.length === 0}>
          <SelectTrigger className="w-64"><SelectValue placeholder={periods.length === 0 ? "No recovery periods yet" : "Select recovery period"} /></SelectTrigger>
          <SelectContent>{periods.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {!propertyId || !periodId ? (
        <Card><CardContent className="py-12 text-center text-sm text-slate-400">Select a property and recovery period to manage CAM runs.</CardContent></Card>
      ) : (
        <Tabs defaultValue="summary" className="space-y-4">
          <TabsList id="cam-run-tabs">
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="pools">Pool Results ({poolResults.length})</TabsTrigger>
            <TabsTrigger value="leases">Lease Results ({leaseResults.length})</TabsTrigger>
            <TabsTrigger value="exceptions">Exceptions ({openExceptions.length})</TabsTrigger>
            <TabsTrigger value="approval">Approval</TabsTrigger>
            <TabsTrigger value="statements">Statements &amp; Export</TabsTrigger>
            <TabsTrigger value="lineage">Lineage</TabsTrigger>
          </TabsList>

          {/* ---- Tab 1: Summary ---- */}
          <TabsContent value="summary" className="space-y-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Run Details</CardTitle>
                {activeRun && <StatusBadge status={activeRun.status} />}
              </CardHeader>
              <CardContent className="space-y-4">
                {activeRun ? (
                  <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm md:grid-cols-4">
                    <div><span className="text-slate-400 text-xs">Run Type</span><div className="font-medium">{activeRun.run_type}</div></div>
                    <div><span className="text-slate-400 text-xs">Engine Version</span><div className="font-mono text-xs">{activeRun.engine_version || "—"}</div></div>
                    <div><span className="text-slate-400 text-xs">Created</span><div className="text-xs">{fmtDateTime(activeRun.created_at)}</div></div>
                    <div><span className="text-slate-400 text-xs">Submitted</span><div className="text-xs">{fmtDateTime(activeRun.submitted_at)}</div></div>
                    <div><span className="text-slate-400 text-xs">Approved</span><div className="text-xs">{fmtDateTime(activeRun.approved_at)}</div></div>
                    <div><span className="text-slate-400 text-xs">Posted</span><div className="text-xs">{fmtDateTime(activeRun.posted_at)}</div></div>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">No active run for this recovery period. Click Calculate to start.</p>
                )}

                <div className="flex flex-wrap items-center gap-3 pt-2 border-t">
                  {canCalculate && (
                    <>
                      <Select value={runMode} onValueChange={setRunMode}>
                        <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="posting_eligible">Full Validation Mode</SelectItem>
                          <SelectItem value="preview">Draft / Simulation Mode</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button onClick={() => calculateMutation.mutate()} disabled={calculateMutation.isPending}>
                        {activeRun?.status === "calculated" ? <RefreshCw className="mr-2 h-4 w-4" /> : <Calculator className="mr-2 h-4 w-4" />}
                        {activeRun == null ? "Calculate CAM" : activeRun.status === "calculated" ? "Recalculate" : "Calculate"}
                      </Button>
                    </>
                  )}
                  {canSubmit && (
                    <Button variant="secondary" onClick={() => doAction("submit_for_review", {}, "Submitted for review")} disabled={actionMutation.isPending}>
                      <Send className="mr-2 h-4 w-4" /> Submit for Review
                    </Button>
                  )}
                  {isApproved && (
                    <Button
                      className="bg-emerald-600 hover:bg-emerald-700 text-white"
                      disabled={actionMutation.isPending}
                      onClick={() => doAction("post_run", {}, "Run posted successfully")}
                    >
                      <Lock className="mr-2 h-4 w-4" /> Post CAM Run
                    </Button>
                  )}
                </div>

                {openExceptions.length > 0 && (
                  <div className="flex items-center gap-2 pt-2 text-sm text-amber-700 bg-amber-50 p-2.5 rounded border border-amber-200">
                    <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                    <span>{openExceptions.length} unresolved exception(s) require review before posting.</span>
                  </div>
                )}
              </CardContent>
            </Card>

            {runs.length > 1 && (
              <Card>
                <CardHeader><CardTitle className="text-base">Run History ({runs.length})</CardTitle></CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader><TableRow><TableHead>Status</TableHead><TableHead>Type</TableHead><TableHead>Created</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {runs.map((r) => (
                        <TableRow key={r.id} className={r.id === activeRun?.id ? "bg-blue-50 font-medium" : ""}>
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
          </TabsContent>

          {/* ---- Tab 2: Pools ---- */}
          <TabsContent value="pools">
            <Card>
              <CardHeader><CardTitle className="text-base">Pool Results ({poolResults.length})</CardTitle></CardHeader>
              <CardContent>
                {poolResults.length === 0 ? <p className="text-sm text-slate-400 py-4 text-center">No pool results available.</p> : (
                  <Table>
                    <TableHeader><TableRow><TableHead>Pool</TableHead><TableHead className="text-right">Actual Amount</TableHead><TableHead className="text-right">Gross-up Adj.</TableHead><TableHead className="text-right">Adjusted Pool</TableHead><TableHead /></TableRow></TableHeader>
                    <TableBody>
                      {poolResults.map((pr) => (
                        <TableRow key={pr.id}>
                          <TableCell className="text-sm font-medium">{pr.recovery_pools?.name || pr.pool_id.slice(0, 8)}</TableCell>
                          <TableCell className="text-sm text-right">{fmtCurrency(pr.actual_amount)}</TableCell>
                          <TableCell className="text-sm text-right">{fmtCurrency(pr.gross_up_adjustment)}</TableCell>
                          <TableCell className="text-sm text-right font-medium">{fmtCurrency(pr.adjusted_pool)}</TableCell>
                          <TableCell className="text-right">
                            <Link to={`${createPageUrl("CAMPoolDetail")}?cam_run_id=${activeRun?.id}&pool_result_id=${pr.id}`} className="text-xs text-blue-600 underline">Detail</Link>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---- Tab 3: Leases ---- */}
          <TabsContent value="leases">
            <Card>
              <CardHeader><CardTitle className="text-base">Lease Results ({leaseResults.length})</CardTitle></CardHeader>
              <CardContent>
                {leaseResults.length === 0 ? <p className="text-sm text-slate-400 py-4 text-center">No lease results available.</p> : (
                  <Table>
                    <TableHeader><TableRow><TableHead>Tenant</TableHead><TableHead className="text-right">Final Recovery</TableHead><TableHead className="text-right">Estimates Scheduled</TableHead><TableHead className="text-right">Due / (Credit)</TableHead><TableHead /></TableRow></TableHeader>
                    <TableBody>
                      {leaseResults.map((lr) => (
                        <TableRow key={lr.id}>
                          <TableCell className="text-sm font-medium">{lr.leases?.tenant_name || lr.lease_id.slice(0, 8)}</TableCell>
                          <TableCell className="text-sm text-right">{fmtCurrency(lr.final_recovery)}</TableCell>
                          <TableCell className="text-sm text-right">{fmtCurrency(lr.estimates_billed)}</TableCell>
                          <TableCell className={`text-sm text-right font-medium ${Number(lr.amount_due_credit) < 0 ? "text-red-600" : "text-emerald-700"}`}>{fmtCurrency(lr.amount_due_credit)}</TableCell>
                          <TableCell className="text-right">
                            <Link to={`${createPageUrl("CAMLeaseDetail")}?cam_run_id=${activeRun?.id}&lease_result_id=${lr.id}`} className="text-xs text-blue-600 underline">Detail</Link>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---- Tab 4: Exceptions ---- */}
          <TabsContent value="exceptions">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Calculation Exceptions ({exceptions.length})</CardTitle>
                {activeRun && (
                  <Link to={`${createPageUrl("CAMExceptionReview")}?cam_run_id=${activeRun.id}`}>
                    <Button size="sm" variant="outline">Exception Review Page →</Button>
                  </Link>
                )}
              </CardHeader>
              <CardContent>
                {exceptions.length === 0 ? (
                  <p className="text-sm text-emerald-700 py-4 text-center">Zero exceptions recorded for this run.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Severity</TableHead>
                        <TableHead>Code</TableHead>
                        <TableHead>Message</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {exceptions.map((ex) => (
                        <TableRow key={ex.id}>
                          <TableCell>
                            <Badge className={`text-[10px] uppercase ${ex.severity === "blocking" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"}`}>
                              {ex.severity}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{ex.code}</TableCell>
                          <TableCell className="text-xs">{ex.message}</TableCell>
                          <TableCell>
                            <Badge className={`text-[10px] ${ex.resolution_status === "resolved" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                              {ex.resolution_status}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---- Tab 5: Approval ---- */}
          <TabsContent value="approval">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Approval Workflow</CardTitle>
                {activeRun && <StatusBadge status={activeRun.status} />}
              </CardHeader>
              <CardContent className="space-y-4">
                {activeRun ? (
                  <>
                    <p className="text-sm text-slate-600">
                      Current run state: <strong className="uppercase">{activeRun.status}</strong>
                    </p>
                    <div className="flex flex-wrap gap-2 pt-2">
                      {activeRun.status === "calculated" && (
                        <Button onClick={() => doAction("submit_for_review", {}, "Submitted for review")}>
                          <Send className="mr-2 h-4 w-4" /> Submit for Review
                        </Button>
                      )}
                      {(activeRun.status === "submitted" || activeRun.status === "under_review") && (
                        <>
                          <Button
                            className="bg-emerald-600 hover:bg-emerald-700"
                            disabled={blockingExceptions.length > 0}
                            onClick={() => doAction("approve", {}, "Run approved")}
                          >
                            <CheckCircle2 className="mr-2 h-4 w-4" /> Approve Run
                          </Button>
                          <Button
                            variant="destructive"
                            onClick={() => doAction("reject", { reason: "Rejected during review" }, "Run rejected")}
                          >
                            <XCircle className="mr-2 h-4 w-4" /> Reject Run
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => doAction("return_to_draft", { reason: "Returned to draft" }, "Returned to draft")}
                          >
                            Return to Draft
                          </Button>
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-slate-400">Select or calculate a run to view approval controls.</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---- Tab 6: Statements & Export ---- */}
          <TabsContent value="statements" className="space-y-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Reconciliation Statements</CardTitle>
                <Button
                  id="btn-generate-statements"
                  disabled={!isPosted || actionMutation.isPending}
                  onClick={() => doAction("generate_statements", {}, "Statements generated")}
                >
                  <FileDown className="w-4 h-4 mr-2" /> Generate Statements
                </Button>
              </CardHeader>
              <CardContent>
                {!isPosted && (
                  <p className="text-xs text-amber-700 bg-amber-50 p-2.5 rounded mb-4">
                    Statements can be generated once the run is in <strong>posted</strong> status.
                  </p>
                )}
                {statements.length === 0 ? (
                  <p className="text-sm text-slate-400 py-4 text-center">No statements generated yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tenant</TableHead>
                        <TableHead>Schema Version</TableHead>
                        <TableHead className="text-right">Final Recovery</TableHead>
                        <TableHead className="text-right">Amount Due / (Credit)</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {statements.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="font-medium text-sm">{s.leases?.tenant_name ?? "Consolidated"}</TableCell>
                          <TableCell className="text-xs font-mono">v{s.schema_version}</TableCell>
                          <TableCell className="text-right text-sm">{fmtCurrency(s.statement_payload?.final_recovery)}</TableCell>
                          <TableCell className="text-right text-sm font-semibold">{fmtCurrency(s.statement_payload?.amount_due_credit)}</TableCell>
                          <TableCell className="text-right">
                            {s.storage_path && (
                              <a href={s.storage_path} target="_blank" rel="noopener noreferrer">
                                <Button size="sm" variant="outline"><ExternalLink className="w-3 h-3 mr-1" /> PDF</Button>
                              </a>
                            )}
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
                <CardTitle className="text-base">Charge Export (CSV)</CardTitle>
                <Button
                  id="btn-create-export"
                  disabled={!isPosted || actionMutation.isPending}
                  onClick={() => doAction("create_charge_export", {}, "Charge export created")}
                >
                  <Send className="w-4 h-4 mr-2" /> Create Charge Export
                </Button>
              </CardHeader>
              <CardContent>
                {chargeExports.length === 0 ? (
                  <p className="text-sm text-slate-400 py-4 text-center">No charge exports created yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Export ID</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {chargeExports.map((exp) => (
                        <TableRow key={exp.id}>
                          <TableCell className="font-mono text-xs">{exp.id.slice(0, 8)}…</TableCell>
                          <TableCell><StatusBadge status={exp.status} /></TableCell>
                          <TableCell className="text-xs">{fmtDateTime(exp.created_at)}</TableCell>
                          <TableCell className="text-right space-x-2">
                            {exp.status === "pending" && (
                              <Button size="sm" variant="outline" onClick={() => doAction("mark_export_delivered", { export_id: exp.id }, "Delivered")}>
                                Mark Delivered
                              </Button>
                            )}
                            {exp.csv_storage_path && (
                              <a href={exp.csv_storage_path} target="_blank" rel="noopener noreferrer">
                                <Button size="sm" variant="outline"><FileDown className="w-3 h-3 mr-1" /> CSV</Button>
                              </a>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---- Tab 7: Lineage ---- */}
          <TabsContent value="lineage" className="space-y-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Adjustment &amp; Restatement Lineage</CardTitle>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={!isPosted} onClick={() => setAdjDialog(true)}>
                    Create Adjustment Run
                  </Button>
                  <Button size="sm" variant="outline" disabled={!isPosted} onClick={() => setRestateDialog(true)}>
                    Create Restatement Run
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {(lineage.adjustments?.length > 0 || lineage.restatements?.length > 0) ? (
                  <div className="space-y-2 text-sm">
                    {lineage.adjustments?.map((adj) => (
                      <div key={adj.id} className="flex items-center gap-2 p-2 bg-blue-50 rounded">
                        <Package className="w-4 h-4 text-blue-600" />
                        <span>Adjustment Run: <code>{adj.adjustment_run_id.slice(0, 8)}…</code></span>
                        <span className="text-slate-400 text-xs">Reason: {adj.reason}</span>
                      </div>
                    ))}
                    {lineage.restatements?.map((r) => (
                      <div key={r.id} className="flex items-center gap-2 p-2 bg-purple-50 rounded">
                        <RefreshCw className="w-4 h-4 text-purple-600" />
                        <span>Restatement Run: <code>{r.restatement_run_id.slice(0, 8)}…</code></span>
                        <span className="text-slate-400 text-xs">Reason: {r.reason}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">No adjustment or restatement runs in the lineage for this run.</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      {/* Dialogs */}
      <Dialog open={adjDialog} onOpenChange={setAdjDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create Adjustment Run</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Label>Reason for adjustment (required)</Label>
            <Textarea rows={3} value={reasonForm.reason} onChange={(e) => setReasonForm({ reason: e.target.value })} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjDialog(false)}>Cancel</Button>
            <Button onClick={async () => {
              await doAction("create_adjustment_run", { reason: reasonForm.reason }, "Adjustment run created");
              setAdjDialog(false);
              setReasonForm({ reason: "" });
            }}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={restateDialog} onOpenChange={setRestateDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create Restatement Run</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Label>Reason for restatement (required)</Label>
            <Textarea rows={3} value={reasonForm.reason} onChange={(e) => setReasonForm({ reason: e.target.value })} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestateDialog(false)}>Cancel</Button>
            <Button onClick={async () => {
              await doAction("create_restatement_run", { reason: reasonForm.reason }, "Restatement run created");
              setRestateDialog(false);
              setReasonForm({ reason: "" });
            }}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
