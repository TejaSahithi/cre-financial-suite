import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";
import { logAudit } from "@/services/audit";
import { useAuth } from "@/lib/AuthContext";
import useOrgId from "@/hooks/useOrgId";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Users, Plus, Loader2, Trash2, Shield, Edit2, Mail } from "lucide-react";
import { toast } from "sonner";

const ROLE_OPTIONS = [
  { value: "viewer",    label: "Viewer",   description: "Read-only access" },
  { value: "editor",    label: "Editor",   description: "Can modify data" },
  { value: "manager",   label: "Manager",  description: "Can manage properties & leases" },
  { value: "org_admin", label: "Admin",    description: "Full organization control" },
];

const roleBadgeColors = {
  org_admin:  "bg-amber-100 text-amber-700",
  manager:    "bg-blue-100 text-blue-700",
  editor:     "bg-emerald-100 text-emerald-700",
  viewer:     "bg-slate-100 text-slate-600",
  super_admin:"bg-purple-100 text-purple-700",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch members for an org by joining memberships + profiles.
 * Returns an array of { id, user_id, email, full_name, role, org_id }.
 */
async function fetchOrgMembers(orgId) {
  if (!orgId || orgId === "__none__") return [];
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("memberships")
    .select("id, user_id, role, org_id, profiles(id, email, full_name, avatar_url)")
    .eq("org_id", orgId);

  if (error) throw error;
  return (data || []).map((m) => ({
    membership_id: m.id,
    id: m.user_id,
    role: m.role,
    org_id: m.org_id,
    email: m.profiles?.email || "—",
    full_name: m.profiles?.full_name || null,
    avatar_url: m.profiles?.avatar_url || null,
  }));
}

/**
 * Call the invite-user Edge Function.
 * Requires valid JWT in the Authorization header (auto-added by Supabase client).
 */
async function callInviteEdgeFunction({ email, full_name, role, org_id }) {
  if (!supabase) throw new Error("Supabase is not configured.");

  const { data, error = null } = await supabase.functions.invoke('invite-user', {
    body: { email, full_name, role, org_id }
  });

  if (error) throw new Error(error.message || "Invite failed");
  return data;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function UserManagement() {
  const { user: currentUser } = useAuth();
  const { orgId } = useOrgId();
  const queryClient = useQueryClient();

  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");
  const [inviteName, setInviteName] = useState("");
  const [inviting, setInviting] = useState(false);

  const [editUser, setEditUser] = useState(null);
  const [editRole, setEditRole] = useState("");
  const [saving, setSaving] = useState(false);

  // ── Fetch org members from memberships table ──────────────────────────────
  const { data: members = [], isLoading } = useQuery({
    queryKey: ["org-members", orgId],
    queryFn: () => fetchOrgMembers(orgId),
    enabled: !!orgId && orgId !== "__none__",
  });

  // ── Invite user via Edge Function ─────────────────────────────────────────
  const handleInvite = async () => {
    if (!inviteEmail || !orgId) return;
    setInviting(true);
    try {
      await callInviteEdgeFunction({
        email: inviteEmail,
        full_name: inviteName || undefined,
        role: inviteRole,
        org_id: orgId,
      });

      // Audit log
      await logAudit({
        entityType: "UserInvite",
        action: "create",
        orgId,
        userId: currentUser?.id,
        userEmail: currentUser?.email,
        newValue: `${inviteEmail} invited as ${inviteRole}`,
      });

      toast.success(`Invitation sent to ${inviteEmail}`);
      setShowInvite(false);
      setInviteEmail("");
      setInviteName("");
      setInviteRole("viewer");
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
    } catch (err) {
      console.error("Invite error:", err);
      toast.error("Failed to send invitation: " + (err.message || "Unknown error"));
    }
    setInviting(false);
  };

  // ── Update role in memberships table ────────────────────────────────────
  const handleUpdateRole = async () => {
    if (!editUser || !editRole) return;
    setSaving(true);
    try {
      if (!supabase) throw new Error("Supabase not configured");

      const oldRole = editUser.role;

      const { error } = await supabase
        .from("memberships")
        .update({ role: editRole })
        .eq("user_id", editUser.id)
        .eq("org_id", orgId);

      if (error) throw error;

      // Audit log
      await logAudit({
        entityType: "Membership",
        entityId: editUser.id,
        action: "update",
        orgId,
        userId: currentUser?.id,
        userEmail: currentUser?.email,
        fieldChanged: "role",
        oldValue: oldRole,
        newValue: editRole,
      });

      toast.success(`Updated ${editUser.full_name || editUser.email} to ${editRole}`);
      setEditUser(null);
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
    } catch (err) {
      console.error("Role update error:", err);
      toast.error("Failed to update role");
    }
    setSaving(false);
  };

  // ── Remove user by deleting the membership record ─────────────────────
  const handleRemove = async (member) => {
    if (!confirm(`Remove ${member.full_name || member.email || "this user"} from the organization?`)) return;
    try {
      if (!supabase) throw new Error("Supabase not configured");

      const { error } = await supabase
        .from("memberships")
        .delete()
        .eq("user_id", member.id)
        .eq("org_id", orgId);

      if (error) throw error;

      // Audit log
      await logAudit({
        entityType: "Membership",
        entityId: member.id,
        action: "delete",
        orgId,
        userId: currentUser?.id,
        userEmail: currentUser?.email,
        oldValue: `${member.email} (${member.role})`,
      });

      toast.success(`Removed ${member.full_name || member.email}`);
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
    } catch (err) {
      console.error("Remove error:", err);
      toast.error("Failed to remove user");
    }
  };

  // ── Access guard ─────────────────────────────────────────────────────────
  const canManage =
    currentUser?.role === "admin" ||
    currentUser?._raw_role === "super_admin" ||
    currentUser?._raw_role === "org_admin" ||
    currentUser?.role === "org_admin";

  if (!canManage) {
    return (
      <div className="p-6">
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
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">User Management</h1>
          <p className="text-sm text-slate-500">{members.length} team member{members.length !== 1 ? "s" : ""}</p>
        </div>
        <Button onClick={() => setShowInvite(true)} className="bg-[#1a2744] hover:bg-[#243b67]">
          <Plus className="w-4 h-4 mr-1" /> Invite User
        </Button>
      </div>

      {/* Members Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className="w-5 h-5 text-slate-500" /> Team Members
          </CardTitle>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <div className="text-center py-12">
              <Users className="w-12 h-12 text-slate-200 mx-auto mb-3" />
              <p className="text-sm text-slate-500">No team members yet</p>
              <p className="text-xs text-slate-400 mt-1">Invite your first team member to get started</p>
            </div>
          ) : (
            <div className="space-y-2">
              {members.map((member) => (
                <div key={member.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-xs font-bold text-white shadow-sm">
                      {(member.full_name || member.email || "?").substring(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{member.full_name || "Unnamed"}</p>
                      <p className="text-xs text-slate-400">{member.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge className={`text-[10px] capitalize ${roleBadgeColors[member.role] || "bg-slate-100 text-slate-600"}`}>
                      {member.role === "super_admin" ? "SuperAdmin" : (member.role || "viewer").replace("_", " ")}
                    </Badge>
                    {/* Don't allow editing yourself or SuperAdmin members */}
                    {member.id !== currentUser?.id && member.role !== "super_admin" && (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setEditUser(member); setEditRole(member.role || "viewer"); }}
                          className="h-8 w-8 p-0 text-slate-400 hover:text-blue-600"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemove(member)}
                          className="h-8 w-8 p-0 text-slate-400 hover:text-red-600"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Role Legend */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="w-4 h-4 text-slate-400" /> Role Permissions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {ROLE_OPTIONS.map((r) => (
              <div key={r.value} className="p-3 rounded-lg border border-slate-200">
                <Badge className={`text-[10px] mb-2 ${roleBadgeColors[r.value] || "bg-slate-100"}`}>
                  {r.label}
                </Badge>
                <p className="text-xs text-slate-500">{r.description}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Invite Dialog */}
      <Dialog open={showInvite} onOpenChange={setShowInvite}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="w-5 h-5" /> Invite Team Member
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Full Name</Label>
              <Input value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Jane Smith" className="mt-1" />
            </div>
            <div>
              <Label>Email Address</Label>
              <Input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="jane@company.com" className="mt-1" />
            </div>
            <div>
              <Label className="text-sm font-semibold text-slate-700">Assign Roles</Label>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {ROLE_OPTIONS.map((r) => (
                  <div
                    key={r.value}
                    onClick={() => setInviteRole(r.value)}
                    className={`p-3 rounded-xl border-2 transition-all cursor-pointer ${
                      inviteRole === r.value
                        ? "border-blue-500 bg-blue-50"
                        : "border-slate-100 bg-white hover:border-slate-200"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-bold uppercase tracking-wider">{r.label}</span>
                      {inviteRole === r.value && <CheckCircle2 className="w-4 h-4 text-blue-600" />}
                    </div>
                    <p className="text-[10px] text-slate-500 leading-tight">{r.description}</p>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-slate-400 mt-2 italic">Note: Multi-role support is being stabilized. Currently selecting the primary role.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInvite(false)}>Cancel</Button>
            <Button onClick={handleInvite} disabled={!inviteEmail || inviting} className="bg-[#1a2744] hover:bg-[#243b67]">
              {inviting && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              Send Invitation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Role Dialog */}
      <Dialog open={!!editUser} onOpenChange={() => setEditUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Role — {editUser?.full_name || editUser?.email}</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label>Role</Label>
            <Select value={editRole} onValueChange={setEditRole}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label} — {r.description}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUser(null)}>Cancel</Button>
            <Button onClick={handleUpdateRole} disabled={saving} className="bg-blue-600 hover:bg-blue-700">
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
