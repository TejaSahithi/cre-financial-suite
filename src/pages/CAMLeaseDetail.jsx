/**
 * CAMLeaseDetail — Enterprise CAM & Budget Implementation Blueprint v1.0,
 * Phase 4A. Shows one lease's effective premises/area, every applicable
 * pool, the full step-by-step calculation trace (tenant share, gross-up,
 * base year, expense stop, caps, admin fee, residual allocation, direct
 * assignment, estimate reconciliation), and the final amount due/credit
 * for a specific CAM run. Pure read-only display of what
 * run-cam-calculation-v2 already persisted — no calculation happens here.
 * NOTE: this is the CAM-engine run detail for a lease, distinct from the
 * existing general-purpose LeaseDetail.jsx (lease abstract/terms page).
 */
import React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText, ArrowLeft } from "lucide-react";

import { supabase } from "@/services/supabaseClient";
import { createPageUrl } from "@/utils";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAssistantPageContext } from "@/assistant/useAssistantContext";

function fmtCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  return num.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export default function CAMLeaseDetail() {
  const [searchParams] = useSearchParams();
  const camRunId = searchParams.get("cam_run_id") || "";
  const leaseResultIdParam = searchParams.get("lease_result_id") || "";
  const leaseIdParam = searchParams.get("lease_id") || "";

  useAssistantPageContext({
    page: "CAMLeaseDetail",
    entities: { camRunId: camRunId || undefined, leaseId: leaseIdParam || undefined },
  });

  const { data: leaseResult, isLoading } = useQuery({
    queryKey: ["cam-lease-detail-result", camRunId, leaseResultIdParam, leaseIdParam],
    queryFn: async () => {
      let query = supabase.from("cam_run_lease_results").select("*, leases(tenant_name)");
      query = leaseResultIdParam ? query.eq("id", leaseResultIdParam) : query.eq("cam_run_id", camRunId).eq("lease_id", leaseIdParam);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: Boolean(leaseResultIdParam) || (Boolean(camRunId) && Boolean(leaseIdParam)),
  });

  const { data: premises = [] } = useQuery({
    queryKey: ["cam-lease-detail-premises", leaseResult?.lease_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("lease_premises")
        .select("*, lease_premises_spaces(*), lease_premises_area_periods(*)")
        .eq("lease_id", leaseResult.lease_id)
        .neq("status", "superseded");
      if (error) throw error;
      return data || [];
    },
    enabled: Boolean(leaseResult?.lease_id),
  });

  const { data: lines = [] } = useQuery({
    queryKey: ["cam-lease-detail-lines", leaseResult?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cam_run_calculation_lines")
        .select("*, cam_run_pool_results(pool_id, recovery_pools(name)), lease_recovery_policy_steps(step_type, source_evidence)")
        .eq("lease_result_id", leaseResult.id)
        .order("sequence", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: Boolean(leaseResult?.id),
  });

  const linesByPool = React.useMemo(() => {
    const byPool = new Map();
    for (const line of lines) {
      const poolName = line.cam_run_pool_results?.recovery_pools?.name || (line.pool_result_id ? "Pool" : "(no pool — direct/estimate line)");
      const key = line.pool_result_id || "none";
      if (!byPool.has(key)) byPool.set(key, { poolName, rows: [] });
      byPool.get(key).rows.push(line);
    }
    return Array.from(byPool.values());
  }, [lines]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={FileText} title="Lease Detail (CAM Run)" subtitle="Every applicable pool, applied policy steps, evidence, and the final amount due for this lease in this run" iconColor="from-blue-500 to-indigo-600" />

      {camRunId && (
        <Link to={`${createPageUrl("CAMRun")}?cam_run_id=${camRunId}`}>
          <Button variant="ghost" size="sm"><ArrowLeft className="mr-2 h-4 w-4" /> Back to CAM Run</Button>
        </Link>
      )}

      {isLoading ? (
        <Card><CardContent className="py-12 text-center text-sm text-slate-400">Loading...</CardContent></Card>
      ) : !leaseResult ? (
        <Card><CardContent className="py-12 text-center text-sm text-slate-400">No lease result found.</CardContent></Card>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">{leaseResult.leases?.tenant_name || leaseResult.lease_id}</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm md:grid-cols-3">
                <div><span className="text-slate-400">Final recovery</span><div className="text-lg font-semibold">{fmtCurrency(leaseResult.final_recovery)}</div></div>
                <div><span className="text-slate-400">Estimates billed</span><div>{fmtCurrency(leaseResult.estimates_billed)}</div></div>
                <div><span className="text-slate-400">Amount due / (credit)</span><div className={`text-lg font-semibold ${Number(leaseResult.amount_due_credit) < 0 ? "text-emerald-600" : ""}`}>{fmtCurrency(leaseResult.amount_due_credit)}</div></div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Effective premises ({premises.length})</CardTitle></CardHeader>
            <CardContent>
              {premises.length === 0 ? <p className="text-sm text-slate-400">No premises on file.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Type</TableHead><TableHead>Effective from</TableHead><TableHead>Effective to</TableHead><TableHead>Recovery area (sqft)</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {premises.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="text-sm">{p.premises_type}</TableCell>
                        <TableCell className="text-sm">{p.effective_from}</TableCell>
                        <TableCell className="text-sm">{p.effective_to || "open"}</TableCell>
                        <TableCell className="text-sm">{(p.lease_premises_area_periods || []).map((ap) => Number(ap.recovery_area_sqft).toLocaleString()).join(", ") || "—"}</TableCell>
                        <TableCell><Badge className={p.status === "approved" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}>{p.status}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {linesByPool.map((group, idx) => (
            <Card key={idx}>
              <CardHeader><CardTitle className="text-base">{group.poolName} — {group.rows.length} calculation line(s)</CardTitle></CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead><TableHead>Step</TableHead><TableHead>Formula</TableHead>
                        <TableHead className="text-right">Input</TableHead><TableHead className="text-right">Output</TableHead><TableHead className="text-right">Adjustment</TableHead>
                        <TableHead>Explanation</TableHead><TableHead>Source evidence</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.rows.map((line) => (
                        <TableRow key={line.id}>
                          <TableCell className="text-xs text-slate-400">{line.sequence}</TableCell>
                          <TableCell className="text-xs"><Badge className="bg-slate-100 text-slate-600">{line.line_type}</Badge></TableCell>
                          <TableCell className="font-mono text-xs">{line.formula_code}</TableCell>
                          <TableCell className="text-right text-xs">{fmtCurrency(line.input_amount)}</TableCell>
                          <TableCell className="text-right text-xs">{fmtCurrency(line.output_amount)}</TableCell>
                          <TableCell className="text-right text-xs">{fmtCurrency(line.adjustment)}</TableCell>
                          <TableCell className="max-w-sm text-xs text-slate-500">{line.explanation}</TableCell>
                          <TableCell className="max-w-xs text-xs text-slate-400">
                            {line.lease_recovery_policy_steps?.source_evidence
                              ? <span title={JSON.stringify(line.lease_recovery_policy_steps.source_evidence)}>evidence on file</span>
                              : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
