import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { budgetService } from "@/services/budgetService";
import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck } from "lucide-react";

const statusColors = {
  draft: "bg-slate-100 text-slate-600",
  ai_generated: "bg-cyan-100 text-cyan-700",
  under_review: "bg-amber-100 text-amber-700",
  reviewed: "bg-blue-100 text-blue-700",
  approved: "bg-emerald-100 text-emerald-700",
  signed: "bg-purple-100 text-purple-700",
  locked: "bg-slate-200 text-slate-800",
};

export default function BudgetStatus() {
  const { data: budgets = [] } = useQuery({
    queryKey: ['budgets-recent'],
    queryFn: () => budgetService.list('-updated_date', 5),
  });

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-base font-bold">Budget Status</CardTitle>
        <Link to="/BudgetDashboard" className="text-xs text-blue-600 hover:underline">View All</Link>
      </CardHeader>
      <CardContent>
        {budgets.length > 0 ? (
          <div className="space-y-1">
            {budgets.map((b, i) => (
              <div key={i} className="flex items-center justify-between py-3 border-b border-slate-100 last:border-0">
                <div>
                  <p className="text-sm font-medium text-slate-900">{b.name}</p>
                  <p className="text-xs text-slate-400">FY {b.budget_year}</p>
                </div>
                <Badge className={`${statusColors[b.status] || 'bg-slate-100 text-slate-600'} text-[10px] font-semibold uppercase tracking-wide`}>
                  {(b.status || 'draft').replace(/_/g, ' ')}
                </Badge>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <ClipboardCheck className="w-10 h-10 text-slate-200 mb-3" />
            <p className="text-sm font-medium text-slate-400">No budgets created yet</p>
            <p className="text-xs text-slate-300 mt-1">Get started by creating your first budget</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}