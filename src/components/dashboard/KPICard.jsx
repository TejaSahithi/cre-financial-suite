import React, { useState } from "react";
import { TrendingUp, TrendingDown, Minus, ChevronRight, X, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { motion, AnimatePresence } from "framer-motion";

const gradients = {
  blue: "from-blue-600 to-blue-500",
  emerald: "from-emerald-600 to-emerald-500",
  violet: "from-violet-600 to-violet-500",
  amber: "from-amber-500 to-orange-500",
  rose: "from-rose-600 to-pink-500",
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
  const isPositive = change > 0;
  const isNeutral = change === 0 || change === null || change === undefined;
  const TrendIcon = isNeutral ? Minus : isPositive ? TrendingUp : TrendingDown;

  return (
    <>
      <div
        className="relative overflow-hidden cursor-pointer group hover:shadow-md transition-all duration-200 bg-white rounded-lg border border-slate-200/80"
        onClick={() => breakdown ? setShowBreakdown(true) : null}
      >
        <div className={`absolute top-0 left-0 w-full h-[3px] bg-gradient-to-r ${gradients[color]}`} />
        <div className="p-3.5">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2">
              <div className={`w-7 h-7 rounded-lg bg-gradient-to-br ${gradients[color]} flex items-center justify-center`}>
                <Icon className="w-3.5 h-3.5 text-white" />
              </div>
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</span>
            </div>
            {breakdown && <ChevronRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-slate-500 transition-colors" />}
          </div>
          <p className="text-2xl font-extrabold text-slate-900 tabular-nums tracking-tight leading-tight">
            {fmtVal(value, prefix)}
          </p>
          <div className="flex items-center justify-between mt-1.5">
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
            <div className="mt-2 pt-2 border-t border-slate-100 grid grid-cols-2 gap-x-3 gap-y-1">
              {secondaryMetrics.map((m, i) => (
                <div key={i} className="flex items-baseline justify-between">
                  <span className="text-xs text-slate-400 truncate">{m.label}</span>
                  <span className="text-xs font-bold text-slate-700 tabular-nums ml-1">{m.value}</span>
                </div>
              ))}
            </div>
          )}
          {insight && (
            <p className="mt-1.5 text-xs text-slate-500 leading-snug border-t border-dashed border-slate-100 pt-1.5">
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
                  <p className="text-white text-lg font-bold tabular-nums">{fmtVal(value, prefix)}</p>
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