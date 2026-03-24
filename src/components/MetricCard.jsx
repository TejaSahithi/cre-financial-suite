import React from "react";

export default function MetricCard({ label, value, sub, icon: Icon, color = "bg-slate-50 text-slate-600", trend, className = "" }) {
  return (
    <div className={`group relative overflow-hidden rounded-xl border border-slate-200/80 bg-white p-4 transition-all hover:shadow-md hover:border-slate-300 ${className}`}>
      <div className="absolute top-0 right-0 w-20 h-20 bg-gradient-to-bl from-slate-50 to-transparent rounded-bl-full opacity-50" />
      <div className="relative">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">{label}</p>
          {Icon && (
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${color} transition-transform group-hover:scale-110`}>
              <Icon className="w-4 h-4" />
            </div>
          )}
        </div>
        <p className="text-2xl font-bold text-slate-900 tracking-tight">{value}</p>
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