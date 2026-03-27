import React, { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";
import { useAuth } from "@/lib/AuthContext";
import { logAudit } from "@/services/audit";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Plus, Upload, Search, Shield, Trash2, Mail, RefreshCw, CheckCircle2,
  X, Loader2, Users, UserX, Building2, Download, Eye,
  Settings2, Globe, AlertTriangle, UserCheck,
} from "lucide-react";

// ─── Module Definitions ──────────────────────────────────────────────────────
const PERMISSION_MODULES = [
  { key: "dashboard",   label: "Dashboard",        icon: "📊" },
  { key: "properties",  label: "Properties",        icon: "🏢" },
  { key: "leases",      label: "Leases",            icon: "📋" },
  { key: "expenses",    label: "Expenses",          icon: "💰" },
  { key: "cam",         label: "CAM Engine",        icon: "🔧" },
  { key: "budget",      label: "Budget Studio",     icon: "📈" },
  { key: "reports",     label: "Reports & Analytics", icon: "📑" },
  { key: "users",       label: "User Management",   icon: "👥" },
];

// ─── Access Level Definitions ─────────────────────────────────────────────────
const ACCESS_LEVELS = {
  full: { label: "Full Access", short: "Full",  color: "emerald", btnClass: "bg-emerald-600 text-white hover:bg-emerald-700",  chipClass: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  read: { label: "Read Only",   short: "Read",  color: "blue",    btnClass: "bg-blue-600 text-white hover:bg-blue-700",         chipClass: "bg-blue-100 text-blue-700 border-blue-200" },
  none: { label: "No Access",   short: "None",  color: "slate",   btnClass: "bg-slate-100 text-slate-500 hover:bg-slate-200",   chipClass: "bg-slate-100 text-slate-400 border-slate-200" },
};

// ─── Role Templates ───────────────────────────────────────────────────────────
const ROLE_TEMPLATES = {
  org_admin: {
    label: "Admin", badgeClass: "bg-violet-100 text-violet-700 border-violet-200",
    description: "Full organization control",
    modules: { dashboard: "full", properties: "full", leases: "full", expenses: "full", cam: "full", budget: "full", reports: "full", users: "full" },
  },
  manager: {
    label: "Manager", badgeClass: "bg-blue-100 text-blue-700 border-blue-200",
    description: "Manage properties, leases, expenses",
    modules: { dashboard: "full", properties: "full", leases: "full", expenses: "read", cam: "read", budget: "read", reports: "read", users: "none" },
  },
  editor: {
    label: "Editor", badgeClass: "bg-cyan-100 text-cyan-700 border-cyan-200",
    description: "Data entry and financial reporting",
    modules: { dashboard: "read", properties: "read", leases: "full", expenses: "full", cam: "read", budget: "full", reports: "read", users: "none" },
  },
  viewer: {
    label: "Viewer", badgeClass: "bg-slate-100 text-slate-600 border-slate-200",
    description: "Read-only across all modules",
    modules: { dashboard: "read", properties: "read", leases: "read", expenses: "read", cam: "read", budget: "read", reports: "read", users: "none" },
  },
  auditor: {
    label: "Auditor", badgeClass: "bg-amber-100 text-amber-700 border-amber-200",
    description: "Audit and financial review",
    modules: { dashboard: "read", properties: "none", leases: "none", expenses: "read", cam: "read", budget: "read", reports: "full", users: "none" },
  },
};

const DEFAULT_MODULES = { dashboard: "none", properties: "none", leases: "none", expenses: "none", cam: "none", budget: "none", reports: "none", users: "none" };
const ROLE_OPTIONS = Object.entries(ROLE_TEMPLATES).map(([v, c]) => ({ value: v, label: c.label }));

const STATUS_CONFIG = {
  active:    { label: "Active",    badgeClass: "bg-emerald-100 text-emerald-700", Icon: CheckCircle2 },
  invited:   { label: "Invited",   badgeClass: "bg-amber-100 text-amber-700",    Icon: Mail },
  no_access: { label: "No Access", badgeClass: "bg-red-100 text-red-600",         Icon: UserX },
};

// ─── Utilities ────────────────────────────────────────────────────────────────
function avatarColor(email = "") {
  const colors = ["#6366f1","#8b5cf6","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#14b8a6"];
  let h = 0;
  for (const c of email) h = (h * 31 + c.charCodeAt(0)) % colors.length;
  return colors[h];
}

function formatLastActive(ts) {
  if (!ts) return "Never";
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function deriveStatus(member) {
  if (member.status === "invited") return "invited";
  if (!member.role || member.role === "pending") return "no_access";
  return "active";
}

function getModulePermissions(member) {
  if (member.module_permissions && Object.keys(member.module_permissions).length > 0) {
    return { ...DEFAULT_MODULES, ...member.module_permissions };
  }
  if (member.role && ROLE_TEMPLATES[member.role]) {
    return { ...DEFAULT_MODULES, ...ROLE_TEMPLATES[member.role].modules };
  }
  return { ...DEFAULT_MODULES };
}

function detectTemplate(permissions) {
  for (const [key, tmpl] of Object.entries(ROLE_TEMPLATES)) {
    if (Object.entries(tmpl.modules).every(([k, v]) => permissions[k] === v)) return key;
  }
  return "custom";
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return lines.slice(1).map(line => {
    const vals = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
    return obj;
  }).filter(r => r.email);
}

// ─── ModuleMatrix Component ───────────────────────────────────────────────────
function ModuleMatrix({ permissions, onChange, readonly = false, compact = false }) {
  return (
    <div className={`space-y-${compact ? "1.5" : "2"}`}>
      {PERMISSION_MODULES.map(mod => {
        const current = permissions[mod.key] || "none";
        return (
          <div key={mod.key} className={`flex items-center justify-between ${compact ? "py-1" : "py-2 px-3 rounded-lg hover:bg-slate-50"}`}>
            <span className={`flex items-center gap-2 ${compact ? "text-xs text-slate-600" : "text-sm text-slate-700 font-medium"}`}>
              <span>{mod.icon}</span> {mod.label}
            </span>
            {readonly ? (
              <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${ACCESS_LEVELS[current]?.chipClass}`}>
                {ACCESS_LEVELS[current]?.short}
              </span>
            ) : (
              <div className="flex gap-1">
                {Object.entries(ACCESS_LEVELS).map(([level, cfg]) => (
                  <button
                    key={level}
                    onClick={() => onChange(mod.key, level)}
                    className={`text-xs px-2.5 py-1 rounded-lg font-medium transition-all border ${
                      current === level
                        ? cfg.btnClass + " border-transparent shadow-sm"
                        : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"
                    }`}
                  >
                    {cfg.short}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── ModuleAccessChips Component ──────────────────────────────────────────────
function ModuleAccessChips({ permissions, maxVisible = 3 }) {
  const active = PERMISSION_MODULES.filter(m => permissions[m.key] && permissions[m.key] !== "none");
  const visible = active.slice(0, maxVisible);
  const rest = active.length - maxVisible;
  if (active.length === 0) return <span className="text-xs text-slate-400 italic">No access</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map(m => (
        <span key={m.key} className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${ACCESS_LEVELS[permissions[m.key]]?.chipClass}`}>
          {m.icon} {m.label.split(" ")[0]}
        </span>
      ))}
      {rest > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded border bg-slate-100 text-slate-500 border-slate-200">+{rest}</span>}
    </div>
  );
}

// ─── UserDetailDrawer Component ───────────────────────────────────────────────
function UserDetailDrawer({ member, orgId, onClose, onSaved, isSuperAdmin }) {
  const queryClient = useQueryClient();
  const [permissions, setPermissions] = useState(getModulePermissions(member));
  const [template, setTemplate] = useState(detectTemplate(getModulePermissions(member)));
  const [saving, setSaving] = useState(false);
  const [removingUser, setRemovingUser] = useState(false);
  const status = deriveStatus(member);
  const StatusIcon = STATUS_CONFIG[status]?.Icon || CheckCircle2;

  const applyTemplate = (tmplKey) => {
    setTemplate(tmplKey);
    if (tmplKey !== "custom" && ROLE_TEMPLATES[tmplKey]) {
      setPermissions({ ...DEFAULT_MODULES, ...ROLE_TEMPLATES[tmplKey].modules });
    }
  };

  const handleModuleChange = (moduleKey, level) => {
    const next = { ...permissions, [moduleKey]: level };
    setPermissions(next);
    setTemplate(detectTemplate(next));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const effectiveRole = template !== "custom" ? template : (member.role || null);
      const { error } = await supabase
        .from("memberships")
        .update({ role: effectiveRole, module_permissions: permissions, status: effectiveRole ? "active" : member.status })
        .eq("user_id", member.user_id)
        .eq("org_id", orgId);
      if (error) throw error;
      await logAudit({ action: "update_permissions", target_user_id: member.user_id, details: { template: effectiveRole, modules: permissions } });
      toast.success("Permissions saved");
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
      onSaved?.();
    } catch (e) {
      toast.error(e.message || "Failed to save permissions");
    }
    setSaving(false);
  };

  const handleResendInvite = async () => {
    try {
      const { error } = await supabase.functions.invoke("invite-user", {
        body: { email: member.profiles?.email, full_name: member.profiles?.full_name, org_id: orgId, role: member.role || null, module_permissions: permissions },
      });
      if (error) throw error;
      toast.success("Invite resent");
    } catch (e) {
      toast.error(e.message || "Failed to resend invite");
    }
  };

  const handleRemove = async () => {
    if (!confirm(`Remove ${member.profiles?.full_name || member.profiles?.email} from this organization?`)) return;
    setRemovingUser(true);
    try {
      const { error } = await supabase.from("memberships").delete().eq("user_id", member.user_id).eq("org_id", orgId);
      if (error) throw error;
      await logAudit({ action: "remove_member", target_user_id: member.user_id });
      toast.success("Member removed");
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
      onClose();
    } catch (e) {
      toast.error(e.message || "Failed to remove member");
    }
    setRemovingUser(false);
  };

  const initials = (member.profiles?.full_name || member.profiles?.email || "?")
    .split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-[480px] bg-white shadow-2xl z-50 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50 flex-shrink-0">
          <h2 className="text-base font-bold text-slate-800">User Details</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-200 text-slate-500 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Profile Section */}
          <div className="px-6 py-5 border-b border-slate-100">
            <div className="flex items-start gap-4">
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center text-white font-bold text-lg flex-shrink-0"
                style={{ backgroundColor: avatarColor(member.profiles?.email) }}
              >
                {initials}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-bold text-slate-900 truncate">{member.profiles?.full_name || "—"}</h3>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${STATUS_CONFIG[status]?.badgeClass}`}>
                    <StatusIcon className="w-2.5 h-2.5 inline mr-1" />
                    {STATUS_CONFIG[status]?.label}
                  </span>
                </div>
                <p className="text-sm text-slate-500 truncate">{member.profiles?.email}</p>
                {member.profiles?.phone && <p className="text-xs text-slate-400 mt-0.5">{member.profiles.phone}</p>}
                <p className="text-xs text-slate-400 mt-1">Last active: {formatLastActive(member.profiles?.last_sign_in_at)}</p>
              </div>
            </div>
          </div>

          {/* Role Template */}
          <div className="px-6 py-5 border-b border-slate-100">
            <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3 block">Role Template</Label>
            <div className="grid grid-cols-3 gap-2">
              {ROLE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => applyTemplate(opt.value)}
                  className={`px-3 py-2 rounded-xl text-xs font-semibold border transition-all text-left ${
                    template === opt.value
                      ? ROLE_TEMPLATES[opt.value].badgeClass + " shadow-sm"
                      : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
                  }`}
                >
                  {opt.label}
                  <div className="text-[10px] opacity-70 font-normal mt-0.5 truncate">{ROLE_TEMPLATES[opt.value].description}</div>
                </button>
              ))}
              {template === "custom" && (
                <div className="px-3 py-2 rounded-xl text-xs font-semibold border bg-purple-50 border-purple-200 text-purple-700">
                  Custom
                  <div className="text-[10px] opacity-70 font-normal mt-0.5">Modified</div>
                </div>
              )}
            </div>
          </div>

          {/* Module Permissions */}
          <div className="px-6 py-5 border-b border-slate-100">
            <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3 block">Module Access</Label>
            <ModuleMatrix permissions={permissions} onChange={handleModuleChange} />
          </div>

          {/* Org Scope */}
          <div className="px-6 py-5 border-b border-slate-100">
            <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 block">Organization Scope</Label>
            <div className="flex items-center gap-2 text-sm text-slate-600 bg-slate-50 rounded-xl p-3">
              <Building2 className="w-4 h-4 text-slate-400" />
              <span>Scoped to current organization only</span>
            </div>
            {isSuperAdmin && (
              <div className="flex items-center gap-2 text-sm text-violet-700 bg-violet-50 rounded-xl p-3 mt-2">
                <Globe className="w-4 h-4" />
                <span className="text-xs font-medium">SuperAdmin: can view across all orgs</span>
              </div>
            )}
          </div>

          {/* Danger Zone */}
          <div className="px-6 py-5">
            <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3 block">Actions</Label>
            <div className="space-y-2">
              {status === "invited" && (
                <Button variant="outline" size="sm" className="w-full justify-start gap-2 text-sm" onClick={handleResendInvite}>
                  <Mail className="w-4 h-4 text-amber-500" /> Resend Invite Email
                </Button>
              )}
              <Button
                variant="outline" size="sm"
                className="w-full justify-start gap-2 text-sm border-red-200 text-red-600 hover:bg-red-50"
                onClick={handleRemove} disabled={removingUser}
              >
                {removingUser ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Remove from Organization
              </Button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex-shrink-0 flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button className="flex-1 bg-[#1a2744] hover:bg-[#1a2744]/90 text-white" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Save Permissions
          </Button>
        </div>
      </div>
    </>
  );
}

// ─── InviteDialog Component ───────────────────────────────────────────────────
function InviteDialog({ open, onClose, orgId }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ full_name: "", email: "", phone: "" });
  const [template, setTemplate] = useState("viewer");
  const [permissions, setPermissions] = useState({ ...DEFAULT_MODULES, ...ROLE_TEMPLATES.viewer.modules });
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState({});

  const applyTemplate = (tmplKey) => {
    setTemplate(tmplKey);
    setPermissions({ ...DEFAULT_MODULES, ...ROLE_TEMPLATES[tmplKey].modules });
  };

  const validate = () => {
    const e = {};
    if (!form.full_name.trim()) e.full_name = "Full name is required";
    if (!form.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = "Valid email is required";
    if (!form.phone.trim()) e.phone = "Phone number is required";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      const { error } = await supabase.functions.invoke("invite-user", {
        body: {
          email: form.email.trim(),
          full_name: form.full_name.trim(),
          phone: form.phone.trim(),
          role: template,
          org_id: orgId,
          module_permissions: permissions,
        },
      });
      if (error) throw error;
      toast.success(`Invite sent to ${form.email}`);
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
      setForm({ full_name: "", email: "", phone: "" });
      setTemplate("viewer");
      setPermissions({ ...DEFAULT_MODULES, ...ROLE_TEMPLATES.viewer.modules });
      onClose();
    } catch (e) {
      toast.error(e.message || "Failed to send invite");
    }
    setSubmitting(false);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold">Invite Team Member</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Contact Info */}
          <div>
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Contact Information</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Label className="text-sm font-medium mb-1.5 block">
                  Full Name <span className="text-red-500">*</span>
                </Label>
                <Input
                  placeholder="Jane Smith"
                  value={form.full_name}
                  onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))}
                  className={errors.full_name ? "border-red-400" : ""}
                />
                {errors.full_name && <p className="text-xs text-red-500 mt-1">{errors.full_name}</p>}
              </div>
              <div>
                <Label className="text-sm font-medium mb-1.5 block">
                  Email Address <span className="text-red-500">*</span>
                </Label>
                <Input
                  type="email" placeholder="jane@company.com"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  className={errors.email ? "border-red-400" : ""}
                />
                {errors.email && <p className="text-xs text-red-500 mt-1">{errors.email}</p>}
              </div>
              <div>
                <Label className="text-sm font-medium mb-1.5 block">
                  Phone Number <span className="text-red-500">*</span>
                </Label>
                <Input
                  type="tel" placeholder="+1 (555) 000-0000"
                  value={form.phone}
                  onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                  className={errors.phone ? "border-red-400" : ""}
                />
                {errors.phone && <p className="text-xs text-red-500 mt-1">{errors.phone}</p>}
              </div>
            </div>
          </div>

          <Separator />

          {/* Role Template */}
          <div>
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Role Template</h3>
            <div className="grid grid-cols-5 gap-2">
              {ROLE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => applyTemplate(opt.value)}
                  className={`px-3 py-2.5 rounded-xl text-xs font-semibold border transition-all text-center ${
                    template === opt.value
                      ? ROLE_TEMPLATES[opt.value].badgeClass + " shadow-sm"
                      : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-2">{ROLE_TEMPLATES[template]?.description} — customize below</p>
          </div>

          {/* Module Permissions */}
          <div>
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Module Access</h3>
            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/50">
              <ModuleMatrix
                permissions={permissions}
                onChange={(k, v) => setPermissions(p => ({ ...p, [k]: v }))}
              />
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className="bg-[#1a2744] hover:bg-[#1a2744]/90 text-white gap-2" onClick={handleSubmit} disabled={submitting}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
            Send Invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── CSVUploadDialog Component ────────────────────────────────────────────────
function CSVUploadDialog({ open, onClose, orgId }) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState([]);
  const [progress, setProgress] = useState(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const parsed = parseCSV(e.target.result);
      setRows(parsed.map(r => ({
        full_name: r.full_name || r.name || r["full name"] || "",
        email: r.email || "",
        phone: r.phone || r["phone number"] || r.mobile || "",
      })).filter(r => r.email));
    };
    reader.readAsText(file);
  };

  const downloadTemplate = () => {
    const csv = "full_name,email,phone\nJane Smith,jane@company.com,+1-555-0100\nJohn Doe,john@company.com,+1-555-0101";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "user_import_template.csv";
    a.click();
  };

  const handleImport = async () => {
    if (rows.length === 0) return;
    setProgress({ done: 0, total: rows.length, errors: [] });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const { error } = await supabase.functions.invoke("invite-user", {
          body: {
            email: row.email,
            full_name: row.full_name,
            phone: row.phone,
            org_id: orgId,
            role: null, // No role — no_access until admin assigns
          },
        });
        if (error) throw error;
        setProgress(p => ({ ...p, done: p.done + 1 }));
      } catch (e) {
        setProgress(p => ({ ...p, done: p.done + 1, errors: [...p.errors, `${row.email}: ${e.message}`] }));
      }
    }

    queryClient.invalidateQueries({ queryKey: ["org-members"] });
    toast.success(`Imported ${rows.length} users. Assign roles in the user table.`);
  };

  const done = progress?.done === progress?.total && progress !== null;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold">Import Users from CSV</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Info Banner */}
          <div className="flex items-start gap-3 p-3 bg-blue-50 border border-blue-100 rounded-xl">
            <AlertTriangle className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-blue-700">
              <strong>Import only extracts: Name, Email, Phone.</strong> No roles are assigned.
              Users are created with <strong>No Access</strong> status — assign roles individually after import.
            </div>
          </div>

          {/* Drop Zone */}
          {rows.length === 0 && (
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
              className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer ${dragging ? "border-blue-400 bg-blue-50" : "border-slate-200 hover:border-slate-300"}`}
            >
              <Upload className="w-8 h-8 text-slate-300 mx-auto mb-3" />
              <p className="text-sm font-medium text-slate-600 mb-1">Drop CSV file here</p>
              <p className="text-xs text-slate-400 mb-4">or click to browse</p>
              <label className="cursor-pointer">
                <input type="file" accept=".csv" className="hidden" onChange={e => { if (e.target.files[0]) handleFile(e.target.files[0]); }} />
                <span className="text-xs font-medium px-4 py-2 rounded-lg border border-slate-200 bg-white hover:border-slate-300 transition-colors">
                  Choose File
                </span>
              </label>
            </div>
          )}

          {/* Preview Table */}
          {rows.length > 0 && !progress && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-slate-700">{rows.length} users ready to import</p>
                <button className="text-xs text-slate-400 hover:text-slate-600" onClick={() => setRows([])}>Clear</button>
              </div>
              <div className="border border-slate-200 rounded-xl overflow-hidden max-h-52 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-2 text-left text-slate-500 font-medium">Name</th>
                      <th className="px-3 py-2 text-left text-slate-500 font-medium">Email</th>
                      <th className="px-3 py-2 text-left text-slate-500 font-medium">Phone</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((r, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-3 py-2 text-slate-700">{r.full_name || <span className="text-slate-400 italic">—</span>}</td>
                        <td className="px-3 py-2 text-slate-700">{r.email}</td>
                        <td className="px-3 py-2 text-slate-500">{r.phone || <span className="text-slate-400 italic">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-amber-600 mt-2 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                Users will be invited with No Access. Roles must be assigned manually.
              </p>
            </div>
          )}

          {/* Progress */}
          {progress && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-600 font-medium">Importing users…</span>
                <span className="text-slate-500">{progress.done} / {progress.total}</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-2">
                <div
                  className="bg-[#1a2744] h-2 rounded-full transition-all"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
              {done && (
                <div className="flex items-center gap-2 text-emerald-700 text-sm font-medium">
                  <CheckCircle2 className="w-4 h-4" /> Import complete!
                </div>
              )}
              {progress.errors.length > 0 && (
                <div className="text-xs text-red-600 space-y-0.5 mt-2">
                  {progress.errors.map((e, i) => <div key={i}>{e}</div>)}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" className="gap-2" onClick={downloadTemplate}>
            <Download className="w-3 h-3" /> Template
          </Button>
          <Button variant="outline" onClick={done ? onClose : onClose}>
            {done ? "Done" : "Cancel"}
          </Button>
          {rows.length > 0 && !progress && (
            <Button className="bg-[#1a2744] hover:bg-[#1a2744]/90 text-white gap-2" onClick={handleImport}>
              <Upload className="w-4 h-4" /> Import {rows.length} Users
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── BulkUpdateDialog Component ───────────────────────────────────────────────
function BulkUpdateDialog({ open, onClose, selectedMembers, orgId }) {
  const queryClient = useQueryClient();
  const [template, setTemplate] = useState("viewer");
  const [permissions, setPermissions] = useState({ ...DEFAULT_MODULES, ...ROLE_TEMPLATES.viewer.modules });
  const [saving, setSaving] = useState(false);

  const applyTemplate = (tmplKey) => {
    setTemplate(tmplKey);
    setPermissions({ ...DEFAULT_MODULES, ...ROLE_TEMPLATES[tmplKey].modules });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      for (const m of selectedMembers) {
        await supabase
          .from("memberships")
          .update({ role: template, module_permissions: permissions, status: "active" })
          .eq("user_id", m.user_id)
          .eq("org_id", orgId);
      }
      await logAudit({ action: "bulk_update_permissions", details: { count: selectedMembers.length, template, modules: permissions } });
      toast.success(`Updated ${selectedMembers.length} users`);
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
      onClose();
    } catch (e) {
      toast.error(e.message || "Bulk update failed");
    }
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold">Update {selectedMembers.length} Users</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="p-3 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-700">
            This will overwrite the current role and module permissions for all selected users.
          </div>

          <div>
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Role Template</h3>
            <div className="grid grid-cols-5 gap-2">
              {ROLE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => applyTemplate(opt.value)}
                  className={`px-3 py-2.5 rounded-xl text-xs font-semibold border transition-all text-center ${
                    template === opt.value
                      ? ROLE_TEMPLATES[opt.value].badgeClass + " shadow-sm"
                      : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Module Access</h3>
            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/50">
              <ModuleMatrix
                permissions={permissions}
                onChange={(k, v) => setPermissions(p => ({ ...p, [k]: v }))}
              />
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className="bg-[#1a2744] hover:bg-[#1a2744]/90 text-white gap-2" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
            Apply to {selectedMembers.length} Users
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main UserManagement Component ───────────────────────────────────────────
export default function UserManagement() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const isSuperAdmin = user?.memberships?.some(m => m.role === "super_admin");
  const defaultOrgId = user?.activeOrg?.id || user?.org_id;

  // SuperAdmin org switcher state
  const [selectedOrgId, setSelectedOrgId] = useState(defaultOrgId);
  const [selectedOrgName, setSelectedOrgName] = useState(user?.activeOrg?.name || "My Organization");

  // UI State
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterModule, setFilterModule] = useState("all");
  const [filterTemplate, setFilterTemplate] = useState("all");
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [drawerMember, setDrawerMember] = useState(null);
  const [showInvite, setShowInvite] = useState(false);
  const [showCSV, setShowCSV] = useState(false);
  const [showBulkUpdate, setShowBulkUpdate] = useState(false);

  const activeOrgId = selectedOrgId || defaultOrgId;

  // ── Fetch all orgs (SuperAdmin only) ─────────────────────────────────────
  const { data: allOrgs = [] } = useQuery({
    queryKey: ["all-orgs-for-sa"],
    queryFn: async () => {
      const { data, error } = await supabase.from("organizations").select("id, name, status").order("name");
      if (error) throw error;
      return data || [];
    },
    enabled: isSuperAdmin,
  });

  // ── Fetch members for selected org ────────────────────────────────────────
  const { data: members = [], isLoading } = useQuery({
    queryKey: ["org-members", activeOrgId],
    queryFn: async () => {
      if (!activeOrgId) return [];
      const { data, error } = await supabase
        .from("memberships")
        .select(`
          id, user_id, role, status, module_permissions, page_permissions,
          created_at, updated_at,
          profiles!inner(id, full_name, email, phone, status, last_sign_in_at, avatar_url)
        `)
        .eq("org_id", activeOrgId)
        .neq("role", "super_admin");
      if (error) throw error;
      return data || [];
    },
    enabled: !!activeOrgId,
  });

  // ── Derived Stats ──────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total = members.length;
    const active = members.filter(m => deriveStatus(m) === "active").length;
    const invited = members.filter(m => deriveStatus(m) === "invited").length;
    const noAccess = members.filter(m => deriveStatus(m) === "no_access").length;
    return { total, active, invited, noAccess };
  }, [members]);

  // ── Filtered Members ───────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    return members.filter(m => {
      const name = (m.profiles?.full_name || "").toLowerCase();
      const email = (m.profiles?.email || "").toLowerCase();
      const q = searchQuery.toLowerCase();
      if (q && !name.includes(q) && !email.includes(q)) return false;
      if (filterStatus !== "all" && deriveStatus(m) !== filterStatus) return false;
      if (filterTemplate !== "all" && m.role !== filterTemplate) return false;
      if (filterModule !== "all") {
        const perms = getModulePermissions(m);
        if (perms[filterModule] === "none" || !perms[filterModule]) return false;
      }
      return true;
    });
  }, [members, searchQuery, filterStatus, filterModule, filterTemplate]);

  const selectedMembers = members.filter(m => selectedIds.has(m.user_id));
  const allSelected = filtered.length > 0 && filtered.every(m => selectedIds.has(m.user_id));

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map(m => m.user_id)));
    }
  };

  const clearFilters = () => {
    setSearchQuery("");
    setFilterStatus("all");
    setFilterModule("all");
    setFilterTemplate("all");
  };

  const hasFilters = searchQuery || filterStatus !== "all" || filterModule !== "all" || filterTemplate !== "all";

  // ── Bulk Remove ────────────────────────────────────────────────────────────
  const handleBulkRemove = async () => {
    if (!confirm(`Remove ${selectedMembers.length} members from this organization?`)) return;
    try {
      for (const m of selectedMembers) {
        await supabase.from("memberships").delete().eq("user_id", m.user_id).eq("org_id", activeOrgId);
      }
      await logAudit({ action: "bulk_remove_members", details: { count: selectedMembers.length } });
      toast.success(`Removed ${selectedMembers.length} members`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
    } catch (e) {
      toast.error("Failed to remove members");
    }
  };

  // ── Bulk Resend ────────────────────────────────────────────────────────────
  const handleBulkResend = async () => {
    const invitedMembers = selectedMembers.filter(m => deriveStatus(m) === "invited");
    if (invitedMembers.length === 0) { toast.info("No invited users selected"); return; }
    try {
      for (const m of invitedMembers) {
        await supabase.functions.invoke("invite-user", {
          body: { email: m.profiles?.email, full_name: m.profiles?.full_name, org_id: activeOrgId, role: m.role || null },
        });
      }
      toast.success(`Resent invites to ${invitedMembers.length} users`);
    } catch (e) {
      toast.error("Failed to resend some invites");
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">

      {/* ─── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-black text-slate-900">User Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {isSuperAdmin ? "Manage users across all organizations" : "Manage your team members and their access"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-2 h-9" onClick={() => setShowCSV(true)}>
            <Upload className="w-4 h-4" /> Import CSV
          </Button>
          <Button size="sm" className="gap-2 h-9 bg-[#1a2744] hover:bg-[#1a2744]/90 text-white" onClick={() => setShowInvite(true)}>
            <Plus className="w-4 h-4" /> Invite Member
          </Button>
        </div>
      </div>

      {/* ─── SuperAdmin Org Switcher ──────────────────────────────────────── */}
      {isSuperAdmin && allOrgs.length > 0 && (
        <Card className="border-violet-200 bg-violet-50/50">
          <CardContent className="p-4">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-2 text-sm font-semibold text-violet-700">
                <Globe className="w-4 h-4" />
                SuperAdmin View
              </div>
              <div className="flex-1 max-w-sm">
                <Select
                  value={selectedOrgId || ""}
                  onValueChange={(val) => {
                    setSelectedOrgId(val);
                    const org = allOrgs.find(o => o.id === val);
                    setSelectedOrgName(org?.name || "Unknown Org");
                    setSelectedIds(new Set());
                  }}
                >
                  <SelectTrigger className="h-9 bg-white border-violet-200">
                    <SelectValue placeholder="Select organization to manage" />
                  </SelectTrigger>
                  <SelectContent>
                    {allOrgs.map(org => (
                      <SelectItem key={org.id} value={org.id}>
                        <div className="flex items-center gap-2">
                          <Building2 className="w-3 h-3 text-slate-400" />
                          {org.name}
                          <span className={`text-[10px] px-1.5 rounded-full ${org.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                            {org.status}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="text-xs text-violet-600 bg-violet-100 px-3 py-1.5 rounded-lg font-medium">
                Viewing: <strong>{selectedOrgName}</strong>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Stats Cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: "Total Members", value: stats.total, Icon: Users, color: "slate", bg: "bg-slate-50", iconColor: "text-slate-500" },
          { label: "Active", value: stats.active, Icon: UserCheck, color: "emerald", bg: "bg-emerald-50", iconColor: "text-emerald-500" },
          { label: "Invited", value: stats.invited, Icon: Mail, color: "amber", bg: "bg-amber-50", iconColor: "text-amber-500" },
          { label: "No Access", value: stats.noAccess, Icon: UserX, color: "red", bg: "bg-red-50", iconColor: "text-red-500" },
        ].map(s => (
          <Card key={s.label} className={`border-0 shadow-sm ${s.bg}`}>
            <CardContent className="p-4 flex items-center gap-3">
              <s.Icon className={`w-7 h-7 ${s.iconColor}`} />
              <div>
                <div className="text-2xl font-black text-slate-900">{s.value}</div>
                <div className="text-xs text-slate-500 font-medium">{s.label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ─── No Access Warning ────────────────────────────────────────────── */}
      {stats.noAccess > 0 && (
        <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm">
          <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
          <span className="text-amber-800">
            <strong>{stats.noAccess} user{stats.noAccess > 1 ? "s" : ""}</strong> have no role assigned and cannot access the platform. Use the table below to assign permissions.
          </span>
        </div>
      )}

      {/* ─── Filter Bar ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search name or email…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
        </div>

        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="h-9 w-36 text-sm">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="invited">Invited</SelectItem>
            <SelectItem value="no_access">No Access</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterTemplate} onValueChange={setFilterTemplate}>
          <SelectTrigger className="h-9 w-36 text-sm">
            <SelectValue placeholder="Role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            {ROLE_OPTIONS.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={filterModule} onValueChange={setFilterModule}>
          <SelectTrigger className="h-9 w-40 text-sm">
            <SelectValue placeholder="Module" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Modules</SelectItem>
            {PERMISSION_MODULES.map(m => <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>)}
          </SelectContent>
        </Select>

        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-9 text-xs text-slate-500 gap-1" onClick={clearFilters}>
            <X className="w-3.5 h-3.5" /> Clear
          </Button>
        )}

        <div className="ml-auto text-xs text-slate-400">
          {filtered.length} of {members.length} members
        </div>
      </div>

      {/* ─── Bulk Action Bar ──────────────────────────────────────────────── */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-5 py-3 bg-[#1a2744] rounded-xl shadow-lg">
          <span className="text-sm text-white font-semibold mr-1">
            {selectedIds.size} selected
          </span>
          <Button size="sm" variant="ghost" className="h-8 text-xs text-white hover:bg-white/10 gap-1.5" onClick={() => setShowBulkUpdate(true)}>
            <Settings2 className="w-3.5 h-3.5" /> Assign Role & Access
          </Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs text-white hover:bg-white/10 gap-1.5" onClick={handleBulkResend}>
            <RefreshCw className="w-3.5 h-3.5" /> Resend Invites
          </Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs text-red-300 hover:bg-white/10 gap-1.5 ml-auto" onClick={handleBulkRemove}>
            <Trash2 className="w-3.5 h-3.5" /> Remove ({selectedIds.size})
          </Button>
          <button className="text-white/60 hover:text-white ml-1" onClick={() => setSelectedIds(new Set())}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ─── Table ────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 shadow-sm overflow-hidden bg-white">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50 hover:bg-slate-50">
              <TableHead className="w-10 px-4">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Select all"
                />
              </TableHead>
              <TableHead className="font-semibold text-slate-600 text-xs uppercase tracking-wide">Member</TableHead>
              <TableHead className="font-semibold text-slate-600 text-xs uppercase tracking-wide">Role</TableHead>
              <TableHead className="font-semibold text-slate-600 text-xs uppercase tracking-wide">Module Access</TableHead>
              <TableHead className="font-semibold text-slate-600 text-xs uppercase tracking-wide">Status</TableHead>
              <TableHead className="font-semibold text-slate-600 text-xs uppercase tracking-wide">Last Active</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="py-16 text-center">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto text-slate-300" />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-16 text-center">
                  <Users className="w-8 h-8 text-slate-200 mx-auto mb-2" />
                  <p className="text-sm text-slate-400 font-medium">
                    {hasFilters ? "No members match your filters" : "No members yet"}
                  </p>
                  {!hasFilters && (
                    <Button size="sm" className="mt-3 gap-1.5 bg-[#1a2744] text-white" onClick={() => setShowInvite(true)}>
                      <Plus className="w-3.5 h-3.5" /> Invite First Member
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(member => {
                const status = deriveStatus(member);
                const statusCfg = STATUS_CONFIG[status];
                const StatusIcon = statusCfg?.Icon || CheckCircle2;
                const perms = getModulePermissions(member);
                const tmplKey = detectTemplate(perms);
                const tmpl = ROLE_TEMPLATES[member.role] || ROLE_TEMPLATES[tmplKey];
                const initials = (member.profiles?.full_name || member.profiles?.email || "?")
                  .split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
                const isSelected = selectedIds.has(member.user_id);

                return (
                  <TableRow
                    key={member.user_id}
                    className={`cursor-pointer transition-colors ${isSelected ? "bg-[#1a2744]/5" : "hover:bg-slate-50/80"}`}
                    onClick={() => setDrawerMember(member)}
                  >
                    <TableCell className="px-4" onClick={e => e.stopPropagation()}>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleSelect(member.user_id)}
                        aria-label="Select row"
                      />
                    </TableCell>

                    {/* Member */}
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div
                          className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                          style={{ backgroundColor: avatarColor(member.profiles?.email) }}
                        >
                          {initials}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-slate-800 truncate">
                              {member.profiles?.full_name || <span className="text-slate-400 italic">Unnamed</span>}
                            </span>
                            {status === "no_access" && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-bold uppercase tracking-wide flex-shrink-0">
                                Needs Role
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-400 truncate">{member.profiles?.email}</p>
                          {member.profiles?.phone && <p className="text-[10px] text-slate-300">{member.profiles.phone}</p>}
                        </div>
                      </div>
                    </TableCell>

                    {/* Role */}
                    <TableCell>
                      {member.role ? (
                        <span className={`text-xs px-2.5 py-1 rounded-full font-semibold border ${ROLE_TEMPLATES[member.role]?.badgeClass || "bg-slate-100 text-slate-600 border-slate-200"}`}>
                          {ROLE_TEMPLATES[member.role]?.label || member.role}
                          {tmplKey === "custom" && <span className="ml-1 opacity-60">(custom)</span>}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400 italic">No role</span>
                      )}
                    </TableCell>

                    {/* Module Access */}
                    <TableCell>
                      <ModuleAccessChips permissions={perms} maxVisible={4} />
                    </TableCell>

                    {/* Status */}
                    <TableCell>
                      <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-semibold ${statusCfg?.badgeClass}`}>
                        <StatusIcon className="w-3 h-3" />
                        {statusCfg?.label}
                      </span>
                    </TableCell>

                    {/* Last Active */}
                    <TableCell>
                      <span className="text-xs text-slate-400">
                        {formatLastActive(member.profiles?.last_sign_in_at)}
                      </span>
                    </TableCell>

                    {/* Actions */}
                    <TableCell onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
                          title="View details"
                          onClick={() => setDrawerMember(member)}
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* ─── Modals & Drawer ──────────────────────────────────────────────── */}
      {drawerMember && (
        <UserDetailDrawer
          member={drawerMember}
          orgId={activeOrgId}
          isSuperAdmin={isSuperAdmin}
          onClose={() => setDrawerMember(null)}
          onSaved={() => setDrawerMember(null)}
        />
      )}

      <InviteDialog open={showInvite} onClose={() => setShowInvite(false)} orgId={activeOrgId} />
      <CSVUploadDialog open={showCSV} onClose={() => setShowCSV(false)} orgId={activeOrgId} />
      {showBulkUpdate && (
        <BulkUpdateDialog
          open={showBulkUpdate}
          onClose={() => { setShowBulkUpdate(false); setSelectedIds(new Set()); }}
          selectedMembers={selectedMembers}
          orgId={activeOrgId}
        />
      )}
    </div>
  );
}
