/**
 * CAMExceptionReview — Enterprise CAM & Budget Implementation Blueprint
 * v1.0, Phase 4A. Every blocking/warning exception a CAM run's engine
 * output raised, with a resolution action (resolve/waive + mandatory
 * note) recorded against the responsible user — the audit trail Approval
 * later checks for "unexplained exceptions prohibited". This page never
 * recomputes or reinterprets an exception; it only records a human
 * decision about one the engine already raised.
 */
import React, { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Send } from "lucide-react";

import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { createPageUrl } from "@/utils";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function SeverityBadge({ severity }) {
  const tone = severity === "blocking" ? "bg-red-100 text-red-700" : severity === "warning" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600";
  return <Badge className={`text-[10px] ${tone}`}>{severity}</Badge>;
}
function ResolutionBadge({ status }) {
  const tone = status === "open" ? "bg-red-100 text-red-700" : status === "resolved" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600";
  return <Badge className={`text-[10px] ${tone}`}>{status}</Badge>;
}

export default function CAMExceptionReview() {
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const camRunId = searchParams.get("cam_run_id") || "";
  const [dialogException, setDialogException] = useState(null);
  const [resolutionStatus, setResolutionStatus] = useState("resolved");
  const [resolutionNote, setResolutionNote] = useState("");

  const { data: run } = useQuery({
    queryKey: ["cam-exception-review-run", camRunId],
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_runs").select("*").eq("id", camRunId).single();
      if (error) throw error;
      return data;
    },
    enabled: Boolean(camRunId),
  });

  const { data: exceptions = [], refetch } = useQuery({
    queryKey: ["cam-exception-review-list", camRunId],
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_run_exceptions").select("*").eq("cam_run_id", camRunId).order("severity", { ascending: true }).order("created_at", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: Boolean(camRunId),
  });

  const resolvedByIds = Array.from(new Set(exceptions.map((e) => e.resolved_by).filter(Boolean)));
  const { data: resolvers = {} } = useQuery({
    queryKey: ["cam-exception-review-resolvers", resolvedByIds.join(",")],
    queryFn: async () => {
      if (resolvedByIds.length === 0) return {};
      const { data, error } = await supabase.from("profiles").select("id, full_name, email").in("id", resolvedByIds);
      if (error) throw error;
      return Object.fromEntries((data || []).map((p) => [p.id, p.full_name || p.email]));
    },
    enabled: resolvedByIds.length > 0,
  });

  const resolveMutation = useMutation({
    mutationFn: () =>
      invokeEdgeFunction("cam-run-workflow-v2", {
        cam_run_id: camRunId, action: "resolve_exception", exception_id: dialogException.id, resolution_status: resolutionStatus, resolution_note: resolutionNote,
      }),
    onSuccess: () => {
      toast.success("Exception recorded.");
      setDialogException(null);
      setResolutionNote("");
      refetch();
      queryClient.invalidateQueries({ queryKey: ["cam-run-exception-counts"] });
    },
    onError: (err) => toast.error(err?.message || "Could not record resolution"),
  });

  const submitMutation = useMutation({
    mutationFn: () => invokeEdgeFunction("cam-run-workflow-v2", { cam_run_id: camRunId, action: "submit_for_review" }),
    onSuccess: () => toast.success("Submitted for review."),
    onError: (err) => toast.error(err?.message || "Could not submit for review"),
  });

  const blockingOpen = exceptions.filter((e) => e.severity === "blocking" && e.resolution_status === "open");

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={AlertTriangle} title="Exception Review" subtitle="Every exception this run raised, and its resolution/waiver evidence" iconColor="from-amber-500 to-orange-600" />

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
              <CardTitle className="text-base">Run {run?.status && <Badge className="ml-2 bg-slate-100 text-slate-600">{run.status}</Badge>}</CardTitle>
              {run?.status === "calculated" && (
                <Button size="sm" onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending}>
                  <Send className="mr-2 h-4 w-4" /> Submit for Review
                </Button>
              )}
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge className="bg-red-100 text-red-700">{exceptions.filter((e) => e.severity === "blocking").length} blocking</Badge>
                <Badge className="bg-amber-100 text-amber-800">{exceptions.filter((e) => e.severity === "warning").length} warning</Badge>
                <Badge className="bg-red-100 text-red-700">{blockingOpen.length} unresolved blocking</Badge>
              </div>
              {blockingOpen.length > 0 && (
                <p className="mt-2 text-xs text-red-600">Every blocking exception must be resolved or waived — with a recorded reason — before this run can be approved.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Exceptions ({exceptions.length})</CardTitle></CardHeader>
            <CardContent>
              {exceptions.length === 0 ? <p className="text-sm text-slate-400">No exceptions on this run.</p> : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Severity</TableHead><TableHead>Code</TableHead><TableHead>Message</TableHead>
                      <TableHead>Resolution</TableHead><TableHead>Responsible user</TableHead><TableHead>Note</TableHead><TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {exceptions.map((exc) => (
                      <TableRow key={exc.id}>
                        <TableCell><SeverityBadge severity={exc.severity} /></TableCell>
                        <TableCell className="font-mono text-xs">{exc.code}</TableCell>
                        <TableCell className="max-w-md text-sm">{exc.message}</TableCell>
                        <TableCell><ResolutionBadge status={exc.resolution_status} /></TableCell>
                        <TableCell className="text-xs text-slate-500">{exc.resolved_by ? (resolvers[exc.resolved_by] || exc.resolved_by.slice(0, 8)) : "—"}</TableCell>
                        <TableCell className="max-w-xs text-xs text-slate-500">{exc.resolution_note || "—"}</TableCell>
                        <TableCell>
                          {exc.resolution_status === "open" && (
                            <Button size="sm" variant="outline" onClick={() => { setDialogException(exc); setResolutionStatus("resolved"); setResolutionNote(""); }}>
                              Resolve
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={Boolean(dialogException)} onOpenChange={(open) => !open && setDialogException(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve exception</DialogTitle>
            <DialogDescription>{dialogException?.message}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex gap-2">
              <Button size="sm" variant={resolutionStatus === "resolved" ? "default" : "outline"} onClick={() => setResolutionStatus("resolved")}>Resolved</Button>
              <Button size="sm" variant={resolutionStatus === "waived" ? "default" : "outline"} onClick={() => setResolutionStatus("waived")}>Waived</Button>
            </div>
            <Textarea placeholder="Explain what was checked or why this can be waived — this note is required and becomes part of the run's audit history." value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} rows={4} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogException(null)}>Cancel</Button>
            <Button onClick={() => resolveMutation.mutate()} disabled={!resolutionNote.trim() || resolveMutation.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
