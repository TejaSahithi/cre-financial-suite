import React from "react";
import CountUpValue from "@/components/ui/count-up-value";

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
    { label: "Gross Revenue", value: fmt(revenue), tone: "border-emerald-200/80 bg-emerald-50/80 text-emerald-800" },
    { label: "OpEx", value: fmt(expenses), tone: "border-rose-200/80 bg-rose-50/80 text-rose-700" },
    { label: "NOI", value: fmt(noi), tone: noi >= 0 ? "border-purple-200/80 bg-purple-50/80 text-purple-800" : "border-rose-200/80 bg-rose-50/80 text-rose-700" },
    { label: "Budgeted", value: fmt(budgeted), tone: "border-blue-200/80 bg-blue-50/80 text-blue-800" },
    { label: "CAM Recovery", value: fmt(camRecovery), tone: "border-violet-200/80 bg-violet-50/80 text-violet-800" },
    { label: "Occupancy", value: occupancy !== null ? `${occupancy.toFixed(1)}%` : "—", tone: "border-amber-200/80 bg-amber-50/80 text-amber-800" },
    { label: "Rent/SF", value: rentPerSF !== null ? `$${rentPerSF.toFixed(2)}` : "—", tone: "border-slate-200/90 bg-slate-50/90 text-slate-800" },
    { label: "NOI Margin", value: noiMargin !== null ? `${noiMargin.toFixed(1)}%` : "—", tone: noiMargin >= 0 ? "border-emerald-200/80 bg-emerald-50/80 text-emerald-800" : "border-rose-200/80 bg-rose-50/80 text-rose-700" },
  ];

  return (
    <div className="grid w-full grid-cols-1 gap-2 rounded-[10px] border border-slate-200/80 bg-white p-2 shadow-[var(--card-shadow)] min-[420px]:grid-cols-2 md:grid-cols-4 2xl:grid-cols-8">
      {metrics.map((m) => (
        <div key={m.label} className={`min-h-[64px] rounded-lg border px-3 py-2 text-center transition-[border,background,box-shadow] duration-200 hover:shadow-[var(--shadow-soft)] ${m.tone}`}>
          <p className="mb-1 text-[11px] font-bold uppercase leading-none tracking-wide text-slate-600">{m.label}</p>
          <p className="text-lg font-extrabold leading-tight tabular-nums">
            <CountUpValue value={m.value} />
          </p>
        </div>
      ))}
    </div>
  );
}
