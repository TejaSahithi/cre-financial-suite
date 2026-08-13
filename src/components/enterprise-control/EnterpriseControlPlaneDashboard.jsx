import React from "react";
import { AlertTriangle, Archive, Gauge, KeyRound, LifeBuoy, LockKeyhole, RotateCcw, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const controls = [
  { label: "Enterprise RBAC", value: "Policy-based", icon: LockKeyhole, tone: "bg-blue-50 text-blue-700" },
  { label: "Support Access", value: "Scoped", icon: LifeBuoy, tone: "bg-emerald-50 text-emerald-700" },
  { label: "Residency", value: "Fail closed", icon: ShieldCheck, tone: "bg-blue-50 text-blue-700" },
  { label: "Retention", value: "Legal hold aware", icon: Archive, tone: "bg-slate-50 text-slate-700" },
  { label: "Error Budgets", value: "Rollout gate", icon: Gauge, tone: "bg-amber-50 text-amber-700" },
  { label: "Credentials", value: "Rotated", icon: KeyRound, tone: "bg-cyan-50 text-cyan-700" },
  { label: "DR", value: "Exercise required", icon: RotateCcw, tone: "bg-blue-50 text-blue-700" },
  { label: "Legacy Paths", value: "Measured", icon: AlertTriangle, tone: "bg-rose-50 text-rose-700" },
];

export default function EnterpriseControlPlaneDashboard() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-lg">Enterprise Control Plane</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-4">
            {controls.map((control) => {
              const Icon = control.icon;
              return (
                <div key={control.label} className="rounded-md border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs text-slate-500">{control.label}</p>
                      <p className="text-sm font-semibold text-slate-900">{control.value}</p>
                    </div>
                    <div className={`rounded-md p-2 ${control.tone}`}><Icon className="h-4 w-4" /></div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {["diagnostic", "enforced_internal", "pilot", "production", "broad_ga"].map((mode) => (
              <Badge key={mode} variant="outline" className="bg-white text-slate-600">{mode}</Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}