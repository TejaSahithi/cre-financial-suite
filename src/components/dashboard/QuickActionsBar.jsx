import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Building2, FileText, Calculator, DollarSign, Upload, BarChart3 } from "lucide-react";

const actions = [
  { label: "Property", icon: Building2, page: "Properties", color: "from-blue-500 to-blue-600" },
  { label: "Lease", icon: Upload, page: "LeaseUpload", color: "from-violet-500 to-violet-600" },
  { label: "Expense", icon: DollarSign, page: "AddExpense", color: "from-emerald-500 to-emerald-600" },
  { label: "Budget", icon: Calculator, page: "CreateBudget", color: "from-amber-500 to-orange-500" },
  { label: "CAM", icon: FileText, page: "CAMCalculation", color: "from-rose-500 to-pink-500" },
  { label: "Reports", icon: BarChart3, page: "Reports", color: "from-cyan-500 to-teal-500" },
];

export default function QuickActionsBar() {
  return (
    <div className="flex items-center gap-2 overflow-x-auto">
      <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap mr-1">Quick:</span>
      {actions.map((a, i) => (
        <Link
          key={i}
          to={createPageUrl(a.page)}
          className="group flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-200/80 hover:border-slate-300 hover:shadow-sm transition-all whitespace-nowrap"
        >
          <div className={`w-5 h-5 rounded bg-gradient-to-br ${a.color} flex items-center justify-center`}>
            <a.icon className="w-3 h-3 text-white" />
          </div>
          <span className="text-xs font-semibold text-slate-600 group-hover:text-slate-900">{a.label}</span>
        </Link>
      ))}
    </div>
  );
}