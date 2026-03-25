import React, { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";
import { logAudit } from "@/services/audit";
import { useAuth } from "@/lib/AuthContext";
import { useModuleAccess } from "@/lib/ModuleAccessContext";
import useOrgId from "@/hooks/useOrgId";
import { MODULE_DEFINITIONS } from "@/lib/moduleConfig";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Users, Plus, Loader2, Trash2, Shield, Edit2, Mail, Phone,
  ChevronDown, ChevronRight, Eye, Edit, Lock, CheckCircle2,
  User, Settings, Layers, Search, Briefcase
} from "lucide-react";
import { toast } from "sonner";

// ── Constants ─────────────────────────────────────────────────────────────────

const PRIMARY_ROLES = [
  { value: "viewer",    label: "Viewer",    description: "Read-only access to assigned modules", color: "bg-slate-100 text-slate-600" },
  { value: "editor",    label: "Editor",    description: "Can modify data in assigned modules",   color: "bg-emerald-100 text-emerald-700" },
  { value: "manager",   label: "Manager",   description: "Manage properties, leases & expenses",  color: "bg-blue-100 text-blue-700" },
  { value: "finance",   label: "Finance",   description: "Full financial module access",           color: "bg-purple-100 text-purple-700" },
  { value: "auditor",   label: "Auditor",   description: "Read-only audit & financial review",     color: "bg-yellow-100 text-yellow-700" },
  { value: "org_admin", label: "Admin",     description: "Full organization control",              color: "bg-amber-100 text-amber-700" },
  { value: "custom",    label: "Custom",    description: "Specify a custom role name",             color: "bg-pink-100 text-pink-700" },
];

// Business roles for labeling (display only, used in RequestAccess forms)
const BUSINESS_ROLES = ["Owner", "Landlord", "Finance", "Manager", "Employee"];

const ACCESS_LEVELS = [
  { value: "full",      label: "Full Access",  icon: Edit,  color: "text-emerald-600" },
  { value: "read_only", label: "Read Only",    icon: Eye,   color: "text-blue-600" },
  { value: "none",      label: "No Access",    icon: Lock,  color: "text-slate-400" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchOrgMembers(orgId) {
  if (!orgId || orgId === "__none__") return [];
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("memberships")
    .select(`
      id, user_id, role, custom_role, org_id, phone,
      page_permissions, module_permissions,
      profiles(id, email, full_name, avatar_url, phone)
    `)
    .eq("org_id", orgId);
  if (error) throw error;
  return (data || []).map((m) => ({
    membership_id: m.id,
    id: m.user_id,
    role: m.role,
    custom_role: m.custom_role,
    org_id: m.org_id,
    phone: m.phone || m.profiles?.phone || "",
    page_permissions: m.page_permissions || {},
    module_permissions: m.module_permissions || {},
    email: m.profiles?.email || "—",
    full_name: m.profiles?.full_name || null,
    avatar_url: m.profiles?.avatar_url || null,
  }));
}

async function callInviteEdgeFunction(payload) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.functions.invoke("invite-user", { body: payload });
  if (error) throw new Error(error.message || "Invite failed");
  return data;
}

function getRoleBadgeColor(role) {
  const r = PRIMARY_ROLES.find((x) => x.value === role);
  return r?.color || "bg-slate-100 text-slate-600";
}

function getRoleLabel(member) {
  if (member.role === "custom" && member.custom_role) return member.custom_role;
  const r = PRIMARY_ROLES.find((x) => x.value === member.role);
  return r?.label || member.role || "Viewer";
}

function getInitials(str) {
  return (str || "?").split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}

// ── Access Level Button ───────────────────────────────────────────────────────

function AccessLevelButton({ value, onChange }) {
  return (
    <div className="flex gap-1">
      {ACCESS_LEVELS.map((lvl) => {
        const Icon = lvl.icon;
        const isActive = value === lvl.value;
        return (
          <button
            key={lvl.value}
            type="button"
            onClick={() => onChange(lvl.value)}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium border transition-all ${
              isActive
                ? lvl.value === "full" ? "bg-emerald-50 border-emerald-400 text-emerald-700"
                  : lvl.value === "read_only" ? "bg-blue-50 border-blue-400 text-blue-700"
                  : "bg-slate-100 border-slate-400 text-slate-500"
                : "bg-white border-slate-200 text-slate-400 hover:border-slate-300"
            }`}
          >
            <Icon className="w-3 h-3" />
            {lvl.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Module Access Grid ────────────────────────────────────────────────────────

function ModuleAccessTab({ enabledModules, modulePerms, setModulePerms, pagePerms, setPagePerms }) {
  const [expanded, setExpanded] = useState({});

  const modules = useMemo(() => {
    const keys = enabledModules?.length > 0 ? enabledModules : Object.keys(MODULE_DEFINITIONS);
    return keys.map((k) => ({ key: k, ...MODULE_DEFINITIONS[k] })).filter(Boolean);
  }, [enabledModules]);

  const setModuleLevel = (key, level) => {
    setModulePerms((p) => ({ ...p, [key]: level }));
    // Also set all pages in this module to the same level
    const mod = MODULE_DEFINITIONS[key];
    if (mod?.pages) {
      setPagePerms((p) => {
        const next = { ...p };
        mod.pages.forEach((pg) => { next[pg] = level; });
        return next;
      });
    }
  };

  return (
    <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
      {modules.map(({ key, label, pages }) => {
        const modLevel = modulePerms[key] || "full";
        const isExpanded = expanded[key];
        return (
          <div key={key} className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-slate-50">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setExpanded((e) => ({ ...e, [key]: !e[key] }))}
                  className="text-slate-400 hover:text-slate-700"
                >
                  {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </button>
                <span className="text-sm font-semibold text-slate-800">{label}</span>
                <span className="text-[10px] text-slate-400">{pages?.length || 0} pages</span>
              </div>
              <AccessLevelButton value={modLevel} onChange={(v) => setModuleLevel(key, v)} />
            </div>
            {isExpanded && pages && (
              <div className="border-t border-slate-100 divide-y divide-slate-50">
                {pages.map((pg) => {
                  const pgLevel = pagePerms[pg] || modLevel;
                  return (
                    <div key={pg} className="flex items-center justify-between px-5 py-2.5 bg-white">
                      <span className="text-xs text-slate-600">{pg.replace(/([A-Z])/g, " $1").trim()}</span>
                      <AccessLevelButton
                        value={pgLevel}
                        onChange={(v) => setPagePerms((p) => ({ ...p, [pg]: v }))}
                      />
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
}

// ── Invite / Edit Dialog ──────────────────────────────────────────────────────

function UserDrawer({ open, onClose, member, orgId, currentUser, enabledModules, onSaved, isSuperAdmin }) {
  const isEditing = !!member;
  const [tab, setTab] = useState("details");
  const [fullName, setFullName] = useState(member?.full_name || "");
  const [email, setEmail] = useState(member?.email || "");
  const [phone, setPhone] = useState(member?.phone || "");
  const [role, setRole] = useState(member?.role || "viewer");
  const [customRole, setCustomRole] = useState(member?.custom_role || "");
  const [modulePerms, setModulePerms] = useState(member?.module_permissions || {});
  const [pagePerms, setPagePerms] = useState(member?.page_permissions || {});
  const [saving, setSaving] = useState(false);

  // Org admins cannot assign org_admin or super_admin; super admin can assign any role
  const availableRoles = isSuperAdmin
    ? PRIMARY_ROLES
    : PRIMARY_ROLES.filter((r) => r.value !== "org_admin");

  const handleSave = async () => {
    if (!isEditing && (!email || !orgId)) return;
    setSaving(true);
    try {
      if (isEditing) {
        // Update existing membership
        const { error } = await supabase
          .from("memberships")
          .update({
            role,
            custom_role: role === "custom" ? customRole : null,
            phone,
            module_permissions: modulePerms,
            page_permissions: pagePerms,
          })
          .eq("user_id", member.id)
          .eq("org_id", orgId);
        if (error) throw error;
        await logAudit({
          entityType: "Membership", entityId: member.id, action: "update",
          orgId, userId: currentUser?.id, userEmail: currentUser?.email,
          fieldChanged: "role/permissions", oldValue: member.role, newValue: role,
        });
        toast.success(`Updated ${fullName || email}`);
      } else {
        // Invite new user
        await callInviteEdgeFunction({
          email, full_name: fullName || undefined,
          role, custom_role: role === "custom" ? customRole : undefined,
          phone: phone || undefined,
          org_id: orgId,
          module_permissions: modulePerms,
          page_permissions: pagePerms,
        });
        await logAudit({
          entityType: "UserInvite", action: "create",
          orgId, userId: currentUser?.id, userEmail: currentUser?.email,
          newValue: `${email} invited as ${role}`,
        });
        toast.success(`Invitation sent to ${email}`);
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error((isEditing ? "Update" : "Invite") + " failed: " + (err.message || "Unknown"));
    }
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isEditing ? <Edit2 className="w-5 h-5 text-blue-600" /> : <Plus className="w-5 h-5 text-emerald-600" />}
            {isEditing ? `Edit — ${member?.full_name || member?.email}` : "Invite Team Member"}
          </DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-3 mb-4">
            <TabsTrigger value="details" className="gap-1"><User className="w-3.5 h-3.5" />Details</TabsTrigger>
            <TabsTrigger value="role" className="gap-1"><Shield className="w-3.5 h-3.5" />Role</TabsTrigger>
            <TabsTrigger value="modules" className="gap-1"><Layers className="w-3.5 h-3.5" />Access</TabsTrigger>
          </TabsList>

          {/* ── Details Tab ─────────────────────────────────────────────── */}
          <TabsContent value="details" className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Full Name</Label>
                <Input
                  value={fullName} onChange={(e) => setFullName(e.target.value)}
                  placeholder="Jane Smith" className="mt-1"
                />
              </div>
              <div>
                <Label>Email Address</Label>
                <Input
                  type="email" value={email}
                  onChange={isEditing ? undefined : (e) => setEmail(e.target.value)}
                  readOnly={isEditing}
                  placeholder="jane@company.com" className={`mt-1 ${isEditing ? "bg-slate-50 text-slate-400" : ""}`}
                />
              </div>
              <div className="col-span-2">
                <Label>Phone Number (optional)</Label>
                <Input
                  value={phone} onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 (555) 000-0000" className="mt-1"
                />
              </div>
            </div>
          </TabsContent>

          {/* ── Role Tab ─────────────────────────────────────────────────── */}
          <TabsContent value="role">
            <p className="text-xs text-slate-500 mb-4">
              Primary role sets default access. You can fine-tune module and page access in the Access tab.
            </p>
            <div className="grid grid-cols-2 gap-3 mb-4">
              {availableRoles.map((r) => (
                <div
                  key={r.value}
                  onClick={() => setRole(r.value)}
                  className={`p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
                    role === r.value ? "border-blue-500 bg-blue-50" : "border-slate-100 hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <Badge className={`text-[10px] ${r.color}`}>{r.label}</Badge>
                    {role === r.value && <CheckCircle2 className="w-4 h-4 text-blue-600" />}
                  </div>
                  <p className="text-[11px] text-slate-500 leading-tight">{r.description}</p>
                </div>
              ))}
            </div>
            {role === "custom" && (
              <div>
                <Label>Custom Role Title</Label>
                <Input
                  value={customRole}
                  onChange={(e) => setCustomRole(e.target.value)}
                  placeholder="e.g., Portfolio Analyst, Asset Manager"
                  className="mt-1"
                />
              </div>
            )}
          </TabsContent>

          {/* ── Module Access Tab ────────────────────────────────────────── */}
          <TabsContent value="modules">
            <p className="text-xs text-slate-500 mb-4">
              Set access levels per module. <span className="font-medium text-emerald-600">Full Access</span> = read + write. 
              <span className="font-medium text-blue-600 mx-1">Read Only</span> = view only.
              <span className="font-medium text-slate-400 mx-1">No Access</span> = hidden from nav.
              Expand a module to override individual pages.
            </p>
            <ModuleAccessTab
              enabledModules={enabledModules}
              modulePerms={modulePerms}
              setModulePerms={setModulePerms}
              pagePerms={pagePerms}
              setPagePerms={setPagePerms}
            />
          </TabsContent>
        </Tabs>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={handleSave}
            disabled={saving || (!isEditing && !email)}
            className="bg-[#1a2744] hover:bg-[#243b67]"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            {isEditing ? "Save Changes" : "Send Invitation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function UserManagement() {
  const { user: currentUser } = useAuth();
  const { enabledModules } = useModuleAccess();
  const { orgId } = useOrgId();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [showDrawer, setShowDrawer] = useState(false);
  const [editMember, setEditMember] = useState(null);

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["org-members", orgId],
    queryFn: () => fetchOrgMembers(orgId),
    enabled: !!orgId && orgId !== "__none__",
  });

  const handleRemove = async (member) => {
    if (!confirm(`Remove ${member.full_name || member.email} from the organization?`)) return;
    try {
      const { error } = await supabase
        .from("memberships").delete()
        .eq("user_id", member.id).eq("org_id", orgId);
      if (error) throw error;
      await logAudit({
        entityType: "Membership", entityId: member.id, action: "delete",
        orgId, userId: currentUser?.id, userEmail: currentUser?.email,
        oldValue: `${member.email} (${member.role})`,
      });
      toast.success(`Removed ${member.full_name || member.email}`);
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
    } catch (err) {
      toast.error("Failed to remove user: " + err.message);
    }
  };

  const canManage =
    currentUser?.role === "admin" || currentUser?._raw_role === "super_admin" ||
    currentUser?._raw_role === "org_admin" || currentUser?.role === "org_admin";

  const isSuperAdmin =
    currentUser?.role === "admin" || currentUser?._raw_role === "super_admin";

  const filtered = useMemo(
    () => members.filter((m) => {
      const q = search.toLowerCase();
      return !q || (m.full_name || "").toLowerCase().includes(q) || (m.email || "").toLowerCase().includes(q);
    }),
    [members, search]
  );

  if (!canManage) {
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-3">
        <Shield className="w-12 h-12 text-slate-200" />
        <p className="text-sm text-slate-500">You do not have permission to manage users.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">User Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {members.length} team member{members.length !== 1 ? "s" : ""} · manage roles, access & permissions
          </p>
        </div>
        <Button
          onClick={() => { setEditMember(null); setShowDrawer(true); }}
          className="bg-[#1a2744] hover:bg-[#243b67] gap-2"
        >
          <Plus className="w-4 h-4" /> Invite Member
        </Button>
      </div>

      {/* ── Search ── */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or email..."
          className="pl-9"
        />
      </div>

      {/* ── Members Table ── */}
      <Card className="shadow-sm">
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="text-center py-16">
              <Users className="w-12 h-12 text-slate-200 mx-auto mb-3" />
              <p className="text-sm text-slate-500">
                {search ? "No members match your search" : "No team members yet"}
              </p>
              {!search && (
                <p className="text-xs text-slate-400 mt-1">Invite your first team member to get started</p>
              )}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {/* Header row */}
              <div className="grid grid-cols-[2fr_1.5fr_1fr_1fr_auto] gap-4 px-5 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                <span>Member</span>
                <span>Contact</span>
                <span>Role</span>
                <span>Access</span>
                <span></span>
              </div>
              {filtered.map((member) => {
                const modCount = Object.keys(member.module_permissions || {}).length;
                const pgCount = Object.keys(member.page_permissions || {}).length;
                return (
                  <div
                    key={member.id}
                    className="grid grid-cols-[2fr_1.5fr_1fr_1fr_auto] gap-4 items-center px-5 py-4 hover:bg-slate-50 transition-colors"
                  >
                    {/* Member */}
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-[11px] font-bold text-white shrink-0">
                        {getInitials(member.full_name || member.email)}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900 truncate">{member.full_name || "Unnamed"}</p>
                        <p className="text-xs text-slate-400 truncate">{member.email}</p>
                      </div>
                    </div>

                    {/* Contact */}
                    <div className="min-w-0">
                      {member.phone ? (
                        <p className="text-xs text-slate-500 flex items-center gap-1">
                          <Phone className="w-3 h-3" /> {member.phone}
                        </p>
                      ) : (
                        <p className="text-xs text-slate-300">No phone</p>
                      )}
                    </div>

                    {/* Role */}
                    <div>
                      <Badge className={`text-[10px] capitalize ${getRoleBadgeColor(member.role)}`}>
                        {getRoleLabel(member)}
                      </Badge>
                    </div>

                    {/* Access summary */}
                    <div className="text-xs text-slate-500">
                      {pgCount > 0 ? (
                        <span className="text-blue-600 font-medium">{pgCount} page overrides</span>
                      ) : modCount > 0 ? (
                        <span>{modCount} modules set</span>
                      ) : (
                        <span className="text-slate-300">Default</span>
                      )}
                    </div>

                    {/* Actions */}
                    {member.id !== currentUser?.id && member.role !== "super_admin" ? (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => { setEditMember(member); setShowDrawer(true); }}
                          className="h-8 w-8 p-0 text-slate-400 hover:text-blue-600 hover:bg-blue-50"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => handleRemove(member)}
                          className="h-8 w-8 p-0 text-slate-400 hover:text-red-500 hover:bg-red-50"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ) : (
                      <div className="w-[72px]" />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Role Legend ── */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="w-4 h-4 text-slate-400" />
            Role Reference
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {PRIMARY_ROLES.filter((r) => r.value !== "custom").map((r) => (
              <div key={r.value} className="p-3 rounded-xl border border-slate-100 bg-slate-50/50">
                <Badge className={`text-[10px] mb-2 ${r.color}`}>{r.label}</Badge>
                <p className="text-[11px] text-slate-500 leading-snug">{r.description}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t border-slate-100">
            <p className="text-[11px] font-semibold text-slate-500 mb-2">Access Levels per Module / Page:</p>
            <div className="flex gap-4">
              {ACCESS_LEVELS.map((lvl) => {
                const Icon = lvl.icon;
                return (
                  <div key={lvl.value} className={`flex items-center gap-1.5 text-xs ${lvl.color}`}>
                    <Icon className="w-3.5 h-3.5" />
                    <span className="font-medium">{lvl.label}</span>
                    {lvl.value === "full" && <span className="text-slate-400 font-normal">— read + write</span>}
                    {lvl.value === "read_only" && <span className="text-slate-400 font-normal">— view only</span>}
                    {lvl.value === "none" && <span className="text-slate-400 font-normal">— hidden</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Drawer ── */}
      {showDrawer && (
        <UserDrawer
          open={showDrawer}
          onClose={() => { setShowDrawer(false); setEditMember(null); }}
          member={editMember}
          orgId={orgId}
          currentUser={currentUser}
          enabledModules={enabledModules}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ["org-members"] })}
          isSuperAdmin={isSuperAdmin}
        />
      )}
    </div>
  );
}
