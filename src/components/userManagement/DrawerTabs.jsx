/**
 * UserManagement v2 — Drawer Sub-components
 * Role Tab, Access Tab, Capabilities Tab, Summary Panel
 */
import React, { useState, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
  Edit, Eye, Lock, Search, Shield, Zap, LayoutGrid
} from "lucide-react";
import {
  ROLE_DEFINITIONS, CAPABILITY_DEFINITIONS, MODULE_DOMAINS, ACCESS_LEVELS,
  getRoleDefaultModulePerms, getPermDiff
} from "@/lib/userPermissions";
import { MODULE_DEFINITIONS } from "@/lib/moduleConfig";

// ── Access Level Chip ─────────────────────────────────────────────────────────
export function AccessChip({ value, onChange, compact = false }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {ACCESS_LEVELS.map((lvl) => {
        const isActive = value === lvl.value;
        return (
          <button
            key={lvl.value}
            type="button"
            title={lvl.description}
            onClick={() => onChange(lvl.value)}
            className={`rounded-md border px-2 py-1 text-[11px] font-semibold transition-all ${
              isActive ? lvl.chipClass : "bg-white border-slate-200 text-slate-400 hover:border-slate-300"
            }`}
          >
            {compact ? lvl.label : lvl.longLabel}
          </button>
        );
      })}
    </div>
  );
}

// ── Role Tab ──────────────────────────────────────────────────────────────────
export function RoleTab({ role, setRole, setModulePerms, setPagePerms, availableRoles }) {
  return (
    <div>
      <p className="text-xs text-slate-500 mb-4">
        Role sets the <strong>default permission template</strong>. Use the Access tab to override individual modules.
      </p>
      <div className="grid grid-cols-2 gap-3 mb-4">
        {ROLE_DEFINITIONS.filter((r) => availableRoles.includes(r.value)).map((r) => (
          <div
            key={r.value}
            onClick={() => {
              setRole(r.value);
              const defaults = getRoleDefaultModulePerms(r.value);
              setModulePerms(defaults);
              setPagePerms({});
            }}
            className={`p-3.5 rounded-xl border-2 cursor-pointer transition-all select-none ${
              role === r.value ? `${r.borderColor} bg-slate-50` : "border-slate-100 hover:border-slate-300"
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <Badge className={`text-[10px] ${r.color}`}>{r.label}</Badge>
              {role === r.value && <CheckCircle2 className="w-4 h-4 text-blue-600 shrink-0" />}
            </div>
            <p className="text-[11px] text-slate-500 leading-snug mb-2">{r.description}</p>
            {r.warning && (
              <div className="flex items-center gap-1 bg-amber-50 rounded-lg px-2 py-1 mt-1">
                <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
                <span className="text-[10px] text-amber-700 font-medium">{r.warningText}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Access Tab ────────────────────────────────────────────────────────────────
export function AccessTab({ role, modulePerms, setModulePerms, pagePerms, setPagePerms, enabledModules }) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState({});
  const roleDefault = useMemo(() => getRoleDefaultModulePerms(role), [role]);
  const diffs = useMemo(() => getPermDiff(roleDefault, modulePerms), [roleDefault, modulePerms]);

  const setModuleLevel = (key, level) => {
    setModulePerms((p) => ({ ...p, [key]: level }));
    const mod = MODULE_DEFINITIONS[key];
    if (mod?.pages) {
      setPagePerms((p) => {
        const next = { ...p };
        mod.pages.forEach((pg) => { next[pg] = level; });
        return next;
      });
    }
  };

  const bulkApply = (level) => {
    const next = {};
    Object.keys(modulePerms).forEach((k) => { next[k] = level; });
    setModulePerms(next);
    const pageNext = {};
    Object.values(MODULE_DEFINITIONS).forEach((mod) => {
      mod?.pages?.forEach((pg) => { pageNext[pg] = level; });
    });
    setPagePerms(pageNext);
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search modules..."
            className="pl-8 h-8 text-sm"
          />
        </div>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => bulkApply("full")}>All Full</Button>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => bulkApply("read_only")}>All Read</Button>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => bulkApply("none")}>All None</Button>
      </div>

      {diffs.length > 0 && (
        <div className="mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
          <strong>{diffs.length} override{diffs.length !== 1 ? "s" : ""}</strong> from role defaults:{" "}
          {diffs.slice(0, 3).map((d) => d.label).join(", ")}{diffs.length > 3 ? ` +${diffs.length - 3} more` : ""}
        </div>
      )}

      <div className="space-y-2 max-h-[42vh] overflow-y-auto pr-1">
        {Object.entries(MODULE_DOMAINS).map(([domain, keys]) => {
          const visibleKeys = keys.filter((k) => {
            const mod = MODULE_DEFINITIONS[k];
            if (!mod) return false;
            if (search && !mod.label.toLowerCase().includes(search.toLowerCase())) return false;
            return true;
          });
          if (visibleKeys.length === 0) return null;

          return (
            <div key={domain}>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-1 mb-1.5">{domain}</p>
              {visibleKeys.map((key) => {
                const mod = MODULE_DEFINITIONS[key];
                if (!mod) return null;
                const modLevel = modulePerms[key] || "none";
                const defLevel = roleDefault[key] || "none";
                const isOverridden = modLevel !== defLevel;
                const isExp = expanded[key];

                return (
                  <div key={key} className="border border-slate-200 rounded-xl overflow-hidden mb-2">
                    <div className={`flex items-center justify-between px-3 py-2.5 ${isOverridden ? "bg-amber-50" : "bg-slate-50"}`}>
                      <div className="flex items-center gap-2 min-w-0">
                        <button type="button" onClick={() => setExpanded((e) => ({ ...e, [key]: !e[key] }))} className="text-slate-400 hover:text-slate-600 shrink-0">
                          {isExp ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </button>
                        <span className="text-xs font-semibold text-slate-800 truncate">{mod.label}</span>
                        {isOverridden && <span className="text-[9px] bg-amber-200 text-amber-700 rounded px-1 font-bold shrink-0">Override</span>}
                      </div>
                      <AccessChip value={modLevel} onChange={(v) => setModuleLevel(key, v)} compact />
                    </div>
                    {isExp && mod.pages && (
                      <div className="divide-y divide-slate-50 border-t border-slate-100">
                        {mod.pages.map((pg) => {
                          const pgLevel = pagePerms[pg] || modLevel;
                          return (
                            <div key={pg} className="flex items-center justify-between px-5 py-2 bg-white">
                              <span className="text-xs text-slate-500">{pg.replace(/([A-Z])/g, " $1").trim()}</span>
                              <AccessChip value={pgLevel} onChange={(v) => setPagePerms((p) => ({ ...p, [pg]: v }))} compact />
                            </div>
                          );
                        })}
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

// ── Capabilities Tab ──────────────────────────────────────────────────────────
export function CapabilitiesTab({ role, capabilities, setCapabilities }) {
  const roleObj = ROLE_DEFINITIONS.find((r) => r.value === role);
  const defaults = roleObj?.defaultCapabilities || {};

  return (
    <div>
      <p className="text-xs text-slate-500 mb-4">
        Capabilities are workflow-level permissions that go beyond page access. They control specific actions within the platform.
      </p>
      <div className="space-y-3">
        {CAPABILITY_DEFINITIONS.map(({ key, label, description }) => {
          const isDefault = !!defaults[key];
          const isActive = capabilities[key] !== undefined ? capabilities[key] : isDefault;
          const isOverridden = capabilities[key] !== undefined && capabilities[key] !== isDefault;
          return (
            <div key={key} className={`flex items-center justify-between p-3 rounded-xl border transition-colors ${isActive ? "bg-emerald-50 border-emerald-200" : "bg-white border-slate-200"}`}>
              <div>
                <div className="flex items-center gap-2">
                  <Zap className={`w-3.5 h-3.5 ${isActive ? "text-emerald-600" : "text-slate-300"}`} />
                  <span className="text-sm font-semibold text-slate-800">{label}</span>
                  {isOverridden && <span className="text-[9px] bg-amber-200 text-amber-700 rounded px-1 font-bold">Override</span>}
                  {isDefault && !isOverridden && <span className="text-[9px] bg-slate-100 text-slate-500 rounded px-1">Role default</span>}
                </div>
                <p className="text-xs text-slate-500 mt-0.5 ml-5">{description}</p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={(v) => setCapabilities((c) => ({ ...c, [key]: v }))}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Summary Panel ─────────────────────────────────────────────────────────────
export function SummaryPanel({ role, modulePerms, pagePerms, capabilities, fullName }) {
  const roleObj = ROLE_DEFINITIONS.find((r) => r.value === role);
  const diffs = useMemo(() => {
    const defaults = getRoleDefaultModulePerms(role);
    return getPermDiff(defaults, modulePerms);
  }, [role, modulePerms]);

  const activeCaps = CAPABILITY_DEFINITIONS.filter(({ key }) => {
    const defVal = roleObj?.defaultCapabilities?.[key] || false;
    return capabilities[key] !== undefined ? capabilities[key] : defVal;
  });

  const modulesByLevel = useMemo(() => {
    const groups = { full: [], read_only: [], none: [] };
    Object.entries(modulePerms).forEach(([key, val]) => {
      const mod = MODULE_DEFINITIONS[key];
      if (mod) groups[val]?.push(mod.label);
    });
    return groups;
  }, [modulePerms]);

  return (
    <div className="w-60 shrink-0 border-l border-slate-100 pl-4 overflow-y-auto">
      <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">Permission Summary</p>

      {/* Who */}
      <div className="mb-4">
        <p className="text-xs text-slate-500 mb-1">Editing</p>
        <p className="text-sm font-bold text-slate-900 truncate">{fullName || "New User"}</p>
        {roleObj && <Badge className={`text-[10px] mt-1 ${roleObj.color}`}>{roleObj.label}</Badge>}
      </div>

      {/* Overrides */}
      {diffs.length > 0 && (
        <div className="mb-4">
          <p className="text-xs text-slate-500 mb-2">Overrides ({diffs.length})</p>
          <div className="space-y-1">
            {diffs.slice(0, 5).map((d) => (
              <div key={d.key} className="flex items-center gap-1.5 text-[11px]">
                <span className="text-slate-400">{d.label}:</span>
                <span className="text-slate-400 line-through">{d.from}</span>
                <span className="text-blue-600 font-medium">→ {d.to}</span>
              </div>
            ))}
            {diffs.length > 5 && <p className="text-[10px] text-slate-400">+{diffs.length - 5} more</p>}
          </div>
        </div>
      )}

      {/* Module summary */}
      <div className="mb-4 space-y-2">
        {modulesByLevel.full.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-emerald-600 mb-1">Full Access</p>
            <p className="text-[11px] text-slate-500 leading-relaxed">{modulesByLevel.full.join(", ")}</p>
          </div>
        )}
        {modulesByLevel.read_only.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-blue-600 mb-1">Read Only</p>
            <p className="text-[11px] text-slate-500 leading-relaxed">{modulesByLevel.read_only.join(", ")}</p>
          </div>
        )}
        {modulesByLevel.none.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-slate-400 mb-1">No Access</p>
            <p className="text-[11px] text-slate-400 leading-relaxed">{modulesByLevel.none.join(", ")}</p>
          </div>
        )}
      </div>

      {/* Capabilities */}
      {activeCaps.length > 0 && (
        <div>
          <p className="text-xs text-slate-500 mb-2">Capabilities</p>
          <div className="space-y-1">
            {activeCaps.map((c) => (
              <div key={c.key} className="flex items-center gap-1.5 text-[11px] text-emerald-700">
                <Zap className="w-3 h-3 shrink-0" />
                {c.label}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
