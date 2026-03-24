import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function BudgetReview() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-slate-900 mb-2">Budget Review</h1>
      <p className="text-sm text-slate-500 mb-6">Review and approve budgets from the Budget Dashboard.</p>
      <Link to={createPageUrl("BudgetDashboard")}><Button>Go to Budget Dashboard <ArrowRight className="w-4 h-4 ml-2" /></Button></Link>
    </div>
  );
}