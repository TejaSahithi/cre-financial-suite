import React, { useState } from "react";
import { StakeholderService } from "@/services/api";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Bell, BellOff, Pencil, Trash2, Loader2, Search, Shield } from "lucide-react";

const roleColors = {
  owner: "bg-blue-100 text-blue-700", property_manager: "bg-emerald-100 text-emerald-700",
  leasing_agent: "bg-amber-100 text-amber-700", finance: "bg-violet-100 text-violet-700",
  accountant: "bg-rose-100 text-rose-700", asset_manager: "bg-slate-100 text-slate-700"
};

const roleLabels = {
  owner: "Owner", property_manager: "Property Manager", leasing_agent: "Leasing Agent",
  finance: "Finance", accountant: "Accountant", asset_manager: "Asset Manager"
};

const notifGroups = [
  { key: "notify_lease_expiry", label: "Lease Expiry Alerts", desc: "Notify 12mo, 6mo, 3mo, 1mo before expiry" },
  { key: "notify_budget_approval", label: "Budget Approval Requests", desc: "Notify when budget submitted for approval" },
  { key: "notify_cam_variance", label: "CAM Variance Alerts", desc: "Notify when CAM pool changes >10% vs prior year" },
  { key: "notify_reconciliation", label: "Reconciliation Pending", desc: "Notify when year-end actuals are ready" },
  { key: "notify_audit_anomaly", label: "Audit Anomaly Alerts", desc: "Notify on unusual override activity" },
];

const accessRoles = [
  { label: "Full CRUD", roles: ["Owner", "Property Manager"] },
  { label: "Budget & CAM Edit", roles: ["Finance", "Accountant"] },
  { label: "Read-Only Reports", roles: ["Asset Manager"] },
  { label: "Lease Upload", roles: ["Property Manager"] },
];

export default function Stakeholders() {
  const [showInvite, setShowInvite] = useState(false);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ name: "", email: "", role: "property_manager" });
  const [editingStakeholder, setEditingStakeholder] = useState(null);
  const queryClient = useQueryClient();

  const { data: stakeholders = [], isLoading } = useQuery({
    queryKey: ['stakeholders'],
    queryFn: () => StakeholderService.list(),
  });

  const createMutation = useMutation({
    mutationFn: (data) => StakeholderService.create(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['stakeholders'] }); setShowInvite(false); setForm({ name: "", email: "", role: "property_manager" }); }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => StakeholderService.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stakeholders'] });
      setEditingStakeholder(null);
      setShowInvite(false);
      setForm({ name: "", email: "", role: "property_manager" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => StakeholderService.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['stakeholders'] }),
  });

  const roleCounts = {};
  stakeholders.forEach(s => { roleCounts[s.role] = (roleCounts[s.role] || 0) + 1; });

  const filtered = stakeholders.filter(s => s.name?.toLowerCase().includes(search.toLowerCase()) || s.email?.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Stakeholders</h1>
          <p className="text-sm text-slate-500">{stakeholders.length} assigned</p>
        </div>
        <Button
          onClick={() => {
            setEditingStakeholder(null);
            setForm({ name: "", email: "", role: "property_manager" });
            setShowInvite(true);
          }}
          className="bg-blue-600 hover:bg-blue-700"
        >
          <Plus className="w-4 h-4 mr-2" />Invite Stakeholder
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <Input placeholder="Search stakeholders..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {/* Role counts */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        {Object.entries(roleLabels).map(([key, label]) => (
          <Card key={key} className={`border-t-2 ${roleColors[key]?.split(' ')[0].replace('bg-', 'border-t-')}`}>
            <CardContent className="p-3">
              <p className="text-[10px] font-semibold text-slate-500 uppercase">{label}</p>
              <p className="text-xl font-bold">{roleCounts[key] || 0}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Stakeholder list */}
        <div className="lg:col-span-2 space-y-3">
          {isLoading ? <div className="text-center py-8"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div> :
          filtered.length === 0 ? <Card><CardContent className="p-8 text-center text-slate-400">No stakeholders assigned yet</CardContent></Card> :
          filtered.map(s => (
            <div key={s.id} className="flex items-center justify-between p-4 bg-white border rounded-xl hover:shadow-sm transition-shadow">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${roleColors[s.role]}`}>
                  {s.name?.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-slate-900">{s.name}</p>
                    <Badge className={`${roleColors[s.role]} text-[10px] uppercase`}>{roleLabels[s.role] || s.role}</Badge>
                  </div>
                  <p className="text-xs text-slate-400 flex items-center gap-1">✉ {s.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  {s.notify_lease_expiry ? <Bell className="w-4 h-4 text-slate-400" /> : <BellOff className="w-4 h-4 text-slate-300" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => {
                    setEditingStakeholder(s);
                    setForm({ name: s.name || "", email: s.email || "", role: s.role || "property_manager" });
                    setShowInvite(true);
                  }}
                >
                  <Pencil className="w-4 h-4 text-slate-400" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => deleteMutation.mutate(s.id)}><Trash2 className="w-4 h-4 text-red-400" /></Button>
              </div>
            </div>
          ))}
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-slate-500" />
                <CardTitle className="text-base">Notification Groups</CardTitle>
              </div>
              <p className="text-xs text-slate-400">Configure which events trigger email + in-app notifications for assigned stakeholders.</p>
            </CardHeader>
            <CardContent className="space-y-3">
              {notifGroups.map(n => (
                <div key={n.key} className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{n.label}</p>
                    <p className="text-[10px] text-slate-400">{n.desc}</p>
                  </div>
                  <Badge className={n.key !== 'notify_reconciliation' ? 'bg-emerald-100 text-emerald-700 text-[10px]' : 'bg-slate-100 text-slate-500 text-[10px]'}>
                    {n.key !== 'notify_reconciliation' ? 'ON' : 'OFF'}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-slate-500" />
                <CardTitle className="text-base">Property Access</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {accessRoles.map((a, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
                  <p className="text-sm text-slate-700">{a.label}</p>
                  <div className="flex gap-1">
                    {a.roles.map(r => (
                      <Badge key={r} className={`text-[10px] ${roleColors[r.toLowerCase().replace(' ', '_')] || 'bg-blue-100 text-blue-700'}`}>{r}</Badge>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Invite / Edit Dialog */}
      <Dialog open={showInvite} onOpenChange={setShowInvite}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editingStakeholder ? "Edit Stakeholder" : "Invite Stakeholder"}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div><Label>Full Name *</Label><Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="Richard Martinez" /></div>
            <div><Label>Email *</Label><Input type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} placeholder="r.martinez@company.com" /></div>
            <div>
              <Label>Role *</Label>
              <Select value={form.role} onValueChange={v => setForm({...form, role: v})}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(roleLabels).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowInvite(false);
                setEditingStakeholder(null);
                setForm({ name: "", email: "", role: "property_manager" });
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (editingStakeholder) {
                  updateMutation.mutate({ id: editingStakeholder.id, data: form });
                  return;
                }
                createMutation.mutate({ ...form, org_id: "default" });
              }}
              disabled={!form.name || !form.email || createMutation.isPending || updateMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {(createMutation.isPending || updateMutation.isPending) && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              {editingStakeholder ? "Save Changes" : "Invite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
