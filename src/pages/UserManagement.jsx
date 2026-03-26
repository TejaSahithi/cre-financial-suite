import React, { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";
import { logAudit } from "@/services/audit";
import { useAuth } from "@/lib/AuthContext";
import { useModuleAccess } from "@/lib/ModuleAccessContext";
import useOrgId from "@/hooks/useOrgId";
import { MODULE_DEFINITIONS } from "@/lib/moduleConfig";
import {
  ROLE_DEFINITIONS, CAPABILITY_DEFINITIONS, MODULE_DOMAINS, ACCESS_LEVELS,
  getInitials, getStatusBadge, getRoleDefaultModulePerms, getPermDiff
} from "@/lib/userPermissions";
import CsvImport from "@/components/userManagement/CsvImport";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Users, Plus, Loader2, Trash2, Shield, Edit2, Phone,
  Search, Upload, Settings, ChevronDown, ChevronRight,
  AlertTriangle, Zap, Eye, Globe, Info
} from "lucide-react";
import { toast } from "sonner";

// ── Access chip ───────────────────────────────────────────────────────────────
function AccessChip({ value, onChange }) {
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
function AccessPanel({ role, modulePerms, setModulePerms, pagePerms, setPagePerms }) {
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

// ── Right summary panel ───────────────────────────────────────────────────────
function SummaryPanel({ role, modulePerms, capabilities, fullName, noRole }) {
  const roleDef = ROLE_DEFINITIONS.find((r) => r.value === role);
  const diffs = useMemo(() => getPermDiff(getRoleDefaultModulePerms(role), modulePerms), [role, modulePerms]);
  const activeCaps = CAPABILITY_DEFINITIONS.filter(({ key }) => {
    const def = roleDef?.defaultCapabilities?.[key] || false;
    return capabilities[key] !== undefined ? capabilities[key] : def;
  });
  const byLevel = useMemo(() => {
    const g = { full: [], read_only: [], none: [] };
    Object.entries(modulePerms).forEach(([k, v]) => { const m = MODULE_DEFINITIONS[k]; if (m) g[v]?.push(m.label); });
    return g;
  }, [modulePerms]);

  return (
    <div className="w-52 shrink-0 border-l border-slate-100 pl-4 flex flex-col gap-4">
      <div>
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Summary</p>
        <p className="text-sm font-bold text-slate-900 truncate">{fullName || "New User"}</p>
        {noRole ? (
          <span className="text-[11px] bg-amber-100 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5 font-semibold">Pending Access</span>
        ) : roleDef ? (
          <Badge className={`text-[10px] mt-1 ${roleDef.color}`}>{roleDef.label}</Badge>
        ) : null}
      </div>

      {!noRole && diffs.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-amber-600 mb-1">{diffs.length} Override{diffs.length !== 1 ? "s" : ""}</p>
          {diffs.slice(0, 4).map((d) => (
            <div key={d.key} className="flex items-center gap-1 text-[10px] text-slate-500">
              <span>{d.label}:</span><span className="text-blue-600 font-medium">{d.to}</span>
            </div>
          ))}
        </div>
      )}

      {!noRole && (
        <>
          {byLevel.full.length > 0 && <div><p className="text-[9px] font-bold text-emerald-600 mb-1">Full Access</p><p className="text-[10px] text-slate-500 leading-relaxed">{byLevel.full.join(", ")}</p></div>}
          {byLevel.read_only.length > 0 && <div><p className="text-[9px] font-bold text-blue-600 mb-1">Read Only</p><p className="text-[10px] text-slate-500 leading-relaxed">{byLevel.read_only.join(", ")}</p></div>}
          {byLevel.none.length > 0 && <div><p className="text-[9px] font-bold text-slate-400 mb-1">No Access</p><p className="text-[10px] text-slate-400 leading-relaxed">{byLevel.none.join(", ")}</p></div>}
        </>
      )}

      {activeCaps.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-slate-400 mb-1">Capabilities</p>
          {activeCaps.map((c) => (
            <div key={c.key} className="flex items-center gap-1 text-[10px] text-emerald-700"><Zap className="w-2.5 h-2.5" />{c.label}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function fetchOrgMembers(orgId) {
  if (!orgId || orgId === "__none__") return [];
  const { data, error } = await supabase.from("memberships")
    .select(`id,user_id,role,custom_role,org_id,phone,status,page_permissions,module_permissions,capabilities,
             profiles(id,email,full_name,avatar_url)`)
    .eq("org_id", orgId);
  if (error) throw error;
  return (data || []).map((m) => ({
    membership_id: m.id, id: m.user_id, role: m.role, custom_role: m.custom_role,
    org_id: m.org_id, phone: m.phone || m.profiles?.phone || "",
    status: m.status || "active",
    page_permissions: m.page_permissions || {},
    module_permissions: m.module_permissions || {},
    capabilities: m.capabilities || {},
    email: m.profiles?.email || "—", full_name: m.profiles?.full_name || null,
  }));
}

async function fetchOrgSettings(orgId) {
  if (!orgId) return null;
  const { data } = await supabase.from("organizations")
    .select("allowed_email_domains,auto_join_enabled,auto_join_role,require_approval_for_auto_join")
    .eq("id", orgId).single();
  return data;
}

// ── Invite / Edit Modal (single-screen) ──────────────────────────────────────
function InviteModal({ open, onClose, member, orgId, currentUser, enabledModules, onSaved, isSuperAdmin }) {
  const isEditing = !!member;
  const [fullName, setFullName] = useState(member?.full_name || "");
  const [email, setEmail] = useState(member?.email || "");
  const [phone, setPhone] = useState(member?.phone || "");
  const [role, setRole] = useState(member?.role || "");
  const [customRole, setCustomRole] = useState(member?.custom_role || "");
  const [useDefaults, setUseDefaults] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [modulePerms, setModulePerms] = useState(
    member?.module_permissions && Object.keys(member.module_permissions).length > 0
      ? member.module_permissions : {}
  );
  const [pagePerms, setPagePerms] = useState(member?.page_permissions || {});
  const [capabilities, setCapabilities] = useState(member?.capabilities || {});
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const noRole = !role;
  const availableRoles = isSuperAdmin ? ROLE_DEFINITIONS : ROLE_DEFINITIONS.filter((r) => r.value !== "org_admin");

  // When role changes and useDefaults is on, reset permissions to role defaults
  const handleRoleChange = (val) => {
    setRole(val);
    if (useDefaults) {
      setModulePerms(getRoleDefaultModulePerms(val));
      setPagePerms({});
    }
  };

  const handleUseDefaultsToggle = (val) => {
    setUseDefaults(val);
    if (val && role) { setModulePerms(getRoleDefaultModulePerms(role)); setPagePerms({}); }
    if (!val) setShowAdvanced(true);
  };

  const handleSave = async () => {
    if (!isEditing && !email) return;
    setSaving(true);
    try {
      const effectiveModulePerms = useDefaults ? {} : modulePerms;
      const effectivePagePerms = useDefaults ? {} : pagePerms;

      if (isEditing) {
        const { error } = await supabase.from("memberships").update({
          role: role || null, custom_role: role === "custom" ? customRole : null,
          phone, module_permissions: effectiveModulePerms, page_permissions: effectivePagePerms, capabilities,
        }).eq("user_id", member.id).eq("org_id", orgId);
        if (error) throw error;
        await logAudit({ entityType: "Membership", entityId: member.id, action: "update",
          orgId, userId: currentUser?.id, userEmail: currentUser?.email,
          fieldChanged: "role/permissions", oldValue: member.role, newValue: role });
        toast.success(`Updated ${fullName || email}`);
      } else {
        const resp = await supabase.functions.invoke("invite-user", {
          body: {
            email, full_name: fullName || undefined, role: role || "viewer",
            custom_role: role === "custom" ? customRole : undefined,
            phone: phone || undefined, org_id: orgId,
            module_permissions: effectiveModulePerms,
            page_permissions: effectivePagePerms, capabilities,
          },
        });
        if (resp.error) throw new Error(resp.error.message);
        await logAudit({ entityType: "UserInvite", action: "create",
          orgId, userId: currentUser?.id, userEmail: currentUser?.email,
          newValue: `${email} invited as ${role || "pending"}` });
        toast.success(noRole ? `${email} invited — pending role assignment` : `Invitation sent to ${email}`);
      }
      onSaved(); onClose();
    } catch (err) {
      toast.error((isEditing ? "Update" : "Invite") + " failed: " + (err.message || "Unknown"));
    }
    setSaving(false);
  };

  // Preview modal
  if (showPreview) {
    const effectiveModulePerms = useDefaults && role ? getRoleDefaultModulePerms(role) : modulePerms;
    const byLevel = { full: [], read_only: [], none: [] };
    Object.entries(effectiveModulePerms).forEach(([k, v]) => { const m = MODULE_DEFINITIONS[k]; if (m) byLevel[v]?.push(m.label); });
    return (
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Eye className="w-4 h-4" />Preview: {fullName || email}'s Access</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm">
            {role && <div><span className="text-slate-500">Role:</span> <Badge className={`ml-1 text-[10px] ${ROLE_DEFINITIONS.find((r) => r.value === role)?.color || ""}`}>{role}</Badge></div>}
            {byLevel.full.length > 0 && <div><p className="text-xs font-semibold text-emerald-600 mb-1">Full Access</p><p className="text-xs text-slate-500">{byLevel.full.join(", ")}</p></div>}
            {byLevel.read_only.length > 0 && <div><p className="text-xs font-semibold text-blue-600 mb-1">Read Only</p><p className="text-xs text-slate-500">{byLevel.read_only.join(", ")}</p></div>}
            {byLevel.none.length > 0 && <div><p className="text-xs font-semibold text-slate-400 mb-1">No Access</p><p className="text-xs text-slate-400">{byLevel.none.join(", ")}</p></div>}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setShowPreview(false)}>Back to Edit</Button>
            <Button onClick={handleSave} disabled={saving} className="bg-[#1a2744] hover:bg-[#243b67]">
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              {isEditing ? "Save Changes" : "Send Invitation"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl p-0 gap-0 overflow-hidden">
        <div className="flex" style={{ maxHeight: "85vh" }}>

          {/* ── Main form ── */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="px-6 pt-5 pb-4 border-b border-slate-100">
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                {isEditing ? <Edit2 className="w-4 h-4 text-blue-600" /> : <Plus className="w-4 h-4 text-emerald-600" />}
                {isEditing ? `Edit — ${member?.full_name || member?.email}` : "Invite Team Member"}
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Fill in details below and configure access in one step</p>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              {/* ── Details ── */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Full Name</Label>
                  <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jane Smith" className="mt-1 h-9" />
                </div>
                <div>
                  <Label className="text-xs">Email Address *</Label>
                  <Input type="email" value={email} onChange={isEditing ? undefined : (e) => setEmail(e.target.value)}
                    readOnly={isEditing} placeholder="jane@company.com"
                    className={`mt-1 h-9 ${isEditing ? "bg-slate-50 text-slate-400" : ""}`} />
                </div>
                <div>
                  <Label className="text-xs">Phone <span className="text-slate-400 font-normal">(optional)</span></Label>
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 (555) 000-0000" className="mt-1 h-9" />
                </div>
                <div>
                  <Label className="text-xs">Role</Label>
                  <Select value={role} onValueChange={handleRoleChange}>
                    <SelectTrigger className="mt-1 h-9 text-sm">
                      <SelectValue placeholder="— Assign role (optional) —" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="" className="text-slate-400 text-sm italic">No role — pending access</SelectItem>
                      {availableRoles.map((r) => (
                        <SelectItem key={r.value} value={r.value} className="text-sm">
                          <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full shrink-0 ${r.color.replace("text-", "bg-").split(" ")[0]}`} />
                            <span className="font-semibold">{r.label}</span>
                            <span className="text-slate-400 text-xs">— {r.description}</span>
                            {r.warning && <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />}
                          </div>
                        </SelectItem>
                      ))}
                      <SelectItem value="custom" className="text-sm font-semibold text-pink-600">Custom Role</SelectItem>
                    </SelectContent>
                  </Select>
                  {role === "custom" && (
                    <Input value={customRole} onChange={(e) => setCustomRole(e.target.value)}
                      placeholder="e.g. Portfolio Analyst" className="mt-1.5 h-8 text-xs" />
                  )}
                  {role && ROLE_DEFINITIONS.find((r) => r.value === role)?.warning && (
                    <p className="flex items-center gap-1 text-[11px] text-amber-600 mt-1">
                      <AlertTriangle className="w-3 h-3" />High-privilege role — grants full org control
                    </p>
                  )}
                </div>
              </div>

              {/* ── No role warning ── */}
              {noRole && (
                <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                  <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-amber-700">No role assigned</p>
                    <p className="text-xs text-amber-600 mt-0.5">This user will be invited but won't have any platform access until an admin assigns their role.</p>
                  </div>
                </div>
              )}

              {/* ── Use default permissions toggle ── */}
              {role && role !== "custom" && (
                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-200">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">Use default permissions</p>
                    <p className="text-xs text-slate-500">Apply standard access for the <strong>{ROLE_DEFINITIONS.find((r) => r.value === role)?.label || role}</strong> role</p>
                  </div>
                  <Switch checked={useDefaults} onCheckedChange={handleUseDefaultsToggle} />
                </div>
              )}

              {/* ── Advanced access (collapsible) ── */}
              {role && !useDefaults && (
                <div>
                  <button type="button" onClick={() => setShowAdvanced((v) => !v)}
                    className="flex items-center gap-2 text-sm font-semibold text-slate-700 hover:text-blue-600 transition-colors">
                    {showAdvanced ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    Advanced Access Configuration
                    {getPermDiff(getRoleDefaultModulePerms(role), modulePerms).length > 0 && (
                      <span className="text-[10px] bg-amber-100 text-amber-700 rounded px-1.5 py-0.5 font-bold">
                        {getPermDiff(getRoleDefaultModulePerms(role), modulePerms).length} overrides
                      </span>
                    )}
                  </button>
                  {showAdvanced && (
                    <div className="mt-3 pl-1 border-l-2 border-slate-100">
                      <AccessPanel role={role} modulePerms={modulePerms} setModulePerms={setModulePerms}
                        pagePerms={pagePerms} setPagePerms={setPagePerms} />
                    </div>
                  )}
                </div>
              )}

              {/* ── Access level legend ── */}
              <div className="flex items-start gap-4 text-[11px] text-slate-400 border-t border-slate-100 pt-3">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-300" />
                {ACCESS_LEVELS.map((l) => (
                  <span key={l.value}><span className={`font-bold ${l.chipClass.split(" ")[1]}`}>{l.longLabel}:</span> {l.description}</span>
                ))}
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-100">
              <Button variant="outline" size="sm" onClick={() => setShowPreview(true)} className="gap-1.5">
                <Eye className="w-3.5 h-3.5" />Preview Access
              </Button>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving || (!isEditing && !email)} className="bg-[#1a2744] hover:bg-[#243b67]">
                {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                {isEditing ? "Save Changes" : noRole ? "Invite (Pending Role)" : "Send Invitation"}
              </Button>
            </div>
          </div>

          {/* ── Summary sidebar ── */}
          <div className="w-52 bg-slate-50 border-l border-slate-100 p-4 overflow-y-auto">
            <SummaryPanel role={role} modulePerms={useDefaults && role ? getRoleDefaultModulePerms(role) : modulePerms}
              capabilities={capabilities} fullName={fullName} noRole={noRole} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Domain Settings ───────────────────────────────────────────────────────────
function DomainSettings({ orgId }) {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["org-settings", orgId], queryFn: () => fetchOrgSettings(orgId), enabled: !!orgId });
  const [domains, setDomains] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const parsed = domains.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    const { error } = await supabase.from("organizations").update({ allowed_email_domains: parsed }).eq("id", orgId);
    if (error) toast.error("Failed to save domains");
    else { toast.success("Domain allowlist saved"); queryClient.invalidateQueries({ queryKey: ["org-settings"] }); }
    setSaving(false);
  };

  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><Globe className="w-4 h-4 text-slate-400" />Domain Auto-Join</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label className="text-xs">Allowed Email Domains</Label>
          <Input className="mt-1 text-sm" placeholder="company.com, subsidiary.org"
            defaultValue={(settings?.allowed_email_domains || []).join(", ")}
            onChange={(e) => setDomains(e.target.value)} />
          <p className="text-[11px] text-slate-400 mt-1">Users with these email domains are auto-added to your org.</p>
        </div>
        <div className="flex items-center justify-between">
          <div><p className="text-xs font-medium text-slate-700">Require Admin Approval</p><p className="text-[11px] text-slate-400">Auto-joined users need approval before access</p></div>
          <Switch defaultChecked={settings?.require_approval_for_auto_join ?? true}
            onCheckedChange={async (v) => { await supabase.from("organizations").update({ require_approval_for_auto_join: v }).eq("id", orgId); }} />
        </div>
        <Button size="sm" onClick={handleSave} disabled={saving} className="bg-[#1a2744] hover:bg-[#243b67]">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}Save Settings
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function UserManagement() {
  const { user: currentUser } = useAuth();
  const { enabledModules } = useModuleAccess();
  const { orgId, orgName } = useOrgId();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("team");
  const [showModal, setShowModal] = useState(false);
  const [editMember, setEditMember] = useState(null);

  const isSuperAdmin = currentUser?.role === "admin" || currentUser?._raw_role === "super_admin";
  const isOrgAdmin = currentUser?._raw_role === "org_admin" || currentUser?.role === "org_admin";
  const canManage = isSuperAdmin || isOrgAdmin ||
    ["admin", "org_admin"].includes(currentUser?.role) ||
    ["super_admin", "org_admin"].includes(currentUser?._raw_role);

  // For SuperAdmin: allow selecting any org
  const [selectedOrgId, setSelectedOrgId] = useState(null);

  // Determine effective org ID to use
  const effectiveOrgId = isSuperAdmin ? selectedOrgId : orgId;

  // SuperAdmin: fetch all orgs for the selector
  const { data: allOrgs = [] } = useQuery({
    queryKey: ["all-orgs-for-selector"],
    queryFn: async () => {
      const { data } = await supabase.from("organizations").select("id,name,status").order("name");
      return data || [];
    },
    enabled: isSuperAdmin,
  });

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["org-members", effectiveOrgId],
    queryFn: () => fetchOrgMembers(effectiveOrgId),
    enabled: !!effectiveOrgId && effectiveOrgId !== "__none__",
  });

  const handleRemove = async (member) => {
    if (!confirm(`Remove ${member.full_name || member.email}?`)) return;
    const { error } = await supabase.from("memberships").delete().eq("user_id", member.id).eq("org_id", effectiveOrgId);
    if (error) { toast.error("Failed to remove user"); return; }
    await logAudit({ entityType: "Membership", entityId: member.id, action: "delete",
      orgId: effectiveOrgId, userId: currentUser?.id, userEmail: currentUser?.email, oldValue: `${member.email} (${member.role})` });
    toast.success(`Removed ${member.full_name || member.email}`);
    queryClient.invalidateQueries({ queryKey: ["org-members"] });
  };

  const filtered = useMemo(() => members.filter((m) => {
    const q = search.toLowerCase();
    return !q || (m.full_name || "").toLowerCase().includes(q) || (m.email || "").toLowerCase().includes(q);
  }), [members, search]);

  if (!canManage) return (
    <div className="flex flex-col items-center justify-center h-96 gap-3">
      <Shield className="w-12 h-12 text-slate-200" />
      <p className="text-sm text-slate-500">You do not have permission to manage users.</p>
    </div>
  );

  const selectedOrgName = isSuperAdmin
    ? (allOrgs.find(o => o.id === selectedOrgId)?.name || "Select an organization")
    : orgName;

  return (
    <div className="p-6 space-y-5 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">User Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {isSuperAdmin ? "Platform-wide user management" : `${members.length} team member${members.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <Button
          onClick={() => { setEditMember(null); setShowModal(true); }}
          disabled={isSuperAdmin && !selectedOrgId}
          className="bg-[#1a2744] hover:bg-[#243b67] gap-2 disabled:opacity-40"
        >
          <Plus className="w-4 h-4" />Invite Member
        </Button>
      </div>

      {/* SuperAdmin: Org Selector */}
      {isSuperAdmin && (
        <div className="flex items-center gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
          <Shield className="w-5 h-5 text-amber-600 shrink-0" />
          <div className="flex-1">
            <p className="text-xs font-bold text-amber-700 mb-1">SuperAdmin — Select Organization</p>
            <Select value={selectedOrgId || ""} onValueChange={(v) => { setSelectedOrgId(v); queryClient.invalidateQueries({ queryKey: ["org-members"] }); }}>
              <SelectTrigger className="w-80 h-9 text-sm bg-white border-amber-200">
                <SelectValue placeholder="Choose an organization…" />
              </SelectTrigger>
              <SelectContent>
                {allOrgs.map(org => (
                  <SelectItem key={org.id} value={org.id} className="text-sm">
                    {org.name}
                    <span className={`ml-2 text-[10px] font-medium capitalize ${org.status === 'active' ? 'text-emerald-600' : 'text-slate-400'}`}>
                      ({org.status})
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selectedOrgId && (
            <p className="text-xs text-amber-600 self-end">
              Viewing <strong>{selectedOrgName}</strong> · {members.length} member{members.length !== 1 ? "s" : ""}
            </p>
          )}
        </div>
      )}

      {/* If SuperAdmin hasn't selected an org yet */}
      {isSuperAdmin && !selectedOrgId && (
        <div className="flex flex-col items-center justify-center h-64 gap-3 bg-slate-50 rounded-2xl border border-slate-200">
          <Users className="w-12 h-12 text-slate-200" />
          <p className="text-sm text-slate-500 font-medium">Select an organization above to view its members</p>
        </div>
      )}

      {/* Show loading for non-superadmin or when org is selected */}
      {isLoading && effectiveOrgId && (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      )}

      {/* Show content when we have an effective org */}
      {(!isSuperAdmin || selectedOrgId) && !isLoading && (

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="team" className="gap-1.5"><Users className="w-3.5 h-3.5" />Team</TabsTrigger>
          <TabsTrigger value="import" className="gap-1.5"><Upload className="w-3.5 h-3.5" />Bulk Import</TabsTrigger>
          <TabsTrigger value="settings" className="gap-1.5"><Settings className="w-3.5 h-3.5" />Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="team" className="mt-4">
          <div className="relative max-w-sm mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search members…" className="pl-9" />
          </div>
          <Card>
            <CardContent className="p-0">
              {filtered.length === 0 ? (
                <div className="text-center py-16">
                  <Users className="w-12 h-12 text-slate-200 mx-auto mb-3" />
                  <p className="text-sm text-slate-500">{search ? "No members match" : "No team members yet"}</p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  <div className="grid grid-cols-[2fr_1.5fr_1fr_1fr_auto] gap-4 px-5 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    <span>Member</span><span>Contact</span><span>Role</span><span>Status</span><span></span>
                  </div>
                  {filtered.map((member) => {
                    const roleDef = ROLE_DEFINITIONS.find((r) => r.value === member.role);
                    const overrides = Object.keys(member.module_permissions || {}).length;
                    return (
                      <div key={member.id} className="grid grid-cols-[2fr_1.5fr_1fr_1fr_auto] gap-4 items-center px-5 py-4 hover:bg-slate-50 transition-colors">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-[11px] font-bold text-white shrink-0">
                            {getInitials(member.full_name || member.email)}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-slate-900 truncate">{member.full_name || "Unnamed"}</p>
                            <p className="text-xs text-slate-400 truncate">{member.email}</p>
                          </div>
                        </div>
                        <div>
                          {member.phone ? <p className="text-xs text-slate-500 flex items-center gap-1"><Phone className="w-3 h-3 shrink-0" />{member.phone}</p>
                            : <p className="text-xs text-slate-300">No phone</p>}
                        </div>
                        <div>
                          {roleDef ? <Badge className={`text-[10px] ${roleDef.color}`}>{roleDef.label}</Badge>
                            : <Badge className="text-[10px] bg-amber-100 text-amber-600">Pending</Badge>}
                          {overrides > 0 && <p className="text-[10px] text-blue-500 mt-0.5">{overrides} overrides</p>}
                        </div>
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full capitalize ${getStatusBadge(member.status)}`}>
                          {member.status || "active"}
                        </span>
                        {member.id !== currentUser?.id && member.role !== "super_admin" ? (
                          <div className="flex items-center gap-1">
                            <Button variant="ghost" size="sm" onClick={() => { setEditMember(member); setShowModal(true); }} className="h-8 w-8 p-0 text-slate-400 hover:text-blue-600 hover:bg-blue-50">
                              <Edit2 className="w-3.5 h-3.5" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => handleRemove(member)} className="h-8 w-8 p-0 text-slate-400 hover:text-red-500 hover:bg-red-50">
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        ) : <div className="w-[72px]" />}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Role legend */}
          <Card className="mt-4">
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Shield className="w-4 h-4 text-slate-400" />Role Reference</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {ROLE_DEFINITIONS.filter((r) => isSuperAdmin || r.value !== "org_admin").map((r) => (
                  <div key={r.value} className="p-3 rounded-xl border border-slate-100 bg-slate-50/50">
                    <Badge className={`text-[10px] mb-2 ${r.color}`}>{r.label}</Badge>
                    <p className="text-[11px] text-slate-500 leading-snug">{r.description}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="import" className="mt-4">
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Upload className="w-4 h-4" />Bulk User Import via CSV</CardTitle></CardHeader>
            <CardContent>
              <CsvImport orgId={effectiveOrgId} currentUser={currentUser}
                onClose={() => setActiveTab("team")}
                onImported={() => queryClient.invalidateQueries({ queryKey: ["org-members"] })} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="settings" className="mt-4">
          <DomainSettings orgId={effectiveOrgId} />
        </TabsContent>
      </Tabs>
      )} {/* end: (!isSuperAdmin || selectedOrgId) && !isLoading */}

      {showModal && (
        <InviteModal open={showModal} onClose={() => { setShowModal(false); setEditMember(null); }}
          member={editMember} orgId={effectiveOrgId} currentUser={currentUser}
          enabledModules={enabledModules} isSuperAdmin={isSuperAdmin}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ["org-members"] })} />
      )}
    </div>
  );
}
