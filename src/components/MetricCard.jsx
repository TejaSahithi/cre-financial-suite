import React from "react";
import CountUpValue from "@/components/ui/count-up-value";

export default function MetricCard({ label, value, sub, icon: Icon, color = "bg-blue-50 text-blue-700", trend, className = "" }) {
  return (
    <div className={`group relative min-h-[118px] overflow-hidden rounded-[10px] border border-[var(--border-cre)] bg-[var(--pf-surface-card)] p-5 shadow-[var(--card-shadow)] backdrop-blur-xl transition-[border,box-shadow,transform] duration-200 before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:bg-gradient-to-r before:from-blue-700 before:via-blue-600 before:to-blue-400 hover:-translate-y-[2px] hover:border-[var(--border-strong)] hover:shadow-[var(--card-hover-shadow)] ${className}`}>
      <div className="relative">
        <div className="mb-3 flex items-start justify-between gap-3">
          <p className="pt-1 text-[13px] font-bold uppercase leading-tight tracking-wide text-[var(--muted)]">{label}</p>
          {Icon && (
            <div className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[10px] border border-blue-200/80 shadow-sm ${color}`}>
              <Icon className="h-5 w-5" strokeWidth={2} />
            </div>
          )}
        </div>
        <p className="text-[32px] font-extrabold leading-tight text-[var(--ink)] tabular-nums tracking-normal">
          <CountUpValue value={value} />
        </p>
        {(sub || trend) && (
          <div className="flex items-center gap-1.5 mt-1">
            {trend && (
              <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${trend > 0 ? 'bg-emerald-50 text-emerald-600' : trend < 0 ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-500'}`}>
                {trend > 0 ? '+' : ''}{trend}%
              </span>
            )}
            {sub && <p className="text-xs text-[var(--muted)]">{sub}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
