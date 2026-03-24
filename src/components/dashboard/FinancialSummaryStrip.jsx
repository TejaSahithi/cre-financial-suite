import React from "react";

function fmt(v) {
  if (!v && v !== 0) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toLocaleString()}`;
}

export default function FinancialSummaryStrip({ revenue, expenses, noi, budgeted, camRecovery, occupancy, rentPerSF, noiMargin }) {
  const metrics = [
    { label: "Gross Revenue", value: fmt(revenue), color: "text-emerald-700" },
    { label: "OpEx", value: fmt(expenses), color: "text-red-600" },
    { label: "NOI", value: fmt(noi), color: noi >= 0 ? "text-emerald-700" : "text-red-600" },
    { label: "Budgeted", value: fmt(budgeted), color: "text-blue-700" },
    { label: "CAM Recovery", value: fmt(camRecovery), color: "text-violet-700" },
    { label: "Occupancy", value: occupancy !== null ? `${occupancy.toFixed(1)}%` : "—", color: "text-slate-800" },
    { label: "Rent/SF", value: rentPerSF !== null ? `$${rentPerSF.toFixed(2)}` : "—", color: "text-slate-800" },
    { label: "NOI Margin", value: noiMargin !== null ? `${noiMargin.toFixed(1)}%` : "—", color: noiMargin >= 0 ? "text-emerald-700" : "text-red-600" },
  ];

  return (
    <div className="bg-white rounded-lg border border-slate-200/80 px-2 py-2 flex items-center overflow-x-auto gap-0">
      {metrics.map((m, i) => (
        <div key={i} className="flex items-center">
          <div className="px-3 py-0.5 text-center whitespace-nowrap">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider leading-none mb-0.5">{m.label}</p>
            <p className={`text-base font-bold tabular-nums leading-tight ${m.color}`}>{m.value}</p>
          </div>
          {i < metrics.length - 1 && <div className="w-px h-6 bg-slate-100 flex-shrink-0" />}
        </div>
      ))}
    </div>
  );
}