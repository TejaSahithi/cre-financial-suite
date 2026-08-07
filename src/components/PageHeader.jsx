import React from "react";

export default function PageHeader({ icon: Icon, title, subtitle, iconColor = "from-blue-500 to-blue-700", children }) {
  return (
    <div className="mb-4 flex items-start justify-between flex-wrap gap-5">
      <div className="flex items-center gap-3">
        {Icon && (
          <div className={`w-10 h-10 rounded-[9px] border border-[color-mix(in_srgb,var(--accent)_55%,var(--border-cre))] bg-[var(--surface)] flex items-center justify-center shadow-[var(--shadow-soft)] text-[var(--accent)]`}>
            <Icon className="w-5 h-5" />
          </div>
        )}
        <div>
          <h1 className="text-[28px] font-sans font-bold leading-[1.08] tracking-[-0.03em] text-[var(--ink)]">{title}</h1>
          {subtitle && <p className="mt-[7px] text-[13px] text-[var(--muted)]">{subtitle}</p>}
        </div>
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  );
}
