/**
 * CAMApproval — Enterprise CAM & Budget Implementation Blueprint v1.0,
 * Phase 4A. Summary totals, a hard block on approving while any blocking
 * exception is still open ("unexplained exceptions prohibited" — enforced
 * server-side by approve_cam_run, not just hidden here), the actual
 * approve/reject/return-to-draft actions, and the immutable approval
 * evidence (who, when) once approved. Posting (APPROVED -> POSTED) is
 * intentionally NOT offered anywhere on this page — that is gated behind
 * Workstream B's release-readiness acceptance (Phase 4B).
 */
import React, { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, ArrowLeft, XCircle, RotateCcw } from "lucide-react";

import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { createNotificationsForEvent } from "@/services/notificationService";
import useOrgQuery from "@/hooks/useOrgQuery";
import { createPageUrl } from "@/utils";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
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

export default function CAMApproval() {
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const camRunId = searchParams.get("cam_run_id") || "";
  const [dialogAction, setDialogAction] = useState(null); // 'reject' | 'return_to_draft'
  const [reason, setReason] = useState("");
  const { data: properties = [] } = useOrgQuery("Property");

  const { data: run, refetch: refetchRun } = useQuery({
    queryKey: ["cam-approval-run", camRunId],
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_runs").select("*").eq("id", camRunId).single();
      if (error) throw error;
      return data;
    },
    enabled: Boolean(camRunId),
  });

  const { data: leaseResults = [] } = useQuery({
    queryKey: ["cam-approval-lease-results", camRunId],
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_run_lease_results").select("*, leases(tenant_name)").eq("cam_run_id", camRunId);
      if (error) throw error;
      return data || [];
    },
    enabled: Boolean(camRunId),
  });

  const { data: exceptions = [] } = useQuery({
    queryKey: ["cam-approval-exceptions", camRunId],
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_run_exceptions").select("*").eq("cam_run_id", camRunId);
      if (error) throw error;
      return data || [];
    },
    enabled: Boolean(camRunId),
  });

  const openBlocking = exceptions.filter((e) => e.severity === "blocking" && e.resolution_status === "open");

  const totals = leaseResults.reduce((acc, r) => ({
    finalRecovery: acc.finalRecovery + Number(r.final_recovery || 0),
    estimatesBilled: acc.estimatesBilled + Number(r.estimates_billed || 0),
    amountDueCredit: acc.amountDueCredit + Number(r.amount_due_credit || 0),
  }), { finalRecovery: 0, estimatesBilled: 0, amountDueCredit: 0 });

  const invalidate = () => {
    refetchRun();
    queryClient.invalidateQueries({ queryKey: ["cam-run-list"] });
  };
  const activeProperty = properties.find((property) => property.id === run?.property_id || property.id === run?.scope_id) || null;
  const notifyCamApprovalEvent = (eventType, source, result) => {
    createNotificationsForEvent({
      org_id: run?.org_id || activeProperty?.org_id,
      event_type: eventType,
      entity_type: "cam",
      entity_id: camRunId,
      entity_label: activeProperty?.name ? `${activeProperty.name} CAM` : "CAM Run",
      property_id: run?.property_id || run?.scope_id || null,
      action_url: `${createPageUrl("CAMApproval")}?cam_run_id=${camRunId}`,
      metadata: {
        source,
        property_name: activeProperty?.name || null,
        fiscal_year: run?.fiscal_year || run?.recovery_year || null,
        status: result?.status || run?.status || null,
      },
    }).catch((error) => {
      console.warn("[CAMApproval] notification event failed:", error?.message || error);
    });
  };

  const approveMutation = useMutation({
    mutationFn: () => invokeEdgeFunction("cam-run-workflow-v2", { cam_run_id: camRunId, action: "approve" }),
    onSuccess: (result) => { notifyCamApprovalEvent("cam.approved", "cam_approval_page_approve", result); toast.success("Run approved."); invalidate(); },
    onError: (err) => toast.error(err?.message || "Could not approve — check for unresolved blocking exceptions"),
  });

  const reasonMutation = useMutation({
    mutationFn: () => invokeEdgeFunction("cam-run-workflow-v2", { cam_run_id: camRunId, action: dialogAction, reason }),
    onSuccess: (result) => {
      if (dialogAction === "reject") notifyCamApprovalEvent("cam.review_required", "cam_approval_page_reject", result);
      toast.success(dialogAction === "reject" ? "Run rejected." : "Run returned to draft.");
      setDialogAction(null);
      setReason("");
      invalidate();
    },
    onError: (err) => toast.error(err?.message || "Action failed"),
  });

  const isSubmitted = run?.status === "submitted";
  const isApproved = run?.status === "approved";

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={CheckCircle2} title="Approval" subtitle="Summary totals, exception status, and the final approve/reject decision" iconColor="from-emerald-500 to-teal-600" />

      {camRunId && (
        <Link to={`${createPageUrl("CAMRun")}?cam_run_id=${camRunId}`}>
          <Button variant="ghost" size="sm"><ArrowLeft className="mr-2 h-4 w-4" /> Back to CAM Run</Button>
        </Link>
      )}

      {!camRunId ? (
        <Card><CardContent className="py-12 text-center text-sm text-slate-400">No CAM run selected.</CardContent></Card>
      ) : (
        <>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Run summary</CardTitle>
              {run?.status && <Badge className={isApproved ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}>{run.status}</Badge>}
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div><span className="text-xs text-slate-400">Total final recovery</span><div className="text-xl font-semibold">{fmtCurrency(totals.finalRecovery)}</div></div>
                <div><span className="text-xs text-slate-400">Total estimates billed</span><div className="text-xl font-semibold">{fmtCurrency(totals.estimatesBilled)}</div></div>
                <div><span className="text-xs text-slate-400">Total due / (credit)</span><div className={`text-xl font-semibold ${totals.amountDueCredit < 0 ? "text-emerald-600" : ""}`}>{fmtCurrency(totals.amountDueCredit)}</div></div>
              </div>

              {isApproved ? (
                <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                  Approved on {fmtDateTime(run.approved_at)}. This result is now immutable except for posting (not yet enabled) or a future adjustment/restatement run.
                </div>
              ) : openBlocking.length > 0 ? (
                <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {openBlocking.length} unresolved blocking exception(s) — approval is prohibited until every one is resolved or waived.{" "}
                  <Link to={`${createPageUrl("CAMExceptionReview")}?cam_run_id=${camRunId}`} className="underline">Go to Exception Review</Link>
                </div>
              ) : (
                <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">No unresolved blocking exceptions.</div>
              )}

              {isSubmitted && (
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button onClick={() => approveMutation.mutate()} disabled={approveMutation.isPending || openBlocking.length > 0}>
                    <CheckCircle2 className="mr-2 h-4 w-4" /> Approve
                  </Button>
                  <Button variant="outline" onClick={() => { setDialogAction("reject"); setReason(""); }}>
                    <XCircle className="mr-2 h-4 w-4" /> Reject
                  </Button>
                  <Button variant="outline" onClick={() => { setDialogAction("return_to_draft"); setReason(""); }}>
                    <RotateCcw className="mr-2 h-4 w-4" /> Return to Draft
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Lease results ({leaseResults.length})</CardTitle></CardHeader>
            <CardContent>
              {leaseResults.length === 0 ? <p className="text-sm text-slate-400">No lease results.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Tenant</TableHead><TableHead>Final recovery</TableHead><TableHead>Estimates billed</TableHead><TableHead>Due / credit</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>
                    {leaseResults.map((lr) => (
                      <TableRow key={lr.id}>
                        <TableCell className="text-sm font-medium">{lr.leases?.tenant_name || lr.lease_id.slice(0, 8)}</TableCell>
                        <TableCell className="text-sm">{fmtCurrency(lr.final_recovery)}</TableCell>
                        <TableCell className="text-sm">{fmtCurrency(lr.estimates_billed)}</TableCell>
                        <TableCell className={`text-sm font-medium ${Number(lr.amount_due_credit) < 0 ? "text-emerald-600" : ""}`}>{fmtCurrency(lr.amount_due_credit)}</TableCell>
                        <TableCell><Link to={`${createPageUrl("CAMLeaseDetail")}?cam_run_id=${camRunId}&lease_result_id=${lr.id}`} className="text-xs text-blue-600 underline">Detail</Link></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={Boolean(dialogAction)} onOpenChange={(open) => !open && setDialogAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogAction === "reject" ? "Reject this run" : "Return this run to draft"}</DialogTitle>
          </DialogHeader>
          <Textarea placeholder="A reason is required and becomes part of this run's audit history." value={reason} onChange={(e) => setReason(e.target.value)} rows={4} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogAction(null)}>Cancel</Button>
            <Button onClick={() => reasonMutation.mutate()} disabled={!reason.trim() || reasonMutation.isPending}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
