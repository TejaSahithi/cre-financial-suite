import React from "react";
import useOrgQuery from "@/hooks/useOrgQuery";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Plus, Download, Mail, Loader2, CheckCircle2, X } from "lucide-react";

export default function BudgetDashboard() {
  const { data: budgets = [], isLoading } = useOrgQuery("Budget");

  const statusColors = {
    draft: "bg-slate-100 text-slate-600", ai_generated: "bg-blue-100 text-blue-700",
    under_review: "bg-red-100 text-red-700", reviewed: "bg-amber-100 text-amber-700",
    approved: "bg-emerald-100 text-emerald-700", signed: "bg-green-100 text-green-700",
    locked: "bg-slate-800 text-white"
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Budget Dashboard</h1>
        <Link to={createPageUrl("CreateBudget")}><Button className="bg-blue-600 hover:bg-blue-700"><Plus className="w-4 h-4 mr-2" />Create Budget</Button></Link>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-64"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
      ) : budgets.length === 0 ? (
        <Card><CardContent className="p-12 text-center text-slate-400">
          <p>No budgets created yet</p>
          <Link to={createPageUrl("CreateBudget")}><Button className="mt-4">Create First Budget</Button></Link>
        </CardContent></Card>
      ) : (
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="space-y-3">
            {budgets.map(b => (
              <Card key={b.id} className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-blue-500">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm font-bold text-slate-900">{b.name}</p>
                      <p className="text-xs text-slate-400">{b.budget_year} · {b.generation_method?.replace('_', ' ')}</p>
                    </div>
                    <Badge className={`${statusColors[b.status]} text-[10px] uppercase`}>{b.status?.replace('_', ' ')}</Badge>
                  </div>
                  <div className="flex gap-6 mt-3 text-xs text-slate-500">
                    <span className="text-emerald-600 font-medium">${((b.total_revenue || 0) / 1000).toFixed(0)}K Revenue</span>
                    <span className="text-red-500 font-medium">${((b.total_expenses || 0) / 1000).toFixed(0)}K Expenses</span>
                    <span className="font-bold text-slate-900">${((b.noi || 0) / 1000).toFixed(0)}K NOI</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {budgets.length > 0 && (
            <div className="lg:col-span-2">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-base">{budgets[0].name}</CardTitle>
                    <p className="text-xs text-slate-400">{budgets[0].budget_year} · {budgets[0].generation_method?.replace('_', ' ')}</p>
                  </div>
                  <Badge className={`${statusColors[budgets[0].status]} uppercase text-[10px]`}>{budgets[0].status?.replace('_', ' ')}</Badge>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid grid-cols-4 gap-4">
                    <div className="p-4 bg-slate-50 rounded-xl"><p className="text-xs text-slate-500">Total Revenue</p><p className="text-xl font-bold text-slate-900">${(budgets[0].total_revenue || 0).toLocaleString()}</p></div>
                    <div className="p-4 bg-slate-50 rounded-xl"><p className="text-xs text-slate-500">Total Expenses</p><p className="text-xl font-bold text-red-600">${(budgets[0].total_expenses || 0).toLocaleString()}</p></div>
                    <div className="p-4 bg-slate-50 rounded-xl"><p className="text-xs text-slate-500">CAM Total</p><p className="text-xl font-bold text-blue-600">${(budgets[0].cam_total || 0).toLocaleString()}</p></div>
                    <div className="p-4 bg-slate-50 rounded-xl"><p className="text-xs text-slate-500">NOI</p><p className="text-xl font-bold text-emerald-600">${(budgets[0].noi || 0).toLocaleString()}</p></div>
                  </div>

                  {budgets[0].ai_insights && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                      <p className="text-xs font-semibold text-amber-700 mb-1">AI Insights</p>
                      <p className="text-sm text-amber-800">{budgets[0].ai_insights}</p>
                    </div>
                  )}

                  <div className="flex gap-3">
                    <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700"><CheckCircle2 className="w-4 h-4 mr-2" />Approve Budget</Button>
                    <Button variant="outline" className="text-red-500 border-red-200 hover:bg-red-50"><X className="w-4 h-4 mr-2" />Reject</Button>
                  </div>
                  <div className="flex gap-3">
                    <Button variant="outline" className="flex-1"><Download className="w-4 h-4 mr-2" />Download Excel/CSV</Button>
                    <Button variant="outline" className="flex-1"><Mail className="w-4 h-4 mr-2" />Email to Stakeholders</Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}