import React, { useState } from "react";
import { TrendingUp, TrendingDown, Minus, ChevronRight, X, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { motion, AnimatePresence } from "framer-motion";
import CountUpValue from "@/components/ui/count-up-value";

const gradients = {
  blue: "from-blue-600 to-blue-500",
  emerald: "from-emerald-600 to-emerald-500",
  violet: "from-violet-600 to-violet-500",
  amber: "from-amber-500 to-orange-500",
  rose: "from-rose-600 to-pink-500",
};

const hoverBorders = {
  blue: "hover:border-blue-300",
  emerald: "hover:border-emerald-300",
  violet: "hover:border-violet-300",
  amber: "hover:border-amber-300",
  rose: "hover:border-rose-300",
};

function fmtVal(value, prefix = "$") {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${prefix}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${prefix}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${prefix}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${prefix}${abs.toLocaleString()}`;
}

export default function KPICard({ icon: Icon, label, value, prefix = "$", change, changeLabel = "vs prior year", color = "blue", insight, breakdown, drillPage, secondaryMetrics }) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const isClickable = Boolean(breakdown);
  const isPositive = change > 0;
  const isNeutral = change === 0 || change === null || change === undefined;
  const TrendIcon = isNeutral ? Minus : isPositive ? TrendingUp : TrendingDown;
  const formattedValue = fmtVal(value, prefix);

  return (
    <>
      <div
        className={`relative flex min-h-[246px] flex-col overflow-hidden rounded-[10px] border border-slate-200/80 bg-white shadow-[var(--card-shadow)] transition-[border,box-shadow,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 ${isClickable ? `cursor-pointer hover:-translate-y-[3px] hover:shadow-[var(--card-hover-shadow)] active:translate-y-0 active:scale-[.98] ${hoverBorders[color] || hoverBorders.blue}` : ""}`}
        onClick={() => isClickable ? setShowBreakdown(true) : null}
        onKeyDown={(event) => {
          if (!isClickable || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          setShowBreakdown(true);
        }}
        role={isClickable ? "button" : undefined}
        tabIndex={isClickable ? 0 : undefined}
      >
        <div className={`absolute top-0 left-0 w-full h-[3px] bg-gradient-to-r ${gradients[color]}`} />
        <div className="flex h-full flex-1 flex-col p-4">
          <div className="mb-3 flex min-h-[44px] items-start justify-between">
            <div className="flex items-center gap-2">
              <div className={`flex h-11 w-11 items-center justify-center rounded-[10px] border border-white/30 bg-gradient-to-br ${gradients[color]} shadow-sm transition-[filter] duration-200 group-hover:saturate-125`}>
                <Icon className="h-5 w-5 text-white" strokeWidth={2} />
              </div>
              <span className="pt-1 text-[13px] font-bold uppercase leading-tight tracking-wide text-slate-600">{label}</span>
            </div>
            {breakdown && <ChevronRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-slate-500 transition-colors" />}
          </div>
          <p className="text-[30px] font-extrabold text-slate-950 tabular-nums tracking-normal leading-tight">
            <CountUpValue value={formattedValue} />
          </p>
          <div className="mt-3 flex min-h-[24px] items-center justify-between">
            {!isNeutral ? (
              <div className="flex items-center gap-1">
                <span className={`inline-flex items-center gap-0.5 text-xs font-bold ${isPositive ? 'text-emerald-600' : 'text-red-600'}`}>
                  <TrendIcon className="w-3 h-3" />
                  {Math.abs(change).toFixed(1)}%
                </span>
                <span className="text-xs text-slate-400">{changeLabel}</span>
              </div>
            ) : <div />}
            {drillPage && (
              <Link to={createPageUrl(drillPage)} className="text-xs text-blue-600 font-semibold hover:underline" onClick={e => e.stopPropagation()}>
                Details →
              </Link>
            )}
          </div>
          {secondaryMetrics && secondaryMetrics.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-slate-100 pt-3">
              {secondaryMetrics.map((m, i) => (
                <div key={i} className="flex items-baseline justify-between">
                  <span className="text-xs text-slate-400 truncate">{m.label}</span>
                  <span className="text-xs font-bold text-slate-700 tabular-nums ml-1">{m.value}</span>
                </div>
              ))}
            </div>
          )}
          {insight && (
            <p className="mt-auto border-t border-dashed border-slate-100 pt-2 text-xs leading-snug text-slate-600">
              💡 {insight}
            </p>
          )}
        </div>
      </div>

      <AnimatePresence>
        {showBreakdown && breakdown && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setShowBreakdown(false)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className={`px-5 py-3.5 bg-gradient-to-r ${gradients[color]} flex items-center justify-between`}>
                <div>
                  <p className="text-white/70 text-xs font-semibold uppercase tracking-wider">{label} — Drill-Down</p>
                  <p className="text-white text-lg font-bold tabular-nums">{formattedValue}</p>
                </div>
                <div className="flex items-center gap-2">
                  {drillPage && (
                    <Link to={createPageUrl(drillPage)} className="text-white/80 hover:text-white text-xs font-semibold flex items-center gap-1" onClick={() => setShowBreakdown(false)}>
                      Full view <ExternalLink className="w-3 h-3" />
                    </Link>
                  )}
                  <button onClick={() => setShowBreakdown(false)} className="w-7 h-7 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center">
                    <X className="w-3.5 h-3.5 text-white" />
                  </button>
                </div>
              </div>
              {insight && (
                <div className="px-5 py-2 bg-slate-50 border-b border-slate-100 text-xs text-slate-600">
                  <span className="font-semibold text-slate-700">CFO Insight:</span> {insight}
                </div>
              )}
              <div className="p-4 space-y-0 max-h-[55vh] overflow-y-auto">
                {breakdown.map((item, i) => (
                  <div key={i} className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0 hover:bg-slate-50/50 px-1 rounded">
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <div className={`w-1.5 h-6 rounded-full bg-gradient-to-b ${gradients[color]} flex-shrink-0`} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-slate-700 truncate">{item.label}</p>
                          {item.link && (
                            <Link to={item.link} className="text-blue-500 hover:text-blue-600 flex-shrink-0" onClick={() => setShowBreakdown(false)}>
                              <ExternalLink className="w-3 h-3" />
                            </Link>
                          )}
                        </div>
                        {item.sub && <p className="text-xs text-slate-400 truncate">{item.sub}</p>}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-3">
                      <p className="text-sm font-bold text-slate-900 tabular-nums">{fmtVal(item.value, prefix)}</p>
                      {item.pct !== undefined && <p className="text-xs text-slate-400">{item.pct.toFixed(1)}% of total</p>}
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
