import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { Upload, ClipboardCheck, DollarSign, Calculator, BarChart3, ArrowLeftRight } from "lucide-react";

const actions = [
  { icon: Upload, label: "Upload Lease", page: "/LeaseUpload", color: "text-blue-600" },
  { icon: ClipboardCheck, label: "Create Budget", page: "/CreateBudget", color: "text-emerald-600" },
  { icon: DollarSign, label: "Add Expense", page: "/AddExpense", color: "text-amber-600" },
  { icon: Calculator, label: "Run CAM Calc", page: "/CAMCalculation", color: "text-violet-600" },
  { icon: BarChart3, label: "Year-End Recon", page: "/Reconciliation", color: "text-rose-600" },
  { icon: ArrowLeftRight, label: "YoY Comparison", page: "/Comparison", color: "text-slate-600" },
];

export default function QuickActions() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-bold">Quick Actions</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          {actions.map((a, i) => (
            <Link key={i} to={a.page}>
              <Button variant="outline" className="w-full justify-start gap-2.5 h-11 text-sm font-medium text-slate-700 hover:bg-slate-50 border-slate-200">
                <a.icon className={`w-4 h-4 ${a.color}`} />
                {a.label}
              </Button>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}