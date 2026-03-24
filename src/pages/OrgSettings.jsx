import React, { useState, useEffect } from "react";
import { UserService, OrganizationService } from "@/services/api";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import useOrgId from "@/hooks/useOrgId";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Settings, Users, GitBranch, Bell, Save, Plus, Loader2, Package } from "lucide-react";
import { ALL_MODULE_KEYS, MODULE_DEFINITIONS } from "@/lib/moduleConfig";
import { toast } from "sonner";

const settingsTabs = [
  { id: "org", label: "Organization", icon: Settings },
  { id: "modules", label: "Modules", icon: Package },
  { id: "users", label: "Users & Roles", icon: Users },
  { id: "defaults", label: "CAM Defaults", icon: GitBranch },
  { id: "notifications", label: "Notifications", icon: Bell },
];

export default function OrgSettings() {
  const { orgId } = useOrgId();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("org");
  const [form, setForm] = useState({});
  const [dirty, setDirty] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("user");
  const [inviting, setInviting] = useState(false);

  const { data: org, isLoading } = useQuery({
    queryKey: ['org-settings', orgId],
    queryFn: async () => {
      if (!orgId || orgId === "__none__") return null;
      if (orgId === null) {
        // SuperAdmin — no specific org
        return null;
      }
      const orgs = await OrganizationService.filter({ id: orgId });
      return orgs[0] || null;
    },
    enabled: orgId !== undefined,
  });

  const { data: users = [] } = useQuery({
    queryKey: ['org-users'],
    queryFn: () => UserService.list(),
  });

  useEffect(() => {
    if (org) {
      setForm({
        name: org.name || "",
        address: org.address || "",
        phone: org.phone || "",
        timezone: org.timezone || "America/New_York",
        currency: org.currency || "USD",
        primary_contact_email: org.primary_contact_email || "",
        default_vacancy_handling: org.default_vacancy_handling || "include",
        default_allocation_model: org.default_allocation_model || "pro_rata",
        default_cap_type: org.default_cap_type || "none",
        default_cpi_index: org.default_cpi_index || "CPI-U",
        enabled_modules: org.enabled_modules || [],
      });
      setDirty(false);
    }
  }, [org]);

  const updateOrg = useMutation({
    mutationFn: (data) => OrganizationService.update(org.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-settings'] });
      setDirty(false);
      toast.success("Settings saved successfully");
    },
  });

  const handleSave = () => {
    if (!org) return;
    updateOrg.mutate(form);
  };

  const updateField = (key, val) => {
    setForm(prev => ({ ...prev, [key]: val }));
    setDirty(true);
  };

  const toggleModule = (moduleKey, checked) => {
    const current = form.enabled_modules || [];
    const updated = checked
      ? [...current, moduleKey]
      : current.filter(m => m !== moduleKey);
    updateField("enabled_modules", updated);
  };

  const handleInvite = async () => {
    if (!inviteEmail || !orgId) return;
    setInviting(true);
    try {
      const { data, error } = await supabase.functions.invoke('invite-user', {
        body: { 
          email: inviteEmail, 
          role: inviteRole, 
          org_id: orgId 
        }
      });

      if (error) throw new Error(error.message || "Invitation failed");

      // Audit log
      await logAudit({
        entityType: "UserInvite",
        action: "create",
        orgId,
        userId: user?.id,
        userEmail: user?.email,
        newValue: `${inviteEmail} invited as ${inviteRole}`,
      }).catch(err => console.error("Audit log error:", err));

      toast.success(`Invitation sent to ${inviteEmail}`);
      setShowInvite(false);
      setInviteEmail("");
      setInviteRole("user");
      queryClient.invalidateQueries({ queryKey: ['org-users'] });
    } catch (err) {
      console.error("Invite error:", err);
      toast.error(err.message || "Failed to send invitation");
    } finally {
      setInviting(false);
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-96"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;
  }

  if (!org) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-96">
        <Settings className="w-12 h-12 text-slate-300 mb-4" />
        <h2 className="text-xl font-bold text-slate-900 mb-2">No Organization Found</h2>
        <p className="text-sm text-slate-500">Complete onboarding to configure your organization settings.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Organization Settings</h1>
          <p className="text-sm text-slate-500">{org.name} · {(org.plan || 'starter').charAt(0).toUpperCase() + (org.plan || 'starter').slice(1)} Plan</p>
        </div>
        <Button onClick={handleSave} disabled={!dirty || updateOrg.isPending} className="bg-[#1a2744] hover:bg-[#243b67]">
          {updateOrg.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
          Save Changes
        </Button>
      </div>

      <div className="flex gap-6">
        {/* Sidebar */}
        <div className="w-56 flex-shrink-0 space-y-1">
          {settingsTabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === tab.id ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}>
              <tab.icon className="w-4 h-4" />{tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1">
          {activeTab === "org" && (
            <Card>
              <CardHeader><CardTitle className="text-lg">Organization Profile</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div><Label>Organization Name</Label><Input value={form.name || ""} onChange={e => updateField("name", e.target.value)} /></div>
                  <div><Label>Primary Contact Email</Label><Input value={form.primary_contact_email || ""} onChange={e => updateField("primary_contact_email", e.target.value)} /></div>
                  <div><Label>HQ Address</Label><Input value={form.address || ""} onChange={e => updateField("address", e.target.value)} /></div>
                  <div><Label>Phone</Label><Input value={form.phone || ""} onChange={e => updateField("phone", e.target.value)} /></div>
                  <div>
                    <Label>Time Zone</Label>
                    <Select value={form.timezone || "America/New_York"} onValueChange={v => updateField("timezone", v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="America/New_York">America/New_York (EST)</SelectItem>
                        <SelectItem value="America/Chicago">America/Chicago (CST)</SelectItem>
                        <SelectItem value="America/Phoenix">America/Phoenix (MST)</SelectItem>
                        <SelectItem value="America/Los_Angeles">America/Los_Angeles (PST)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Default Currency</Label>
                    <Select value={form.currency || "USD"} onValueChange={v => updateField("currency", v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USD">USD</SelectItem>
                        <SelectItem value="CAD">CAD</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "modules" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Enabled Modules</CardTitle>
                <p className="text-xs text-slate-500">Select which modules your organization has access to. If none are selected, all modules are available.</p>
              </CardHeader>
              <CardContent>
                <div className="flex justify-between items-center mb-4">
                  <p className="text-sm text-slate-600">{(form.enabled_modules || []).length === 0 ? 'All modules enabled (unrestricted)' : `${(form.enabled_modules || []).length} modules enabled`}</p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => updateField("enabled_modules", [...ALL_MODULE_KEYS])}>Select All</Button>
                    <Button variant="outline" size="sm" onClick={() => updateField("enabled_modules", [])}>Clear All</Button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {ALL_MODULE_KEYS.map(key => {
                    const mod = MODULE_DEFINITIONS[key];
                    const checked = (form.enabled_modules || []).includes(key);
                    return (
                      <div key={key} className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${checked ? 'bg-blue-50 border-blue-200' : 'border-slate-200 hover:border-slate-300'}`}>
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(val) => toggleModule(key, val)}
                        />
                        <div>
                          <p className="text-sm font-medium">{mod.label}</p>
                          <p className="text-[10px] text-slate-400">{mod.pages.length} page{mod.pages.length > 1 ? 's' : ''}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "users" && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg">Users & Role Assignments</CardTitle>
                <Button size="sm" onClick={() => setShowInvite(true)}><Plus className="w-4 h-4 mr-1" />Invite User</Button>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {users.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-8">No users found</p>
                  ) : users.map(u => (
                    <div key={u.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-blue-200 flex items-center justify-center text-xs font-bold text-blue-700">
                          {(u.full_name || u.email || "?").substring(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-medium">{u.full_name || "Unnamed"}</p>
                          <p className="text-xs text-slate-400">{u.email}</p>
                        </div>
                      </div>
                      <Badge className={`text-[10px] capitalize ${u.role === 'admin' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                        {u.role === 'admin' ? 'SuperAdmin' : (u.role || 'user').replace('_', ' ')}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "defaults" && (
            <Card>
              <CardHeader><CardTitle className="text-lg">CAM & Allocation Defaults</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Default Vacancy Handling</Label>
                    <Select value={form.default_vacancy_handling || "include"} onValueChange={v => updateField("default_vacancy_handling", v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="include">Include Vacancy</SelectItem>
                        <SelectItem value="exclude">Exclude Vacancy</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Default Allocation Model</Label>
                    <Select value={form.default_allocation_model || "pro_rata"} onValueChange={v => updateField("default_allocation_model", v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pro_rata">Pro-Rata (SqFt)</SelectItem>
                        <SelectItem value="equal">Equal Distribution</SelectItem>
                        <SelectItem value="weighted">Weighted</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Default CAM Cap Type</Label>
                    <Select value={form.default_cap_type || "none"} onValueChange={v => updateField("default_cap_type", v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No Cap</SelectItem>
                        <SelectItem value="fixed">Fixed %</SelectItem>
                        <SelectItem value="cpi">CPI-Based</SelectItem>
                        <SelectItem value="compounded">Compounded</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Default CPI Index</Label>
                    <Select value={form.default_cpi_index || "CPI-U"} onValueChange={v => updateField("default_cpi_index", v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CPI-U">CPI-U (All Urban Consumers)</SelectItem>
                        <SelectItem value="CPI-W">CPI-W (Wage Earners)</SelectItem>
                        <SelectItem value="custom">Custom</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "notifications" && (
            <Card>
              <CardHeader><CardTitle className="text-lg">Notification Preferences</CardTitle></CardHeader>
              <CardContent>
                <p className="text-sm text-slate-500">Notification templates and email preferences will be configured here. Configure stakeholder notification preferences on the Stakeholders page.</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Invite User Dialog */}
      <Dialog open={showInvite} onOpenChange={setShowInvite}>
        <DialogContent>
          <DialogHeader><DialogTitle>Invite User</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Email Address</Label>
              <Input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="user@company.com" className="mt-1" />
            </div>
            <div>
              <Label>Role</Label>
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInvite(false)}>Cancel</Button>
            <Button onClick={handleInvite} disabled={!inviteEmail || inviting} className="bg-blue-600 hover:bg-blue-700">
              {inviting && <Loader2 className="w-4 h-4 animate-spin mr-1" />}Send Invitation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}