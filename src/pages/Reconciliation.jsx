import React, { useState } from "react";
import { ReconciliationService } from "@/services/api";
import useOrgQuery from "@/hooks/useOrgQuery";
import useOrgId from "@/hooks/useOrgId";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Upload, AlertTriangle, Loader2, CheckCircle2, Calculator, Trash2 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import DeleteConfirmDialog from "@/components/DeleteConfirmDialog";
import { toast } from "sonner";

export default function Reconciliation() {
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const queryClient = useQueryClient();
  const { orgId } = useOrgId();

  const { data: reconciliations = [] } = useOrgQuery("Reconciliation");
  const { data: budgets = [] } = useOrgQuery("Budget");
  const { data: expenses = [] } = useOrgQuery("Expense");
  const { data: camCalcs = [] } = useOrgQuery("CAMCalculation");
  const { data: leases = [] } = useOrgQuery("Lease");

  const currentRecon = reconciliations.find(r => r.fiscal_year === selectedYear);
  const yearBudgets = budgets.filter(b => b.budget_year === selectedYear);
  const yearExpenses = expenses.filter(e => e.fiscal_year === selectedYear);
  const yearCAMs = camCalcs.filter(c => c.fiscal_year === selectedYear);

  const budgetedCAMPool = yearBudgets.reduce((s, b) => s + (b.cam_total || 0), 0);
  const actualCAMPool = yearExpenses
    .filter(e => e.classification === 'recoverable')
    .reduce((s, e) => s + (e.amount || 0), 0);
  const totalVariance = actualCAMPool - budgetedCAMPool;

  // Build category comparison
  const budgetByCategory = {};
  yearBudgets.forEach(b => {
    (b.expense_items || []).forEach(item => {
      if (item.classification === 'recoverable' || !item.classification) {
        budgetByCategory[item.category || 'Other'] = (budgetByCategory[item.category || 'Other'] || 0) + (item.amount || 0);
      }
    });
  });

  const actualByCategory = {};
  yearExpenses.filter(e => e.classification === 'recoverable').forEach(e => {
    actualByCategory[e.category || 'other'] = (actualByCategory[e.category || 'other'] || 0) + (e.amount || 0);
  });

  const allCategories = [...new Set([...Object.keys(budgetByCategory), ...Object.keys(actualByCategory)])];
  const categoryComparison = allCategories.map(cat => ({
    category: cat.replace(/_/g, ' '),
    budgeted: budgetByCategory[cat] || 0,
    actual: actualByCategory[cat] || 0,
    variance: (actualByCategory[cat] || 0) - (budgetByCategory[cat] || 0),
  })).sort((a, b) => b.variance - a.variance);

  // Tenant adjustments from CAM calcs — Recon Adjustment = Actual Share − Estimated CAM Paid
  const tenantAdjustments = yearCAMs.map(cam => {
    const lease = leases.find(l => l.id === cam.lease_id);
    const budgetedCAM = cam.annual_cam || 0;
    const share = cam.tenant_share_pct || 0;
    const actualShare = actualCAMPool * (share / 100);
    const adjustment = actualShare - budgetedCAM;

    // Statutory deadline from lease
    const reconDeadlineDays = lease?.recon_deadline_days || 90;
    const collectionLimitMonths = lease?.recon_collection_limit_months || 12;
    const yearEnd = new Date(selectedYear, 11, 31);
    const deadlineDate = new Date(yearEnd);
    deadlineDate.setDate(deadlineDate.getDate() + reconDeadlineDays);
    const collectionLimitDate = new Date(yearEnd);
    collectionLimitDate.setMonth(collectionLimitDate.getMonth() + collectionLimitMonths);

    const now = new Date();
    const pastDeadline = now > deadlineDate;
    const pastCollectionLimit = now > collectionLimitDate;

    return {
      tenant: cam.tenant_name || lease?.tenant_name || 'Unknown',
      lease_id: cam.lease_id,
      budgeted: budgetedCAM,
      actual: actualShare,
      adjustment,
      type: adjustment > 0 ? 'owed' : 'refund',
      deadlineDate: deadlineDate.toISOString().split('T')[0],
      collectionLimitDate: collectionLimitDate.toISOString().split('T')[0],
      pastDeadline,
      pastCollectionLimit,
      reconDeadlineDays,
      collectionLimitMonths,
    };
  });

  const tenantsOwed = tenantAdjustments.filter(t => t.adjustment > 0);
  const tenantsRefund = tenantAdjustments.filter(t => t.adjustment <= 0);

  const chartData = categoryComparison.slice(0, 10);

  const createMutation = useMutation({
    mutationFn: (data) => ReconciliationService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reconciliations'] });
      setShowCreate(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      const ok = await ReconciliationService.delete(id);
      if (!ok) throw new Error("Delete failed");
      return id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["Reconciliation"] });
      queryClient.invalidateQueries({ queryKey: ["reconciliations"] });
      setDeleteTarget(null);
      toast.success("Reconciliation deleted successfully");
    },
    onError: (err) => {
      toast.error(`Failed to delete reconciliation: ${err?.message || "Unknown error"}`);
    },
  });

  const hasExpenseData = yearExpenses.length > 0;
  const statusColors = {
    pending: "bg-amber-100 text-amber-700",
    in_progress: "bg-blue-100 text-blue-700",
    completed: "bg-emerald-100 text-emerald-700",
    approved: "bg-green-100 text-green-700",
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Year-End CAM Reconciliation</h1>
          <p className="text-sm text-slate-500 mt-0.5">Compare budgeted CAM with actual expenses and generate tenant adjustments</p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={String(selectedYear)} onValueChange={v => setSelectedYear(Number(v))}>
            <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[2024, 2025, 2026].map(y => (
                <SelectItem key={y} value={String(y)}>FY {y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => setShowCreate(true)}>
            <Calculator className="w-4 h-4 mr-2" />Run Reconciliation
          </Button>
        </div>
      </div>

      {/* Alert if no actuals */}
      {!hasExpenseData && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            <p className="text-sm text-amber-800">No actual expenses imported for FY {selectedYear}. Import from your accounting system or upload a CSV file.</p>
          </div>
          <Button size="sm" className="bg-amber-600 hover:bg-amber-700"><Upload className="w-4 h-4 mr-2" />Import Now</Button>
        </div>
      )}

      {/* Status of current reconciliation */}
      {currentRecon && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-blue-500" />
            <div>
              <p className="text-sm font-medium text-blue-800">Reconciliation for FY {selectedYear}</p>
              <p className="text-xs text-blue-600">Status: {currentRecon.status} · Deadline: {currentRecon.deadline || 'Not set'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge className={statusColors[currentRecon.status] || 'bg-slate-100 text-slate-600'}>
              {currentRecon.status?.replace('_', ' ')}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-red-500 hover:text-red-600"
              onClick={() => setDeleteTarget(currentRecon)}
              title="Delete reconciliation"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-l-4 border-l-blue-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Budgeted CAM Pool</p>
            <p className="text-2xl font-bold text-slate-900">${budgetedCAMPool.toLocaleString()}</p>
            <p className="text-[10px] text-slate-400">From {yearBudgets.length} budgets</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-slate-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Actual CAM Pool</p>
            <p className="text-2xl font-bold text-slate-900">${actualCAMPool.toLocaleString()}</p>
            <p className="text-[10px] text-slate-400">{yearExpenses.filter(e => e.classification === 'recoverable').length} recoverable expenses</p>
          </CardContent>
        </Card>
        <Card className={`border-l-4 ${totalVariance > 0 ? 'border-l-red-500' : 'border-l-emerald-500'}`}>
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Total Variance</p>
            <p className={`text-2xl font-bold ${totalVariance > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
              {totalVariance > 0 ? '+' : ''}${totalVariance.toLocaleString()}
            </p>
            <p className="text-[10px] text-slate-400">{budgetedCAMPool ? ((totalVariance / budgetedCAMPool) * 100).toFixed(1) : 0}% {totalVariance > 0 ? 'over' : 'under'} budget</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">Tenant Adjustments</p>
            <p className="text-2xl font-bold text-slate-900">{tenantAdjustments.length}</p>
            <p className="text-[10px] text-slate-400">{tenantsOwed.length} owed · {tenantsRefund.length} refund</p>
          </CardContent>
        </Card>
      </div>

      {/* Chart */}
      {chartData.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Budget vs Actual — Recoverable Expenses</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(0)}K`} />
                <YAxis type="category" dataKey="category" width={130} tick={{ fontSize: 10 }} />
                <Tooltip formatter={v => `$${v.toLocaleString()}`} />
                <Legend />
                <Bar dataKey="budgeted" fill="#1a2744" name="Budgeted" radius={[0, 2, 2, 0]} />
                <Bar dataKey="actual" fill="#3b82f6" name="Actual" radius={[0, 2, 2, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Expense comparison table */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Expense Category Comparison</CardTitle>
            <span className="text-sm text-slate-400">FY {selectedYear}</span>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="text-[11px]">EXPENSE CATEGORY</TableHead>
                  <TableHead className="text-[11px] text-right">BUDGETED</TableHead>
                  <TableHead className="text-[11px] text-right">ACTUAL</TableHead>
                  <TableHead className="text-[11px] text-right">VARIANCE</TableHead>
                  <TableHead className="text-[11px] text-right">% CHANGE</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categoryComparison.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-12 text-slate-400 text-sm">
                      No expense data available for FY {selectedYear}
                    </TableCell>
                  </TableRow>
                ) : categoryComparison.map(row => {
                  const pct = row.budgeted ? ((row.variance / row.budgeted) * 100).toFixed(1) : '0';
                  return (
                    <TableRow key={row.category}>
                      <TableCell className="text-sm font-medium capitalize">{row.category}</TableCell>
                      <TableCell className="text-sm text-right font-mono">${row.budgeted.toLocaleString()}</TableCell>
                      <TableCell className="text-sm text-right font-mono">${row.actual.toLocaleString()}</TableCell>
                      <TableCell className={`text-sm text-right font-mono ${row.variance > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                        {row.variance > 0 ? '+' : ''}${row.variance.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge className={Math.abs(parseFloat(pct)) > 10 ? 'bg-red-100 text-red-700' : row.variance > 0 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}>
                          {pct}%
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {categoryComparison.length > 0 && (
                  <TableRow className="bg-slate-50 font-bold">
                    <TableCell>Total CAM Pool</TableCell>
                    <TableCell className="text-right font-mono">${budgetedCAMPool.toLocaleString()}</TableCell>
                    <TableCell className="text-right font-mono">${actualCAMPool.toLocaleString()}</TableCell>
                    <TableCell className={`text-right font-mono ${totalVariance > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                      {totalVariance > 0 ? '+' : ''}${totalVariance.toLocaleString()}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Tenant adjustments */}
        <Card>
          <CardHeader><CardTitle className="text-base">Tenant Adjustments</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {tenantAdjustments.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">No CAM calculations for FY {selectedYear}</p>
            ) : tenantAdjustments.map((t, i) => (
             <div key={i} className={`p-3 rounded-lg ${t.pastCollectionLimit ? 'bg-red-50 border border-red-200' : t.pastDeadline ? 'bg-amber-50 border border-amber-200' : 'bg-slate-50'}`}>
               <div className="flex items-center justify-between mb-1">
                 <p className="text-sm font-semibold text-slate-900">{t.tenant}</p>
                 <Badge className={t.type === 'owed' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}>
                   {t.type === 'owed' ? 'Tenant Owes' : 'Refund Due'}
                 </Badge>
               </div>
               <div className="flex justify-between text-xs text-slate-500">
                 <span>Budgeted: ${t.budgeted.toLocaleString()}</span>
                 <span>Actual: ${Math.round(t.actual).toLocaleString()}</span>
               </div>
               <p className={`text-right text-sm font-bold mt-1 ${t.adjustment > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                 {t.adjustment > 0 ? '+' : ''}${Math.round(t.adjustment).toLocaleString()}
               </p>
               <div className="mt-2 pt-2 border-t border-slate-200 text-[10px] text-slate-400 space-y-0.5">
                 <p>Recon deadline: {t.deadlineDate} ({t.reconDeadlineDays}d from year-end)
                   {t.pastDeadline && <span className="text-amber-600 font-semibold ml-1">OVERDUE</span>}
                 </p>
                 <p>Collection limit: {t.collectionLimitDate} ({t.collectionLimitMonths}mo)
                   {t.pastCollectionLimit && <span className="text-red-600 font-semibold ml-1">EXPIRED — Cannot collect</span>}
                 </p>
               </div>
             </div>
            ))}
            {currentRecon && currentRecon.status !== 'approved' && tenantAdjustments.length > 0 && (
              <Button className="w-full bg-emerald-600 hover:bg-emerald-700">
                <CheckCircle2 className="w-4 h-4 mr-2" />Approve Reconciliation
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Previous reconciliations */}
      {reconciliations.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Reconciliation History</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="text-[11px]">FISCAL YEAR</TableHead>
                  <TableHead className="text-[11px] text-right">BUDGETED CAM</TableHead>
                  <TableHead className="text-[11px] text-right">ACTUAL CAM</TableHead>
                  <TableHead className="text-[11px] text-right">VARIANCE</TableHead>
                  <TableHead className="text-[11px]">STATUS</TableHead>
                  <TableHead className="text-[11px]">APPROVED BY</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reconciliations.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">FY {r.fiscal_year}</TableCell>
                    <TableCell className="text-right font-mono">${(r.budgeted_cam_pool || 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right font-mono">${(r.actual_cam_pool || 0).toLocaleString()}</TableCell>
                    <TableCell className={`text-right font-mono ${(r.total_variance || 0) > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                      ${(r.total_variance || 0).toLocaleString()}
                    </TableCell>
                    <TableCell><Badge className={statusColors[r.status] || 'bg-slate-100'}>{r.status?.replace('_', ' ')}</Badge></TableCell>
                    <TableCell className="text-sm text-slate-500">{r.approved_by || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete reconciliation for FY ${deleteTarget?.fiscal_year || ""}?`}
        description="This will permanently remove the selected reconciliation record."
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
      />

      {/* Create Reconciliation Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Run Reconciliation — FY {selectedYear}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-slate-50 rounded-lg p-4">
                <p className="text-xs font-semibold text-slate-500 uppercase mb-1">Budgeted CAM Pool</p>
                <p className="text-xl font-bold">${budgetedCAMPool.toLocaleString()}</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-4">
                <p className="text-xs font-semibold text-slate-500 uppercase mb-1">Actual CAM Pool</p>
                <p className="text-xl font-bold">${actualCAMPool.toLocaleString()}</p>
              </div>
            </div>
            <div className={`p-4 rounded-lg ${totalVariance > 0 ? 'bg-red-50' : 'bg-emerald-50'}`}>
              <p className="text-xs font-semibold text-slate-500 uppercase mb-1">Total Variance</p>
              <p className={`text-2xl font-bold ${totalVariance > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                {totalVariance > 0 ? '+' : ''}${totalVariance.toLocaleString()}
              </p>
            </div>
            <p className="text-xs text-slate-500">
              This will create a reconciliation record for FY {selectedYear} with the current budget and expense data.
              You can review and approve it later.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button
              onClick={() => {
                const yearEnd = new Date(selectedYear, 11, 31);
                const defaultDeadline = new Date(yearEnd);
                defaultDeadline.setDate(defaultDeadline.getDate() + 90);
                createMutation.mutate({
                  org_id: orgId || "",
                  property_id: 'all',
                  fiscal_year: selectedYear,
                  budgeted_cam_pool: budgetedCAMPool,
                  actual_cam_pool: actualCAMPool,
                  total_variance: totalVariance,
                  expense_comparison: categoryComparison,
                  tenant_adjustments: tenantAdjustments,
                  status: 'pending',
                  deadline: defaultDeadline.toISOString().split('T')[0],
                  lease_deadline_days: 90,
                  auto_adjustments_generated: true,
                });
              }}
              disabled={createMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Create Reconciliation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
