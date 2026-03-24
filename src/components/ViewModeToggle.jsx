import React from "react";
import { LayoutGrid, Table2, LayoutList } from "lucide-react";

const modes = [
  { key: "grid", icon: LayoutGrid, label: "Grid" },
  { key: "list", icon: LayoutList, label: "List" },
  { key: "details", icon: Table2, label: "Details" },
];

export default function ViewModeToggle({ viewMode, onViewModeChange }) {
  return (
    <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
      {modes.map(m => (
        <button
          key={m.key}
          onClick={() => onViewModeChange(m.key)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
            viewMode === m.key
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
          title={m.label}
        >
          <m.icon className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{m.label}</span>
        </button>
      ))}
    </div>
  );
}