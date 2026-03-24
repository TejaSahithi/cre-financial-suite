import React from "react";

export default function PageHeader({ icon: Icon, title, subtitle, iconColor = "from-blue-500 to-blue-700", children }) {
  return (
    <div className="flex items-start justify-between flex-wrap gap-4">
      <div className="flex items-center gap-3">
        {Icon && (
          <div className={`w-10 h-10 bg-gradient-to-br ${iconColor} rounded-xl flex items-center justify-center shadow-sm`}>
            <Icon className="w-5 h-5 text-white" />
          </div>
        )}
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  );
}