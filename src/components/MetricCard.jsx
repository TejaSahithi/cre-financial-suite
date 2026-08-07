import React from "react";
import CountUpValue from "@/components/ui/count-up-value";

export default function MetricCard({ label, value, sub, icon: Icon, color = "bg-slate-50 text-slate-600", trend, className = "" }) {
  return (
    <div className={`group relative min-h-[118px] overflow-hidden rounded-[10px] border border-slate-200/80 bg-white p-5 shadow-[var(--card-shadow)] transition-[border,box-shadow] duration-200 hover:border-slate-300 hover:shadow-[var(--shadow-soft)] ${className}`}>
      <div className="relative">
        <div className="mb-3 flex items-start justify-between gap-3">
          <p className="pt-1 text-[13px] font-bold uppercase leading-tight tracking-wide text-slate-600">{label}</p>
          {Icon && (
            <div className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[10px] border border-current/10 ${color}`}>
              <Icon className="h-5 w-5" strokeWidth={2} />
            </div>
          )}
        </div>
        <p className="text-[32px] font-extrabold leading-tight text-slate-950 tabular-nums tracking-normal">
          <CountUpValue value={value} />
        </p>
        {(sub || trend) && (
          <div className="flex items-center gap-1.5 mt-1">
            {trend && (
              <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${trend > 0 ? 'bg-emerald-50 text-emerald-600' : trend < 0 ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-500'}`}>
                {trend > 0 ? '+' : ''}{trend}%
              </span>
            )}
            {sub && <p className="text-xs text-slate-400">{sub}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
