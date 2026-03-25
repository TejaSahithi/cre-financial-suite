import React, { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";
import { logAudit } from "@/services/audit";
import { useAuth } from "@/lib/AuthContext";
import { useModuleAccess } from "@/lib/ModuleAccessContext";
import useOrgId from "@/hooks/useOrgId";
import { MODULE_DEFINITIONS } from "@/lib/moduleConfig";
import {
  ROLE_DEFINITIONS, getInitials, getStatusBadge, getRoleDefaultModulePerms, resolveEffectivePermissions
} from "@/lib/userPermissions";
import { RoleTab, AccessTab, CapabilitiesTab, SummaryPanel } from "@/components/userManagement/DrawerTabs";
import CsvImport from "@/components/userManagement/CsvImport";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Users, Plus, Loader2, Trash2, Shield, Edit2, Mail, Phone,
  Search, Upload, Settings, User, Layers, Zap, Eye, Globe
} from "lucide-react";
import { toast } from "sonner";

// ── DB helpers ────────────────────────────────────────────────────────────────
async function fetchOrgMembers(orgId) {
  if (!orgId || orgId === "__none__") return [];
  const { data, error } = await supabase
    .from("memberships")
    .select(`id, user_id, role, custom_role, org_id, phone, status,
      page_permissions, module_permissions, capabilities, scope, scope_portfolio_ids,
      profiles(id, email, full_name, avatar_url, phone)`)
    .eq("org_id", orgId);
  if (error) throw error;
  return (data || []).map((m) => ({
    membership_id: m.id,
    id: m.user_id,
    role: m.role,
    custom_role: m.custom_role,
    org_id: m.org_id,
    phone: m.phone || m.profiles?.phone || "",
    status: m.status || "active",
    page_permissions: m.page_permissions || {},
    module_permissions: m.module_permissions || {},
    capabilities: m.capabilities || {},
    scope: m.scope || "all",
    scope_portfolio_ids: m.scope_portfolio_ids || [],
    email: m.profiles?.email || "—",
    full_name: m.profiles?.full_name || null,
    avatar_url: m.profiles?.avatar_url || null,
  }));
}

async function fetchOrgSettings(orgId) {
  if (!orgId) return null;
  const { data } = await supabase.from("organizations").select(
    "allowed_email_domains, auto_join_enabled, auto_join_role, require_approval_for_auto_join"
  ).eq("id", orgId).single();
  return data;
}

// ── User Drawer ───────────────────────────────────────────────────────────────
function UserDrawer({ open, onClose, member, orgId, currentUser, enabledModules, onSaved, isSuperAdmin }) {
  const isEditing = !!member;
  const [tab, setTab] = useState("details");
  const [fullName, setFullName] = useState(member?.full_name || "");
  const [email, setEmail] = useState(member?.email || "");
  const [phone, setPhone] = useState(member?.phone || "");
  const [role, setRole] = useState(member?.role || "viewer");
  const [modulePerms, setModulePerms] = useState(
    member?.module_permissions && Object.keys(member.module_permissions).length > 0
      ? member.module_permissions
      : getRoleDefaultModulePerms(member?.role || "viewer")
  );
  const [pagePerms, setPagePerms] = useState(member?.page_permissions || {});
  const [capabilities, setCapabilities] = useState(member?.capabilities || {});
  const [saving, setSaving] = useState(false);

  const availableRoles = isSuperAdmin
    ? ROLE_DEFINITIONS.map((r) => r.value)
    : ROLE_DEFINITIONS.filter((r) => r.value !== "org_admin").map((r) => r.value);

  const handleSave = async () => {
    if (!isEditing && (!email || !orgId)) return;
    setSaving(true);
    try {
      if (isEditing) {
        const { error } = await supabase.from("memberships").update({
          role, phone, module_permissions: modulePerms,
          page_permissions: pagePerms, capabilities,
        }).eq("user_id", member.id).eq("org_id", orgId);
        if (error) throw error;
        await logAudit({ entityType: "Membership", entityId: member.id, action: "update",
          orgId, userId: currentUser?.id, userEmail: currentUser?.email,
          fieldChanged: "role/permissions", oldValue: member.role, newValue: role });
        toast.success(`Updated ${fullName || email}`);
      } else {
        const { error } = await supabase.functions.invoke("invite-user", {
          body: { email, full_name: fullName || undefined, role, phone: phone || undefined,
            org_id: orgId, module_permissions: modulePerms, page_permissions: pagePerms, capabilities },
        });
        if (error) throw new Error(error.message);
        await logAudit({ entityType: "UserInvite", action: "create",
          orgId, userId: currentUser?.id, userEmail: currentUser?.email,
          newValue: `${email} invited as ${role}` });
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
      <DialogContent className="max-w-4xl p-0 gap-0 overflow-hidden">
        <div className="flex h-[80vh] min-h-0">
          {/* Main form */}
          <div className="flex-1 flex flex-col min-w-0">
            <DialogHeader className="px-6 pt-5 pb-0 border-b border-slate-100">
              <DialogTitle className="flex items-center gap-2 pb-4">
                {isEditing ? <Edit2 className="w-5 h-5 text-blue-600" /> : <Plus className="w-5 h-5 text-emerald-600" />}
                {isEditing ? `Edit — ${member?.full_name || member?.email}` : "Invite Team Member"}
              </DialogTitle>
            </DialogHeader>

            <Tabs value={tab} onValueChange={setTab} className="flex-1 flex flex-col min-h-0">
              <TabsList className="grid grid-cols-4 mx-6 mt-4 mb-0">
                <TabsTrigger value="details" className="gap-1 text-xs"><User className="w-3 h-3" />Details</TabsTrigger>
                <TabsTrigger value="role" className="gap-1 text-xs"><Shield className="w-3 h-3" />Role</TabsTrigger>
                <TabsTrigger value="access" className="gap-1 text-xs"><Layers className="w-3 h-3" />Access</TabsTrigger>
                <TabsTrigger value="capabilities" className="gap-1 text-xs"><Zap className="w-3 h-3" />Capabilities</TabsTrigger>
              </TabsList>

              <div className="flex-1 overflow-y-auto px-6 py-4">
                <TabsContent value="details" className="mt-0 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div><Label>Full Name</Label><Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jane Smith" className="mt-1" /></div>
                    <div><Label>Email Address</Label><Input type="email" value={email} onChange={isEditing ? undefined : (e) => setEmail(e.target.value)} readOnly={isEditing} placeholder="jane@company.com" className={`mt-1 ${isEditing ? "bg-slate-50 text-slate-400" : ""}`} /></div>
                    <div className="col-span-2"><Label>Phone Number (optional)</Label><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 (555) 000-0000" className="mt-1" /></div>
                  </div>
                </TabsContent>

                <TabsContent value="role" className="mt-0">
                  <RoleTab role={role} setRole={setRole} setModulePerms={setModulePerms} setPagePerms={setPagePerms} availableRoles={availableRoles} />
                </TabsContent>

                <TabsContent value="access" className="mt-0">
                  <AccessTab role={role} modulePerms={modulePerms} setModulePerms={setModulePerms} pagePerms={pagePerms} setPagePerms={setPagePerms} enabledModules={enabledModules} />
                </TabsContent>

                <TabsContent value="capabilities" className="mt-0">
                  <CapabilitiesTab role={role} capabilities={capabilities} setCapabilities={setCapabilities} />
                </TabsContent>
              </div>
            </Tabs>

            <DialogFooter className="px-6 py-4 border-t border-slate-100">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving || (!isEditing && !email)} className="bg-[#1a2744] hover:bg-[#243b67]">
                {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                {isEditing ? "Save Changes" : "Send Invitation"}
              </Button>
            </DialogFooter>
          </div>

          {/* Summary sidebar */}
          <div className="w-56 bg-slate-50 border-l border-slate-100 p-4 overflow-y-auto">
            <SummaryPanel role={role} modulePerms={modulePerms} pagePerms={pagePerms} capabilities={capabilities} fullName={fullName} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Domain Settings Panel ─────────────────────────────────────────────────────
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
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2"><Globe className="w-4 h-4 text-slate-400" />Domain Auto-Join</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label className="text-xs">Allowed Email Domains</Label>
          <Input className="mt-1 text-sm" placeholder="company.com, subsidiary.org" defaultValue={(settings?.allowed_email_domains || []).join(", ")} onChange={(e) => setDomains(e.target.value)} />
          <p className="text-[11px] text-slate-400 mt-1">Users with these email domains will be auto-added to your org.</p>
        </div>
        <div className="flex items-center justify-between">
          <div><p className="text-xs font-medium text-slate-700">Require Admin Approval</p><p className="text-[11px] text-slate-400">Auto-joined users need approval before access is granted</p></div>
          <Switch defaultChecked={settings?.require_approval_for_auto_join ?? true} onCheckedChange={async (v) => { await supabase.from("organizations").update({ require_approval_for_auto_join: v }).eq("id", orgId); }} />
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
  const { orgId } = useOrgId();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("team");
  const [showDrawer, setShowDrawer] = useState(false);
  const [editMember, setEditMember] = useState(null);

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["org-members", orgId],
    queryFn: () => fetchOrgMembers(orgId),
    enabled: !!orgId && orgId !== "__none__",
  });

  const canManage = currentUser?.role === "admin" || currentUser?._raw_role === "super_admin" ||
    currentUser?._raw_role === "org_admin" || currentUser?.role === "org_admin";
  const isSuperAdmin = currentUser?.role === "admin" || currentUser?._raw_role === "super_admin";

  const handleRemove = async (member) => {
    if (!confirm(`Remove ${member.full_name || member.email} from the organization?`)) return;
    const { error } = await supabase.from("memberships").delete().eq("user_id", member.id).eq("org_id", orgId);
    if (error) { toast.error("Failed to remove user"); return; }
    await logAudit({ entityType: "Membership", entityId: member.id, action: "delete",
      orgId, userId: currentUser?.id, userEmail: currentUser?.email, oldValue: `${member.email} (${member.role})` });
    toast.success(`Removed ${member.full_name || member.email}`);
    queryClient.invalidateQueries({ queryKey: ["org-members"] });
  };

  const filtered = useMemo(() =>
    members.filter((m) => {
      const q = search.toLowerCase();
      return !q || (m.full_name || "").toLowerCase().includes(q) || (m.email || "").toLowerCase().includes(q);
    }), [members, search]);

  if (!canManage) {
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-3">
        <Shield className="w-12 h-12 text-slate-200" />
        <p className="text-sm text-slate-500">You do not have permission to manage users.</p>
      </div>
    );
  }

  if (isLoading) return <div className="flex items-center justify-center h-96"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;

  return (
    <div className="p-6 space-y-5 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">User Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">{members.length} team member{members.length !== 1 ? "s" : ""}</p>
        </div>
        <Button onClick={() => { setEditMember(null); setShowDrawer(true); }} className="bg-[#1a2744] hover:bg-[#243b67] gap-2">
          <Plus className="w-4 h-4" />Invite Member
        </Button>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="team" className="gap-1.5"><Users className="w-3.5 h-3.5" />Team</TabsTrigger>
          <TabsTrigger value="import" className="gap-1.5"><Upload className="w-3.5 h-3.5" />Bulk Import</TabsTrigger>
          <TabsTrigger value="settings" className="gap-1.5"><Settings className="w-3.5 h-3.5" />Settings</TabsTrigger>
        </TabsList>

        {/* ── Team Tab ── */}
        <TabsContent value="team" className="mt-4">
          <div className="relative max-w-sm mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search members..." className="pl-9" />
          </div>

          <Card>
            <CardContent className="p-0">
              {filtered.length === 0 ? (
                <div className="text-center py-16">
                  <Users className="w-12 h-12 text-slate-200 mx-auto mb-3" />
                  <p className="text-sm text-slate-500">{search ? "No members match your search" : "No team members yet"}</p>
                  {!search && <p className="text-xs text-slate-400 mt-1">Invite your first team member to get started</p>}
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  <div className="grid grid-cols-[2fr_1.4fr_1fr_1fr_auto] gap-4 px-5 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    <span>Member</span><span>Contact</span><span>Role</span><span>Status</span><span></span>
                  </div>
                  {filtered.map((member) => {
                    const roleDef = ROLE_DEFINITIONS.find((r) => r.value === member.role);
                    const overrideCount = Object.keys(member.module_permissions || {}).length;
                    return (
                      <div key={member.id} className="grid grid-cols-[2fr_1.4fr_1fr_1fr_auto] gap-4 items-center px-5 py-4 hover:bg-slate-50 transition-colors">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-[11px] font-bold text-white shrink-0">
                            {getInitials(member.full_name || member.email)}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-slate-900 truncate">{member.full_name || "Unnamed"}</p>
                            <p className="text-xs text-slate-400 truncate">{member.email}</p>
                          </div>
                        </div>
                        <div className="min-w-0">
                          {member.phone ? <p className="text-xs text-slate-500 flex items-center gap-1"><Phone className="w-3 h-3 shrink-0" />{member.phone}</p>
                            : <p className="text-xs text-slate-300">No phone</p>}
                        </div>
                        <div>
                          {roleDef ? <Badge className={`text-[10px] ${roleDef.color}`}>{roleDef.label}</Badge>
                            : <Badge className="text-[10px] bg-slate-100 text-slate-500">{member.role}</Badge>}
                          {overrideCount > 0 && <p className="text-[10px] text-blue-500 mt-0.5">{overrideCount} overrides</p>}
                        </div>
                        <div>
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full capitalize ${getStatusBadge(member.status)}`}>
                            {member.status || "active"}
                          </span>
                        </div>
                        {member.id !== currentUser?.id && member.role !== "super_admin" ? (
                          <div className="flex items-center gap-1">
                            <Button variant="ghost" size="sm" onClick={() => { setEditMember(member); setShowDrawer(true); }} className="h-8 w-8 p-0 text-slate-400 hover:text-blue-600 hover:bg-blue-50">
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

          {/* Role Legend */}
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

        {/* ── Import Tab ── */}
        <TabsContent value="import" className="mt-4">
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Upload className="w-4 h-4" />Bulk User Import via CSV</CardTitle></CardHeader>
            <CardContent>
              <CsvImport orgId={orgId} currentUser={currentUser} onClose={() => setActiveTab("team")} onImported={() => queryClient.invalidateQueries({ queryKey: ["org-members"] })} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Settings Tab ── */}
        <TabsContent value="settings" className="mt-4 space-y-4">
          <DomainSettings orgId={orgId} />
        </TabsContent>
      </Tabs>

      {/* User Drawer */}
      {showDrawer && (
        <UserDrawer open={showDrawer} onClose={() => { setShowDrawer(false); setEditMember(null); }}
          member={editMember} orgId={orgId} currentUser={currentUser}
          enabledModules={enabledModules} isSuperAdmin={isSuperAdmin}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ["org-members"] })} />
      )}
    </div>
  );
}
