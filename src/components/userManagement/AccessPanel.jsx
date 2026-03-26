import React, { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Search, ChevronDown, ChevronRight } from "lucide-react";
import { MODULE_DEFINITIONS } from "@/lib/moduleConfig";
import { ACCESS_LEVELS, getRoleDefaultModulePerms, getPermDiff, MODULE_DOMAINS } from "@/lib/userPermissions";

// ── Access chip ───────────────────────────────────────────────────────────────
export function AccessChip({ value, onChange }) {
  return (
    <div className="flex gap-1">
      {ACCESS_LEVELS.map((lvl) => (
        <button key={lvl.value} type="button" title={lvl.description}
          onClick={() => onChange(lvl.value)}
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold transition-all ${
            value === lvl.value ? lvl.chipClass : "bg-white border-slate-200 text-slate-400 hover:border-slate-300"
          }`}>{lvl.label}
        </button>
      ))}
    </div>
  );
}

// ── Access panel (collapsible) ────────────────────────────────────────────────
export function AccessPanel({ role, modulePerms, setModulePerms, pagePerms, setPagePerms }) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState({});
  const roleDefault = useMemo(() => getRoleDefaultModulePerms(role), [role]);
  const diffs = useMemo(() => getPermDiff(roleDefault, modulePerms), [roleDefault, modulePerms]);

  const setModuleLevel = (key, level) => {
    setModulePerms((p) => ({ ...p, [key]: level }));
    const mod = MODULE_DEFINITIONS[key];
    if (mod?.pages) setPagePerms((p) => { const n = { ...p }; mod.pages.forEach((pg) => { n[pg] = level; }); return n; });
  };
  const bulkApply = (level) => {
    const next = {}; Object.keys(modulePerms).forEach((k) => { next[k] = level; }); setModulePerms(next);
    const pn = {}; Object.values(MODULE_DEFINITIONS).forEach((m) => { m?.pages?.forEach((pg) => { pn[pg] = level; }); }); setPagePerms(pn);
  };

  return (
    <div>
      {diffs.length > 0 && (
        <div className="mb-2 px-2.5 py-1.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-700 flex items-center gap-1.5">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          <span><strong>{diffs.length} override{diffs.length !== 1 ? "s" : ""}</strong> from role default</span>
        </div>
      )}
      <div className="flex items-center gap-2 mb-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search modules…" className="pl-7 h-7 text-xs" />
        </div>
        <span className="text-[11px] text-slate-400">Bulk:</span>
        {["full", "read_only", "none"].map((lvl) => (
          <button key={lvl} onClick={() => bulkApply(lvl)}
            className="text-[11px] px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-600 font-medium capitalize">
            {lvl === "read_only" ? "Read" : lvl.replace("_", " ")}
          </button>
        ))}
      </div>
      <div className="space-y-1 max-h-52 overflow-y-auto pr-0.5">
        {Object.entries(MODULE_DOMAINS).map(([domain, keys]) => {
          const visible = keys.filter((k) => MODULE_DEFINITIONS[k] && (!search || MODULE_DEFINITIONS[k].label.toLowerCase().includes(search.toLowerCase())));
          if (!visible.length) return null;
          return (
            <div key={domain}>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest px-1 mt-2 mb-1">{domain}</p>
              {visible.map((key) => {
                const mod = MODULE_DEFINITIONS[key];
                if (!mod) return null;
                const modLevel = modulePerms[key] || "none";
                const isOverridden = modLevel !== (roleDefault[key] || "none");
                const isExp = expanded[key];
                return (
                  <div key={key} className={`border rounded-lg overflow-hidden mb-1 ${isOverridden ? "border-amber-200" : "border-slate-200"}`}>
                    <div className={`flex items-center justify-between px-2.5 py-2 ${isOverridden ? "bg-amber-50" : "bg-slate-50"}`}>
                      <div className="flex items-center gap-1.5 min-w-0">
                        {mod.pages?.length > 0 && (
                          <button type="button" onClick={() => setExpanded((e) => ({ ...e, [key]: !e[key] }))} className="text-slate-400 hover:text-slate-600 shrink-0">
                            {isExp ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          </button>
                        )}
                        <span className="text-xs font-semibold text-slate-800 truncate">{mod.label}</span>
                        {isOverridden && <span className="text-[8px] bg-amber-200 text-amber-700 rounded px-1 font-bold shrink-0">Override</span>}
                      </div>
                      <AccessChip value={modLevel} onChange={(v) => setModuleLevel(key, v)} />
                    </div>
                    {isExp && mod.pages && (
                      <div className="divide-y divide-slate-50 border-t border-slate-100">
                        {mod.pages.map((pg) => (
                          <div key={pg} className="flex items-center justify-between px-5 py-1.5 bg-white">
                            <span className="text-[11px] text-slate-500">{pg.replace(/([A-Z])/g, " $1").trim()}</span>
                            <AccessChip value={pagePerms[pg] || modLevel} onChange={(v) => setPagePerms((p) => ({ ...p, [pg]: v }))} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
