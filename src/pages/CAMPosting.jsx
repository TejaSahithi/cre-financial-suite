/**
 * CAMPosting — Phase 4B: posted-run lifecycle page.
 *
 * Features (all behind FEATURE_CAM_POSTING_ENABLED):
 *   1. Posted run summary (lease results, pool summaries)
 *   2. Reconciliation statement preview (renders statement_payload JSON)
 *   3. Statement generation / download (calls generate_statements)
 *   4. Charge export — create, cancel, mark delivered (idempotent)
 *   5. Adjustment / Restatement run creation (with reason dialog)
 *   6. Posted-run lineage breadcrumb (original → adjustment/restatement chain)
 *
 * This page is not routed when FEATURE_CAM_POSTING_ENABLED is absent from
 * the app config. The page itself also shows a disabled banner when the
 * feature flag is not enabled, so a stale route config does not silently
 * expose post controls.
 */
import React, { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2, AlertTriangle, ExternalLink, ChevronRight,
  FileDown, Send, RefreshCw, XCircle, Loader2, Package, Lock,
} from "lucide-react";

import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { createPageUrl } from "@/utils";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Tabs, TabsList, TabsTrigger, TabsContent,
} from "@/components/ui/tabs";
import {
  Alert, AlertDescription,
} from "@/components/ui/alert";

// ---- Feature flag -----------------------------------------------------------
// Reads from the app's env. If VITE_FEATURE_CAM_POSTING_ENABLED is not "true"
// the page renders a locked banner and disables all write actions.
const POSTING_ENABLED = import.meta.env.VITE_FEATURE_CAM_POSTING_ENABLED === "true";

// ---- Helpers ----------------------------------------------------------------

function fmtCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function StatusBadge({ status }) {
  const tone =
    status === "posted"      ? "bg-emerald-100 text-emerald-700"
    : status === "delivered" ? "bg-blue-100 text-blue-700"
    : status === "pending"   ? "bg-amber-100 text-amber-800"
    : status === "cancelled" ? "bg-slate-100 text-slate-500"
    : status === "issued"    ? "bg-emerald-100 text-emerald-700"
    : "bg-slate-100 text-slate-600";
  return <Badge className={`text-[10px] uppercase font-semibold ${tone}`}>{status}</Badge>;
}

async function workflowAction(action, payload) {
  const { data, error } = await invokeEdgeFunction("cam-run-workflow-v2", { action, ...payload });
  if (error) throw new Error(error.message ?? JSON.stringify(error));
  return data;
}

// ---- Main component ---------------------------------------------------------

export default function CAMPosting() {
  const [searchParams] = useSearchParams();
  const camRunId = searchParams.get("cam_run_id") ?? "";
  const queryClient = useQueryClient();

  const [adjDialog, setAdjDialog] = useState(false);
  const [restateDialog, setRestateDialog] = useState(false);
  const [exportCancelDialog, setExportCancelDialog] = useState(null); // exportId
  const [reasonForm, setReasonForm] = useState({ reason: "" });

  // ---- Data queries ---------------------------------------------------------

  const { data: run, isLoading: runLoading } = useQuery({
    queryKey: ["cam_run", camRunId],
    enabled: !!camRunId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cam_runs")
        .select("*, recovery_periods(label, start_date, end_date)")
        .eq("id", camRunId)
        .single();
      if (error) throw error;
      return data;
    },
  });

  const { data: leaseResults = [] } = useQuery({
    queryKey: ["cam_run_lease_results", camRunId],
    enabled: !!camRunId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cam_run_lease_results")
        .select("*, leases(tenant_name)")
        .eq("cam_run_id", camRunId)
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: poolResults = [] } = useQuery({
    queryKey: ["cam_run_pool_results", camRunId],
    enabled: !!camRunId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cam_run_pool_results")
        .select("*, recovery_pools(name)")
        .eq("cam_run_id", camRunId)
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: statements = [], refetch: refetchStatements } = useQuery({
    queryKey: ["cam_run_statements", camRunId],
    enabled: !!camRunId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cam_run_statements")
        .select("*, leases(tenant_name)")
        .eq("cam_run_id", camRunId)
        .neq("status", "void")
        .order("generated_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: chargeExports = [], refetch: refetchExports } = useQuery({
    queryKey: ["cam_charge_exports", camRunId],
    enabled: !!camRunId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cam_charge_exports")
        .select("*")
        .eq("cam_run_id", camRunId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: lineage = {} } = useQuery({
    queryKey: ["cam_run_lineage", camRunId],
    enabled: !!camRunId,
    queryFn: async () => {
      const [adj, restate] = await Promise.all([
        supabase.from("cam_adjustment_runs").select("*").eq("original_run_id", camRunId),
        supabase.from("cam_restatement_runs").select("*").eq("superseded_run_id", camRunId),
      ]);
      return { adjustments: adj.data ?? [], restatements: restate.data ?? [] };
    },
  });

  // ---- Mutations ------------------------------------------------------------

  const mutation = useMutation({
    mutationFn: ({ action, payload }) => workflowAction(action, { cam_run_id: camRunId, ...payload }),
    onError: (err) => toast.error(err.message),
  });

  const doAction = (action, payload, successMsg) =>
    mutation.mutateAsync({ action, payload }, {
      onSuccess: () => {
        toast.success(successMsg ?? "Done");
        queryClient.invalidateQueries({ queryKey: ["cam_run", camRunId] });
        queryClient.invalidateQueries({ queryKey: ["cam_run_statements", camRunId] });
        queryClient.invalidateQueries({ queryKey: ["cam_charge_exports", camRunId] });
        queryClient.invalidateQueries({ queryKey: ["cam_run_lineage", camRunId] });
      },
    });

  // ---- Feature flag guard ---------------------------------------------------

  if (!POSTING_ENABLED) {
    return (
      <div className="space-y-6">
        <PageHeader title="CAM Posting" subtitle="Phase 4B — Production Posting Pipeline" />
        <Alert className="border-amber-300 bg-amber-50">
          <Lock className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-amber-800">
            <strong>Posting is not enabled in this environment.</strong> The Phase 4B acceptance gate has not been
            fully verified. Set <code>VITE_FEATURE_CAM_POSTING_ENABLED=true</code> and{" "}
            <code>FEATURE_CAM_POSTING_ENABLED=true</code> only after all gate items pass.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // ---- Render ---------------------------------------------------------------

  if (!camRunId) {
    return (
      <div className="space-y-4">
        <PageHeader title="CAM Posting" subtitle="Phase 4B" />
        <p className="text-sm text-slate-500">No run selected. Navigate here from a posted run.</p>
      </div>
    );
  }

  if (runLoading) {
    return (
      <div className="flex items-center gap-2 py-8">
        <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
        <span className="text-sm text-slate-500">Loading posted run…</span>
      </div>
    );
  }

  const period = run?.recovery_periods;
  const isPosted = run?.status === "posted";
  const activeExport = chargeExports.find((e) => e.status === "pending");
  const deliveredExport = chargeExports.find((e) => e.status === "delivered");

  return (
    <div className="space-y-6">
      <PageHeader
        title={`CAM Posting — ${period?.label ?? run?.id?.slice(0, 8)}`}
        subtitle={`${period?.start_date ?? ""} → ${period?.end_date ?? ""} · Run ID: ${camRunId.slice(0, 8)}…`}
      />

      {/* Status + immutability notice */}
      <div className="flex items-center gap-3">
        <StatusBadge status={run?.status} />
        {isPosted && (
          <div className="flex items-center gap-1.5 text-xs text-emerald-700">
            <Lock className="w-3.5 h-3.5" />
            <span>Immutable — calculation lines, pool results, and lease results are locked.</span>
          </div>
        )}
        {!isPosted && (
          <div className="flex items-center gap-1.5 text-xs text-amber-700">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>Run status is <strong>{run?.status}</strong> — must be approved before posting.</span>
          </div>
        )}
      </div>

      {/* Lineage breadcrumb */}
      {(lineage.adjustments?.length > 0 || lineage.restatements?.length > 0) && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Run Lineage</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {lineage.adjustments.map((adj) => (
              <div key={adj.id} className="flex items-center gap-2 text-sm">
                <Package className="w-3.5 h-3.5 text-blue-500" />
                <span>Adjustment run: </span>
                <Link to={createPageUrl("CAMRun") + `?cam_run_id=${adj.adjustment_run_id}`} className="text-blue-600 underline underline-offset-2 text-xs">
                  {adj.adjustment_run_id.slice(0, 8)}…
                </Link>
                <span className="text-slate-400 text-xs">Reason: {adj.reason}</span>
              </div>
            ))}
            {lineage.restatements.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-sm">
                <RefreshCw className="w-3.5 h-3.5 text-purple-500" />
                <span>Restatement run: </span>
                <Link to={createPageUrl("CAMRun") + `?cam_run_id=${r.restatement_run_id}`} className="text-purple-600 underline underline-offset-2 text-xs">
                  {r.restatement_run_id.slice(0, 8)}…
                </Link>
                <span className="text-slate-400 text-xs">Reason: {r.reason}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="summary">
        <TabsList id="posting-tabs">
          <TabsTrigger value="summary" id="tab-summary">Summary</TabsTrigger>
          <TabsTrigger value="statements" id="tab-statements">Statements</TabsTrigger>
          <TabsTrigger value="export" id="tab-export">Charge Export</TabsTrigger>
          <TabsTrigger value="lifecycle" id="tab-lifecycle">Adjustment / Restatement</TabsTrigger>
        </TabsList>

        {/* ---- Summary ---- */}
        <TabsContent value="summary" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Lease Results</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tenant</TableHead>
                    <TableHead className="text-right">Final Recovery</TableHead>
                    <TableHead className="text-right">Estimates Billed</TableHead>
                    <TableHead className="text-right">Amount Due / (Credit)</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leaseResults.map((lr) => (
                    <TableRow key={lr.id}>
                      <TableCell className="font-medium">{lr.leases?.tenant_name ?? lr.lease_id.slice(0, 8) + "…"}</TableCell>
                      <TableCell className="text-right">{fmtCurrency(lr.final_recovery)}</TableCell>
                      <TableCell className="text-right">{fmtCurrency(lr.estimates_billed)}</TableCell>
                      <TableCell className={`text-right font-semibold ${Number(lr.amount_due_credit) < 0 ? "text-red-600" : "text-emerald-700"}`}>
                        {fmtCurrency(lr.amount_due_credit)}
                      </TableCell>
                      <TableCell><StatusBadge status={lr.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Pool Summaries</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Pool</TableHead>
                    <TableHead className="text-right">Actual Amount</TableHead>
                    <TableHead className="text-right">Gross-Up Adj.</TableHead>
                    <TableHead className="text-right">Adjusted Pool</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {poolResults.map((pr) => (
                    <TableRow key={pr.id}>
                      <TableCell className="font-medium">{pr.recovery_pools?.name ?? pr.pool_id.slice(0, 8) + "…"}</TableCell>
                      <TableCell className="text-right">{fmtCurrency(pr.actual_amount)}</TableCell>
                      <TableCell className="text-right">{fmtCurrency(pr.gross_up_adjustment)}</TableCell>
                      <TableCell className="text-right font-semibold">{fmtCurrency(pr.adjusted_pool)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Statements ---- */}
        <TabsContent value="statements" className="space-y-4 mt-4">
          <div className="flex justify-end">
            <Button
              id="btn-generate-statements"
              disabled={!isPosted || mutation.isPending}
              onClick={() => doAction("generate_statements", {}, "Statements generated")}
            >
              {mutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileDown className="w-4 h-4 mr-2" />}
              Generate Statements
            </Button>
          </div>

          {statements.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-slate-500">
                No statements generated yet. Click "Generate Statements" above.
              </CardContent>
            </Card>
          )}

          {statements.map((stmt) => (
            <Card key={stmt.id}>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-sm">
                  {stmt.leases?.tenant_name ?? "Consolidated"} — {stmt.schema_version}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <StatusBadge status={stmt.status} />
                  <span className="text-xs text-slate-400">Hash: {stmt.content_hash?.slice(0, 12)}…</span>
                  {stmt.storage_path && (
                    <a href={stmt.storage_path} target="_blank" rel="noopener noreferrer">
                      <Button size="sm" variant="outline" id={`btn-download-stmt-${stmt.id}`}>
                        <ExternalLink className="w-3 h-3 mr-1" /> Download
                      </Button>
                    </a>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {/* Statement payload preview — key financial fields */}
                {stmt.statement_payload && (
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-xs text-slate-500 mb-0.5">Final Recovery</p>
                      <p className="font-semibold">{fmtCurrency(stmt.statement_payload.final_recovery)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 mb-0.5">Estimates Billed</p>
                      <p className="font-semibold">{fmtCurrency(stmt.statement_payload.estimates_billed)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 mb-0.5">Amount Due / (Credit)</p>
                      <p className={`font-semibold ${Number(stmt.statement_payload.amount_due_credit) < 0 ? "text-red-600" : "text-emerald-700"}`}>
                        {fmtCurrency(stmt.statement_payload.amount_due_credit)}
                      </p>
                    </div>
                  </div>
                )}
                <p className="text-xs text-slate-400 mt-3">
                  Generated {new Date(stmt.generated_at).toLocaleString()} · Schema v{stmt.schema_version} · Template v{stmt.template_version}
                </p>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        {/* ---- Charge Export ---- */}
        <TabsContent value="export" className="space-y-4 mt-4">
          {!activeExport && !deliveredExport && (
            <div className="flex justify-end">
              <Button
                id="btn-create-export"
                disabled={!isPosted || mutation.isPending}
                onClick={() => doAction("create_charge_export", {}, "Charge export created")}
              >
                <Send className="w-4 h-4 mr-2" />
                Create Charge Export
              </Button>
            </div>
          )}

          {chargeExports.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-slate-500">
                No charge exports yet. Click "Create Charge Export" above.
              </CardContent>
            </Card>
          )}

          {chargeExports.map((exp) => (
            <Card key={exp.id}>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-sm">Export {exp.id.slice(0, 8)}…</CardTitle>
                <div className="flex items-center gap-2">
                  <StatusBadge status={exp.status} />
                  {exp.status === "pending" && (
                    <>
                      <Button size="sm" id={`btn-deliver-export-${exp.id}`} variant="outline"
                        onClick={() => doAction("mark_export_delivered", { export_id: exp.id }, "Export marked delivered")}>
                        <CheckCircle2 className="w-3 h-3 mr-1" /> Mark Delivered
                      </Button>
                      <Button size="sm" variant="ghost" id={`btn-cancel-export-${exp.id}`}
                        onClick={() => setExportCancelDialog(exp.id)}>
                        <XCircle className="w-3 h-3 text-red-400" />
                      </Button>
                    </>
                  )}
                  {exp.csv_storage_path && (
                    <a href={exp.csv_storage_path} target="_blank" rel="noopener noreferrer">
                      <Button size="sm" variant="outline" id={`btn-download-export-${exp.id}`}>
                        <FileDown className="w-3 h-3 mr-1" /> CSV
                      </Button>
                    </a>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-slate-400">
                  Created {new Date(exp.created_at).toLocaleString()}
                  {exp.delivered_at && ` · Delivered ${new Date(exp.delivered_at).toLocaleString()}`}
                  {exp.cancelled_at && ` · Cancelled ${new Date(exp.cancelled_at).toLocaleString()}`}
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  {exp.export_payload?.rows?.length ?? 0} lease charge row(s) · Export schema v{exp.export_version}
                </p>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        {/* ---- Lifecycle ---- */}
        <TabsContent value="lifecycle" className="space-y-4 mt-4">
          <div className="flex gap-3">
            <Button
              id="btn-create-adjustment"
              variant="outline"
              disabled={!isPosted}
              onClick={() => setAdjDialog(true)}
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Create Adjustment Run
            </Button>
            <Button
              id="btn-create-restatement"
              variant="outline"
              disabled={!isPosted}
              onClick={() => setRestateDialog(true)}
            >
              <Package className="w-4 h-4 mr-2" />
              Create Restatement Run
            </Button>
          </div>

          <Card>
            <CardHeader><CardTitle className="text-sm">What's the difference?</CardTitle></CardHeader>
            <CardContent className="text-sm text-slate-600 space-y-2">
              <p><strong>Adjustment run</strong> — corrects a specific line item within the same period without superseding the original. Both runs coexist. Use for tenant-level corrections that don't require re-posting the full period.</p>
              <p><strong>Restatement run</strong> — replaces the original run entirely. When approved and posted, the original run is moved to <code>superseded</code>. Use when the pool calculation itself was wrong and the entire period must be re-issued.</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ---- Dialogs ---- */}

      {/* Create Adjustment Run */}
      <Dialog open={adjDialog} onOpenChange={setAdjDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create Adjustment Run</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Reason (required)</Label>
              <Textarea id="adj-reason" rows={3} placeholder="Describe the correction being made..."
                value={reasonForm.reason} onChange={(e) => setReasonForm({ reason: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjDialog(false)}>Cancel</Button>
            <Button id="btn-save-adjustment" onClick={async () => {
              await doAction("create_adjustment_run", { reason: reasonForm.reason }, "Adjustment run created");
              setAdjDialog(false);
              setReasonForm({ reason: "" });
            }}>Create Adjustment Run</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Restatement Run */}
      <Dialog open={restateDialog} onOpenChange={setRestateDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create Restatement Run</DialogTitle></DialogHeader>
          <Alert className="border-amber-200 bg-amber-50 my-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-amber-800 text-xs">
              When the restatement run is posted, this run will be moved to <strong>superseded</strong>. This is irreversible.
            </AlertDescription>
          </Alert>
          <div className="space-y-3">
            <div>
              <Label>Reason (required)</Label>
              <Textarea id="restate-reason" rows={3} placeholder="Describe why a full restatement is needed..."
                value={reasonForm.reason} onChange={(e) => setReasonForm({ reason: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestateDialog(false)}>Cancel</Button>
            <Button id="btn-save-restatement" onClick={async () => {
              await doAction("create_restatement_run", { reason: reasonForm.reason }, "Restatement run created");
              setRestateDialog(false);
              setReasonForm({ reason: "" });
            }}>Create Restatement Run</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Export */}
      <Dialog open={!!exportCancelDialog} onOpenChange={() => setExportCancelDialog(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cancel Charge Export</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-600">This will cancel the pending export. You can create a new one afterward.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExportCancelDialog(null)}>Back</Button>
            <Button variant="destructive" id="btn-confirm-cancel-export" onClick={async () => {
              await doAction("cancel_charge_export", { export_id: exportCancelDialog }, "Export cancelled");
              setExportCancelDialog(null);
            }}>Cancel Export</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
