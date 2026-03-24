import React from "react";
import { Link } from "react-router-dom";
import { Progress } from "@/components/ui/progress";
import { ChevronRight, Building2, FileText, ClipboardCheck } from "lucide-react";

const setupSteps = [
  { icon: Building2, label: "Add your first property", page: "/Properties" },
  { icon: FileText, label: "Upload a lease", page: "/LeaseUpload" },
  { icon: ClipboardCheck, label: "Create a budget", page: "/CreateBudget" },
];

export default function SetupBanner({ completedSteps = 0, totalSteps = 3 }) {
  const pct = Math.round((completedSteps / totalSteps) * 100);

  return (
    <div className="bg-gradient-to-r from-[#1a2744] to-[#243b67] rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-white text-sm font-semibold">
          Get Started — {completedSteps} of {totalSteps} steps complete
        </p>
        <p className="text-white/60 text-xs">{pct}%</p>
      </div>
      <Progress value={pct} className="h-2 bg-white/20 [&>div]:bg-emerald-400 mb-4" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {setupSteps.map((step, i) => {
          const done = i < completedSteps;
          return (
            <Link key={i} to={step.page}>
              <div className={`flex items-center gap-3 p-3 rounded-lg transition-colors ${done ? 'bg-white/10 opacity-60' : 'bg-white/5 hover:bg-white/10'}`}>
                <step.icon className="w-5 h-5 text-white/70" />
                <div className="flex-1">
                  <p className={`text-sm font-medium ${done ? 'text-white/50 line-through' : 'text-white'}`}>{step.label}</p>
                </div>
                {!done && <ChevronRight className="w-4 h-4 text-white/40" />}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}