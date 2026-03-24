import React from "react";
import { ReconciliationService, LeaseService, BudgetService } from "@/services/api";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { FileText, ClipboardCheck, DollarSign } from "lucide-react";

const statusConfig = {
  draft: { label: "Draft", color: "bg-slate-100 text-slate-700" },
  under_review: { label: "Review", color: "bg-amber-100 text-amber-700" },
  reviewed: { label: "Reviewed", color: "bg-blue-100 text-blue-700" },
  approved: { label: "Approved", color: "bg-emerald-100 text-emerald-700" },
  signed: { label: "Signed", color: "bg-purple-100 text-purple-700" },
  locked: { label: "Locked", color: "bg-slate-200 text-slate-800" },
  ai_generated: { label: "AI Generated", color: "bg-cyan-100 text-cyan-700" },
  extracted: { label: "Extracted", color: "bg-blue-100 text-blue-700" },
  validated: { label: "Validated", color: "bg-emerald-100 text-emerald-700" },
  budget_ready: { label: "Budget Ready", color: "bg-green-100 text-green-700" },
  expired: { label: "Expired", color: "bg-red-100 text-red-700" },
  pending: { label: "Pending", color: "bg-amber-100 text-amber-700" },
  in_progress: { label: "In Progress", color: "bg-blue-100 text-blue-700" },
  completed: { label: "Completed", color: "bg-emerald-100 text-emerald-700" },
};

export default function Workflows() {
  const { data: budgets = [] } = useQuery({ queryKey: ['budgets'], queryFn: () => BudgetService.list('-updated_date') });
  const { data: leases = [] } = useQuery({ queryKey: ['leases'], queryFn: () => LeaseService.list('-updated_date') });
  const { data: recons = [] } = useQuery({ queryKey: ['recons'], queryFn: () => ReconciliationService.list('-updated_date') });

  const getStatus = (s) => statusConfig[s] || { label: s, color: "bg-slate-100 text-slate-600" };

  const budgetPending = budgets.filter(b => !['approved','locked'].includes(b.status));
  const leasePending = leases.filter(l => !['budget_ready','expired'].includes(l.status));
  const reconPending = recons.filter(r => r.status !== 'approved');

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Workflows</h1>
          <p className="text-sm text-slate-500">Approval queues and review pipelines</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center"><ClipboardCheck className="w-5 h-5 text-blue-600" /></div>
          <div><p className="text-[10px] font-semibold text-slate-500 uppercase">Budget Approvals</p><p className="text-xl font-bold">{budgetPending.length} pending</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center"><FileText className="w-5 h-5 text-emerald-600" /></div>
          <div><p className="text-[10px] font-semibold text-slate-500 uppercase">Lease Approvals</p><p className="text-xl font-bold">{leasePending.length} pending</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center"><DollarSign className="w-5 h-5 text-purple-600" /></div>
          <div><p className="text-[10px] font-semibold text-slate-500 uppercase">Reconciliation Reviews</p><p className="text-xl font-bold">{reconPending.length} pending</p></div>
        </CardContent></Card>
      </div>

      <Tabs defaultValue="budgets">
        <TabsList>
          <TabsTrigger value="budgets">Budget Approval</TabsTrigger>
          <TabsTrigger value="leases">Lease Approval</TabsTrigger>
          <TabsTrigger value="recons">Reconciliation Review</TabsTrigger>
        </TabsList>

        <TabsContent value="budgets" className="mt-4">
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow className="bg-slate-50">
                <TableHead className="text-[11px]">BUDGET</TableHead>
                <TableHead className="text-[11px]">YEAR</TableHead>
                <TableHead className="text-[11px]">REVENUE</TableHead>
                <TableHead className="text-[11px]">EXPENSES</TableHead>
                <TableHead className="text-[11px]">STATUS</TableHead>
                <TableHead className="text-[11px]">ACTIONS</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {budgets.slice(0, 20).map(b => (
                  <TableRow key={b.id}>
                    <TableCell className="font-medium">{b.name}</TableCell>
                    <TableCell>{b.budget_year}</TableCell>
                    <TableCell className="font-mono">${(b.total_revenue || 0).toLocaleString()}</TableCell>
                    <TableCell className="font-mono">${(b.total_expenses || 0).toLocaleString()}</TableCell>
                    <TableCell><Badge className={getStatus(b.status).color}>{getStatus(b.status).label}</Badge></TableCell>
                    <TableCell><Link to={createPageUrl("BudgetReview") + `?id=${b.id}`}><Button variant="ghost" size="sm" className="text-xs">Review</Button></Link></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="leases" className="mt-4">
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow className="bg-slate-50">
                <TableHead className="text-[11px]">TENANT</TableHead>
                <TableHead className="text-[11px]">TYPE</TableHead>
                <TableHead className="text-[11px]">START</TableHead>
                <TableHead className="text-[11px]">END</TableHead>
                <TableHead className="text-[11px]">STATUS</TableHead>
                <TableHead className="text-[11px]">ACTIONS</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {leases.slice(0, 20).map(l => (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">{l.tenant_name}</TableCell>
                    <TableCell><Badge variant="outline" className="text-[10px]">{l.lease_type}</Badge></TableCell>
                    <TableCell className="text-sm">{l.start_date}</TableCell>
                    <TableCell className="text-sm">{l.end_date}</TableCell>
                    <TableCell><Badge className={getStatus(l.status).color}>{getStatus(l.status).label}</Badge></TableCell>
                    <TableCell><Link to={createPageUrl("LeaseReview") + `?id=${l.id}`}><Button variant="ghost" size="sm" className="text-xs">Review</Button></Link></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="recons" className="mt-4">
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow className="bg-slate-50">
                <TableHead className="text-[11px]">FISCAL YEAR</TableHead>
                <TableHead className="text-[11px]">BUDGETED CAM</TableHead>
                <TableHead className="text-[11px]">ACTUAL CAM</TableHead>
                <TableHead className="text-[11px]">VARIANCE</TableHead>
                <TableHead className="text-[11px]">STATUS</TableHead>
                <TableHead className="text-[11px]">ACTIONS</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {recons.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.fiscal_year}</TableCell>
                    <TableCell className="font-mono">${(r.budgeted_cam_pool || 0).toLocaleString()}</TableCell>
                    <TableCell className="font-mono">${(r.actual_cam_pool || 0).toLocaleString()}</TableCell>
                    <TableCell className="font-mono">${(r.total_variance || 0).toLocaleString()}</TableCell>
                    <TableCell><Badge className={getStatus(r.status).color}>{getStatus(r.status).label}</Badge></TableCell>
                    <TableCell><Link to={createPageUrl("Reconciliation")}><Button variant="ghost" size="sm" className="text-xs">Review</Button></Link></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}