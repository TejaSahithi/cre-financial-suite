/**
 * CAMPoolDetail — Enterprise CAM & Budget Implementation Blueprint v1.0,
 * Phase 4A. Shows one pool's source expenses, category inclusions/
 * exclusions, gross-up, adjusted pool total, and every participating
 * lease's calculation lines against this pool for a specific CAM run. Pure
 * read-only display of what run-cam-calculation-v2 already persisted — no
 * calculation happens in this component.
 */
import React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Layers, ArrowLeft } from "lucide-react";

import { supabase } from "@/services/supabaseClient";
import { useAssistantPageContext } from "@/assistant/useAssistantContext";
import { createPageUrl } from "@/utils";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function fmtCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  return num.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export default function CAMPoolDetail() {
  const [searchParams] = useSearchParams();
  const camRunId = searchParams.get("cam_run_id") || "";
  const poolResultId = searchParams.get("pool_result_id") || "";

  const { data: run } = useQuery({
    queryKey: ["cam-pool-detail-run", camRunId],
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_runs").select("id, scope_type, scope_id, recovery_period_id").eq("id", camRunId).single();
      if (error) throw error;
      return data;
    },
    enabled: Boolean(camRunId),
  });

  const { data: poolResult, isLoading } = useQuery({
    queryKey: ["cam-pool-detail-result", poolResultId],
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_run_pool_results").select("*, recovery_pools(name, pool_type, scope_type, property_id, default_gross_up_target_pct, recovery_pool_categories(expense_category_id, inclusion_mode))").eq("id", poolResultId).single();
      if (error) throw error;
      return data;
    },
    enabled: Boolean(poolResultId),
  });

  const { data: lines = [] } = useQuery({
    queryKey: ["cam-pool-detail-lines", poolResultId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cam_run_calculation_lines")
        .select("*, cam_run_lease_results(lease_id, leases(tenant_name))")
        .eq("pool_result_id", poolResultId)
        .order("sequence", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: Boolean(poolResultId),
  });

  const propertyId = run?.scope_type === "property" ? run.scope_id : poolResult?.recovery_pools?.property_id || null;
  useAssistantPageContext({
    page: "CAMPoolDetail",
    route: window.location.pathname + window.location.search,
    entities: {
      propertyId: propertyId || undefined,
      camRunId: camRunId || undefined,
      camPoolResultId: poolResultId || undefined,
    },
  });

  const participatingLeases = React.useMemo(() => {
    const byLease = new Map();
    for (const line of lines) {
      const leaseId = line.cam_run_lease_results?.lease_id;
      if (!leaseId) continue;
      const name = line.cam_run_lease_results?.leases?.tenant_name || leaseId.slice(0, 8);
      if (!byLease.has(leaseId)) byLease.set(leaseId, { leaseId, name, lineCount: 0 });
      byLease.get(leaseId).lineCount += 1;
    }
    return Array.from(byLease.values());
  }, [lines]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={Layers} title="Pool Detail" subtitle="Source expenses, allocations, gross-up, and every participating lease's lines for this pool" iconColor="from-blue-500 to-indigo-600" />

      {camRunId && (
        <Link to={`${createPageUrl("CAMRun")}?cam_run_id=${camRunId}`}>
          <Button variant="ghost" size="sm"><ArrowLeft className="mr-2 h-4 w-4" /> Back to CAM Run</Button>
        </Link>
      )}

      {!poolResultId ? (
        <Card><CardContent className="py-12 text-center text-sm text-slate-400">No pool selected.</CardContent></Card>
      ) : isLoading ? (
        <Card><CardContent className="py-12 text-center text-sm text-slate-400">Loading...</CardContent></Card>
      ) : !poolResult ? (
        <Card><CardContent className="py-12 text-center text-sm text-slate-400">Pool result not found.</CardContent></Card>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">{poolResult.recovery_pools?.name || "Pool"}</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm md:grid-cols-4">
                <div><span className="text-slate-400">Pool type</span><div>{poolResult.recovery_pools?.pool_type}</div></div>
                <div><span className="text-slate-400">Scope</span><div>{poolResult.recovery_pools?.scope_type}</div></div>
                <div><span className="text-slate-400">Source (actual) amount</span><div className="font-medium">{fmtCurrency(poolResult.actual_amount)}</div></div>
                <div><span className="text-slate-400">Excluded amount</span><div>{fmtCurrency(poolResult.excluded_amount)}</div></div>
                <div><span className="text-slate-400">Gross-up adjustment</span><div>{fmtCurrency(poolResult.gross_up_adjustment)}</div></div>
                <div><span className="text-slate-400">Amortization</span><div>{fmtCurrency(poolResult.amortization)}</div></div>
                <div><span className="text-slate-400">Adjusted pool total</span><div className="font-semibold">{fmtCurrency(poolResult.adjusted_pool)}</div></div>
                <div><span className="text-slate-400">Default gross-up target</span><div>{poolResult.recovery_pools?.default_gross_up_target_pct != null ? `${poolResult.recovery_pools.default_gross_up_target_pct}%` : "—"}</div></div>
              </div>

              {(poolResult.recovery_pools?.recovery_pool_categories || []).length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium text-slate-400">Category inclusions / exclusions</p>
                  <div className="flex flex-wrap gap-2">
                    {poolResult.recovery_pools.recovery_pool_categories.map((c, i) => (
                      <Badge key={i} className={c.inclusion_mode === "include" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}>
                        {c.inclusion_mode === "include" ? "include" : "exclude"}: {c.expense_category_id.slice(0, 8)}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Participating leases ({participatingLeases.length})</CardTitle></CardHeader>
            <CardContent>
              {participatingLeases.length === 0 ? <p className="text-sm text-slate-400">No leases recovered anything from this pool.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Tenant</TableHead><TableHead>Calculation lines</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>
                    {participatingLeases.map((l) => (
                      <TableRow key={l.leaseId}>
                        <TableCell className="text-sm font-medium">{l.name}</TableCell>
                        <TableCell className="text-sm">{l.lineCount}</TableCell>
                        <TableCell>
                          <Link to={`${createPageUrl("CAMLeaseDetail")}?cam_run_id=${camRunId}&lease_id=${l.leaseId}`} className="text-xs text-blue-600 underline">Lease detail</Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Calculation lines ({lines.length})</CardTitle></CardHeader>
            <CardContent>
              {lines.length === 0 ? <p className="text-sm text-slate-400">No calculation lines for this pool.</p> : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead><TableHead>Tenant</TableHead><TableHead>Type</TableHead><TableHead>Formula</TableHead>
                        <TableHead className="text-right">Input</TableHead><TableHead className="text-right">Output</TableHead><TableHead className="text-right">Adjustment</TableHead><TableHead>Explanation</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lines.map((line) => (
                        <TableRow key={line.id}>
                          <TableCell className="text-xs text-slate-400">{line.sequence}</TableCell>
                          <TableCell className="text-sm">{line.cam_run_lease_results?.leases?.tenant_name || line.cam_run_lease_results?.lease_id?.slice(0, 8) || "—"}</TableCell>
                          <TableCell className="text-xs"><Badge className="bg-slate-100 text-slate-600">{line.line_type}</Badge></TableCell>
                          <TableCell className="font-mono text-xs">{line.formula_code}</TableCell>
                          <TableCell className="text-right text-xs">{fmtCurrency(line.input_amount)}</TableCell>
                          <TableCell className="text-right text-xs">{fmtCurrency(line.output_amount)}</TableCell>
                          <TableCell className="text-right text-xs">{fmtCurrency(line.adjustment)}</TableCell>
                          <TableCell className="max-w-md text-xs text-slate-500">{line.explanation}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}


