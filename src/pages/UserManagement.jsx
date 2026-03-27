import React, { useState, useRef, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";
import { useAuth } from "@/lib/AuthContext";
import { logAudit } from "@/services/audit";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  AlertCircle, X, Loader2, Users, UserX, Info, Building2, Download,
} from "lucide-react";

// ─── Role Definitions ──────────────────────────────────────────────────────
const ROLES = {
  org_admin: {
    label: "Admin",
    badgeClass: "bg-violet-100 text-violet-700",
    description: "Full organization control — settings, users, billing",
    permissions: ["All modules", "User management", "Org settings", "Billing", "Audit log"],
  },
  manager: {
    label: "Manager",
    badgeClass: "bg-blue-100 text-blue-700",
    description: "Properties, leases, tenants, expenses, budget",
    permissions: ["Properties", "Leases", "Tenants", "Expenses", "CAM", "Budget", "Documents"],
  },
  editor: {
    label: "Editor",
    badgeClass: "bg-cyan-100 text-cyan-700",
    description: "Data entry and financial reporting",
    permissions: ["Expenses", "Budget", "Revenue", "Actuals & Variance", "Leases", "Reconciliation"],
  },
  viewer: {
    label: "Viewer",
    badgeClass: "bg-slate-100 text-slate-600",
    description: "Read-only across all assigned properties",
    permissions: ["Dashboard (read)", "Properties (read)", "Leases (read)", "Reports (read)"],
  },
  auditor: {
    label: "Auditor",
    badgeClass: "bg-amber-100 text-amber-700",
    description: "Audit trail access and financial review",
    permissions: ["Audit log", "Reports", "Budget (read)", "Reconciliation"],
  },
};

const ROLE_OPTIONS = [
  { value: "org_admin", label: "Admin" },
  { value: "manager", label: "Manager" },
  { value: "editor", label: "Editor" },
  { value: "viewer", label: "Viewer" },
  { value: "auditor", label: "Auditor" },
];

const STATUS_CONFIG = {
  active: {
    label: "Active",
    badgeClass: "bg-emerald-100 text-emerald-700",
    Icon: CheckCircle2,
  },
  invited: {
    label: "Invited",
    badgeClass: "bg-amber-100 text-amber-700",
    Icon: Mail,
  },
  no_access: {
    label: "No Access",
    badgeClass: "bg-red-100 text-red-600",
    Icon: UserX,
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────
function deriveStatus(m) {
  if (!m.role || m.role === "pending") return "no_access";
  if (m.status === "invited") return "invited";
  return "active";
}

function formatLastActive(d) {
  if (!d) return "Never logged in";
  const days = Math.floor((Date.now() - new Date(d)) / 86400000);
  if (days === 0) return "Active today";
  if (days === 1) return "Active yesterday";
  if (days < 7) return `Active ${days}d ago`;
  if (days < 30) return `Active ${Math.floor(days / 7)}w ago`;
  if (days < 365) return `Active ${Math.floor(days / 30)}mo ago`;
  return `Active ${Math.floor(days / 365)}y ago`;
}

function initials(name, email) {
  if (name) {
    const p = name.trim().split(/\s+/);
    return (p[0][0] + (p[1]?.[0] || "")).toUpperCase();
  }
  return (email?.[0] || "?").toUpperCase();
}

function avatarColor(str = "") {
  const colors = [
    "bg-blue-200 text-blue-800", "bg-violet-200 text-violet-800",
    "bg-emerald-200 text-emerald-800", "bg-amber-200 text-amber-800",
    "bg-rose-200 text-rose-800", "bg-cyan-200 text-cyan-800",
    "bg-indigo-200 text-indigo-800", "bg-orange-200 text-orange-800",
  ];
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
}

// Parse CSV text into [{email, full_name, role}]
function parseCSV(text) {
  const rows = text.trim().split(/\r?\n/).filter(Boolean);
  if (rows.length < 2) return [];
  const headers = rows[0].toLowerCase().split(",").map(h => h.trim());
  const emailIdx = headers.indexOf("email");
  const nameIdx = headers.indexOf("name") !== -1 ? headers.indexOf("name")
    : headers.indexOf("full_name") !== -1 ? headers.indexOf("full_name") : -1;
  const roleIdx = headers.indexOf("role");
  if (emailIdx === -1) return null; // no email column

  return rows.slice(1).map(row => {
    const cols = row.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
    return {
      email: cols[emailIdx] || "",
      full_name: nameIdx !== -1 ? cols[nameIdx] || "" : "",
      role: roleIdx !== -1 ? cols[roleIdx] || "viewer" : "viewer",
    };
  }).filter(r => r.email.includes("@"));
}

// ─── Main Component ────────────────────────────────────────────────────────
export default function UserManagement() {
  const { user: authUser } = useAuth();
  const orgId = authUser?.org_id || null;
  const queryClient = useQueryClient();

  // Filter state
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  // Selection
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Dialogs
  const [inviteOpen, setInviteOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [bulkRoleOpen, setBulkRoleOpen] = useState(false);
  const [bulkRole, setBulkRole] = useState("");

  // Side panel
  const [panelUser, setPanelUser] = useState(null);

  // Inline role update loading state
  const [updatingRole, setUpdatingRole] = useState(new Set());

  // ── Data Fetching ──────────────────────────────────────────────────────
  const { data: members = [], isLoading } = useQuery({
    queryKey: ["team-members", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("memberships")
        .select(`
          id, user_id, org_id, role, status, custom_role, created_at, updated_at,
          profiles:user_id (
            id, email, full_name, status, created_at, updated_at, first_login
          )
        `)
        .eq("org_id", orgId)
        .neq("role", "super_admin")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    refetchOnWindowFocus: false,
  });

  // ── Computed / Filtered ────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return members.filter(m => {
      const p = m.profiles || {};
      const matchSearch = !q
        || p.full_name?.toLowerCase().includes(q)
        || p.email?.toLowerCase().includes(q);
      const matchRole = roleFilter === "all" || m.role === roleFilter;
      const matchStatus = statusFilter === "all" || deriveStatus(m) === statusFilter;
      return matchSearch && matchRole && matchStatus;
    });
  }, [members, search, roleFilter, statusFilter]);

  const stats = useMemo(() => ({
    total: members.length,
    active: members.filter(m => deriveStatus(m) === "active").length,
    invited: members.filter(m => deriveStatus(m) === "invited").length,
    noAccess: members.filter(m => deriveStatus(m) === "no_access").length,
  }), [members]);

  const allSelected = filtered.length > 0 && filtered.every(m => selectedIds.has(m.user_id));

  // ── Selection Handlers ─────────────────────────────────────────────────
  const toggleAll = useCallback((checked) => {
    setSelectedIds(checked ? new Set(filtered.map(m => m.user_id)) : new Set());
  }, [filtered]);

  const toggleOne = useCallback((uid, checked) => {
    setSelectedIds(prev => {
      const n = new Set(prev);
      checked ? n.add(uid) : n.delete(uid);
      return n;
    });
  }, []);

  // ── Mutations ──────────────────────────────────────────────────────────
  const updateRoleMut = useMutation({
    mutationFn: async ({ userId, role }) => {
      const { error } = await supabase
        .from("memberships")
        .update({ role, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("org_id", orgId);
      if (error) throw error;
      await logAudit({ entityType: "Membership", entityId: userId, action: "update",
        fieldChanged: "role", newValue: role, orgId }).catch(() => {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team-members", orgId] });
      toast.success("Role updated");
    },
    onError: (e) => toast.error(e.message || "Failed to update role"),
  });

  const removeUserMut = useMutation({
    mutationFn: async (userId) => {
      const { error } = await supabase
        .from("memberships")
        .delete()
        .eq("user_id", userId)
        .eq("org_id", orgId);
      if (error) throw error;
      await logAudit({ entityType: "Membership", entityId: userId, action: "delete", orgId }).catch(() => {});
    },
    onSuccess: (_, userId) => {
      queryClient.invalidateQueries({ queryKey: ["team-members", orgId] });
      setSelectedIds(prev => { const n = new Set(prev); n.delete(userId); return n; });
      setPanelUser(null);
      toast.success("User removed");
    },
    onError: (e) => toast.error(e.message || "Failed to remove user"),
  });

  const resendInviteMut = useMutation({
    mutationFn: async ({ email, role, full_name }) => {
      const { error } = await supabase.functions.invoke("invite-user", {
        body: { email, role, org_id: orgId, full_name },
      });
      if (error) throw error;
    },
    onSuccess: () => toast.success("Invite resent"),
    onError: (e) => toast.error(e.message || "Failed to resend invite"),
  });

  const bulkRemoveMut = useMutation({
    mutationFn: async (userIds) => {
      const { error } = await supabase
        .from("memberships")
        .delete()
        .in("user_id", userIds)
        .eq("org_id", orgId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team-members", orgId] });
      setSelectedIds(new Set());
      toast.success("Users removed");
    },
    onError: (e) => toast.error(e.message || "Bulk remove failed"),
  });

  const bulkRoleMut = useMutation({
    mutationFn: async ({ userIds, role }) => {
      const { error } = await supabase
        .from("memberships")
        .update({ role, updated_at: new Date().toISOString() })
        .in("user_id", userIds)
        .eq("org_id", orgId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team-members", orgId] });
      setSelectedIds(new Set());
      setBulkRoleOpen(false);
      toast.success("Roles updated");
    },
    onError: (e) => toast.error(e.message || "Bulk role update failed"),
  });

  // ── Inline role update ─────────────────────────────────────────────────
  const handleRoleChange = async (userId, role) => {
    setUpdatingRole(prev => new Set(prev).add(userId));
    try {
      await updateRoleMut.mutateAsync({ userId, role });
    } finally {
      setUpdatingRole(prev => { const n = new Set(prev); n.delete(userId); return n; });
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-5 min-h-screen bg-slate-50">

      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">User Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Manage team members, roles, and access for your organization.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="h-9 gap-1.5 text-sm" onClick={() => setCsvOpen(true)}>
            <Upload className="w-3.5 h-3.5" />
            Upload CSV
          </Button>
          <Button
            className="h-9 bg-[#1a2744] hover:bg-[#243b67] gap-1.5 text-sm shadow-sm"
            onClick={() => setInviteOpen(true)}
          >
            <Plus className="w-3.5 h-3.5" />
            Invite User
          </Button>
        </div>
      </div>

      {/* ── Stats ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "Total Members", value: stats.total, icon: Users, color: "text-slate-600", bg: "bg-slate-100" },
          { label: "Active", value: stats.active, icon: CheckCircle2, color: "text-emerald-600", bg: "bg-emerald-100" },
          { label: "Invited", value: stats.invited, icon: Mail, color: "text-amber-600", bg: "bg-amber-100" },
          { label: "No Access", value: stats.noAccess, icon: UserX, color: "text-red-600", bg: "bg-red-100" },
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <Card key={label} className="shadow-none border border-slate-200">
            <CardContent className="p-4 flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg ${bg} flex items-center justify-center flex-shrink-0`}>
                <Icon className={`w-4 h-4 ${color}`} />
              </div>
              <div>
                <p className="text-2xl font-bold text-slate-900 leading-none">{value}</p>
                <p className="text-[11px] text-slate-500 mt-0.5">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Filter Bar ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            className="pl-9 h-9 text-sm bg-white"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2">
              <X className="w-3.5 h-3.5 text-slate-400 hover:text-slate-600" />
            </button>
          )}
        </div>

        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="w-36 h-9 text-sm bg-white">
            <SelectValue placeholder="All Roles" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            {ROLE_OPTIONS.map(r => (
              <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36 h-9 text-sm bg-white">
            <SelectValue placeholder="All Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="invited">Invited</SelectItem>
            <SelectItem value="no_access">No Access</SelectItem>
          </SelectContent>
        </Select>

        {(search || roleFilter !== "all" || statusFilter !== "all") && (
          <Button
            variant="ghost" size="sm" className="h-9 text-slate-500 hover:text-slate-700"
            onClick={() => { setSearch(""); setRoleFilter("all"); setStatusFilter("all"); }}
          >
            Clear filters
          </Button>
        )}

        <div className="ml-auto text-xs text-slate-500">
          {filtered.length} of {members.length} member{members.length !== 1 ? "s" : ""}
        </div>
      </div>

      {/* ── Bulk Action Bar ──────────────────────────────────────────── */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 bg-[#1a2744] text-white px-4 py-3 rounded-xl">
          <span className="text-sm font-semibold">{selectedIds.size} selected</span>
          <Separator orientation="vertical" className="h-4 bg-white/20" />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-white hover:bg-white/10 text-xs gap-1.5"
            onClick={() => setBulkRoleOpen(true)}
          >
            <Shield className="w-3.5 h-3.5" />
            Assign Role
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-white hover:bg-white/10 text-xs gap-1.5"
            onClick={() => {
              const toResend = members.filter(m => selectedIds.has(m.user_id) && m.status === "invited");
              if (toResend.length === 0) { toast.info("No invited users selected"); return; }
              toResend.forEach(m => resendInviteMut.mutate({
                email: m.profiles?.email,
                role: m.role,
                full_name: m.profiles?.full_name,
              }));
            }}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Resend Invite
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-red-300 hover:bg-red-500/20 hover:text-red-200 text-xs gap-1.5 ml-auto"
            onClick={() => {
              if (!window.confirm(`Remove ${selectedIds.size} user(s)?`)) return;
              bulkRemoveMut.mutate(Array.from(selectedIds));
            }}
          >
            <Trash2 className="w-3.5 h-3.5" />
            Remove {selectedIds.size}
          </Button>
          <Button
            size="sm" variant="ghost"
            className="h-7 text-white/60 hover:text-white hover:bg-white/10 text-xs"
            onClick={() => setSelectedIds(new Set())}
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}

      {/* ── Table ───────────────────────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50 hover:bg-slate-50">
              <TableHead className="w-10 pl-4">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Select all"
                />
              </TableHead>
              <TableHead className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Member
              </TableHead>
              <TableHead className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Role
                <span className="ml-1 inline-flex" title="Hover role badges for permission details">
                  <Info className="w-3 h-3 text-slate-400" />
                </span>
              </TableHead>
              <TableHead className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Scope
              </TableHead>
              <TableHead className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Status
              </TableHead>
              <TableHead className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Last Active
              </TableHead>
              <TableHead className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 text-right pr-4">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="py-20 text-center">
                  <Loader2 className="w-6 h-6 animate-spin text-slate-300 mx-auto mb-2" />
                  <p className="text-sm text-slate-400">Loading team members…</p>
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-20 text-center">
                  <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
                    <Users className="w-6 h-6 text-slate-400" />
                  </div>
                  <p className="text-sm font-medium text-slate-600">
                    {members.length === 0 ? "No team members yet" : "No users match the current filters"}
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    {members.length === 0 ? "Invite your first team member to get started." : "Try clearing your filters."}
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(member => {
                const profile = member.profiles || {};
                const status = deriveStatus(member);
                const statusCfg = STATUS_CONFIG[status];
                const StatusIcon = statusCfg.Icon;
                const roleDef = ROLES[member.role];
                const isSelected = selectedIds.has(member.user_id);
                const isNoAccess = status === "no_access";
                const initStr = initials(profile.full_name, profile.email);
                const avatarCls = avatarColor(profile.email || "");

                return (
                  <TableRow
                    key={member.id}
                    className={`group cursor-pointer transition-colors ${isSelected ? "bg-blue-50/60" : ""} ${isNoAccess ? "bg-red-50/30" : "hover:bg-slate-50"}`}
                    onClick={e => {
                      if (e.target.closest("[data-no-row-click]")) return;
                      setPanelUser(member);
                    }}
                  >
                    {/* Checkbox */}
                    <TableCell className="pl-4" data-no-row-click>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={checked => toggleOne(member.user_id, checked)}
                      />
                    </TableCell>

                    {/* Member */}
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0 ${avatarCls}`}>
                          {initStr}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-slate-800 leading-tight">
                            {profile.full_name || <span className="text-slate-400 font-normal italic">Name not set</span>}
                          </p>
                          <p className="text-xs text-slate-500 leading-tight">{profile.email || "—"}</p>
                        </div>
                        {isNoAccess && (
                          <span className="inline-flex items-center gap-1 bg-red-100 text-red-600 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ml-1">
                            <AlertCircle className="w-3 h-3" />
                            Needs role
                          </span>
                        )}
                      </div>
                    </TableCell>

                    {/* Role — inline editable */}
                    <TableCell data-no-row-click>
                      <div className="flex items-center gap-2">
                        <Select
                          value={member.role || "none"}
                          onValueChange={val => handleRoleChange(member.user_id, val === "none" ? null : val)}
                          disabled={updatingRole.has(member.user_id)}
                        >
                          <SelectTrigger
                            className={`w-32 h-7 text-xs border-transparent shadow-none gap-1 font-medium focus:border-slate-300 hover:border-slate-300 transition-colors ${roleDef ? roleDef.badgeClass : "text-slate-400 bg-slate-50"}`}
                            title={roleDef?.description || "No role assigned"}
                          >
                            {updatingRole.has(member.user_id)
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <SelectValue placeholder="Assign role…" />
                            }
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">
                              <span className="text-slate-400 italic">No role</span>
                            </SelectItem>
                            {ROLE_OPTIONS.map(r => (
                              <SelectItem key={r.value} value={r.value}>
                                <div>
                                  <p className="font-medium">{r.label}</p>
                                  <p className="text-[10px] text-slate-400">{ROLES[r.value]?.description}</p>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </TableCell>

                    {/* Scope */}
                    <TableCell>
                      <div className="flex items-center gap-1.5 text-xs text-slate-500">
                        <Building2 className="w-3.5 h-3.5 text-slate-400" />
                        All Properties
                      </div>
                    </TableCell>

                    {/* Status */}
                    <TableCell>
                      <Badge className={`${statusCfg.badgeClass} border-none text-[11px] font-semibold gap-1`}>
                        <StatusIcon className="w-3 h-3" />
                        {statusCfg.label}
                      </Badge>
                    </TableCell>

                    {/* Last Active */}
                    <TableCell>
                      <span className={`text-xs ${status === "invited" ? "text-amber-500" : "text-slate-500"}`}>
                        {status === "invited"
                          ? "Invite pending"
                          : formatLastActive(profile.updated_at)
                        }
                      </span>
                    </TableCell>

                    {/* Row Actions */}
                    <TableCell className="text-right pr-4" data-no-row-click>
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {status === "invited" && (
                          <Button
                            size="sm" variant="ghost"
                            className="h-7 text-xs text-slate-500 hover:text-blue-600 hover:bg-blue-50"
                            title="Resend invite"
                            onClick={() => resendInviteMut.mutate({
                              email: profile.email,
                              role: member.role,
                              full_name: profile.full_name,
                            })}
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        <Button
                          size="sm" variant="ghost"
                          className="h-7 text-xs text-slate-500 hover:text-blue-600 hover:bg-blue-50 px-2"
                          onClick={() => setPanelUser(member)}
                          title="View details"
                        >
                          View
                        </Button>
                        <Button
                          size="sm" variant="ghost"
                          className="h-7 w-7 p-0 text-slate-400 hover:text-red-600 hover:bg-red-50"
                          title="Remove user"
                          onClick={() => {
                            if (!window.confirm(`Remove ${profile.full_name || profile.email}?`)) return;
                            removeUserMut.mutate(member.user_id);
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── Dialogs ──────────────────────────────────────────────────── */}
      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        orgId={orgId}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ["team-members", orgId] })}
      />

      <CSVUploadDialog
        open={csvOpen}
        onClose={() => setCsvOpen(false)}
        orgId={orgId}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ["team-members", orgId] })}
      />

      <BulkRoleDialog
        open={bulkRoleOpen}
        onClose={() => setBulkRoleOpen(false)}
        count={selectedIds.size}
        onConfirm={role => bulkRoleMut.mutate({ userIds: Array.from(selectedIds), role })}
        loading={bulkRoleMut.isPending}
      />

      {panelUser && (
        <UserDetailPanel
          member={panelUser}
          onClose={() => setPanelUser(null)}
          onRoleChange={handleRoleChange}
          onRemove={uid => { removeUserMut.mutate(uid); setPanelUser(null); }}
          onResendInvite={m => resendInviteMut.mutate({
            email: m.profiles?.email,
            role: m.role,
            full_name: m.profiles?.full_name,
          })}
        />
      )}
    </div>
  );
}

// ─── User Detail Side Panel ────────────────────────────────────────────────
function UserDetailPanel({ member, onClose, onRoleChange, onRemove, onResendInvite }) {
  const profile = member.profiles || {};
  const status = deriveStatus(member);
  const statusCfg = STATUS_CONFIG[status];
  const StatusIcon = statusCfg.Icon;
  const roleDef = ROLES[member.role];
  const initStr = initials(profile.full_name, profile.email);
  const avatarCls = avatarColor(profile.email || "");
  const [localRole, setLocalRole] = useState(member.role || "none");
  const [saving, setSaving] = useState(false);

  const handleSaveRole = async () => {
    if (localRole === (member.role || "none")) return;
    setSaving(true);
    try {
      await onRoleChange(member.user_id, localRole === "none" ? null : localRole);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex" onClick={e => e.target === e.currentTarget && onClose()}>
      {/* Backdrop */}
      <div className="flex-1 bg-black/30 backdrop-blur-[1px]" onClick={onClose} />

      {/* Panel */}
      <div className="w-[400px] bg-white h-full overflow-y-auto shadow-2xl flex flex-col border-l border-slate-200">
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-100 flex items-start justify-between bg-slate-50">
          <div className="flex items-center gap-3">
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-base font-bold ${avatarCls}`}>
              {initStr}
            </div>
            <div>
              <h3 className="font-bold text-slate-900 text-[15px] leading-tight">
                {profile.full_name || <span className="text-slate-400 italic font-normal">Name not set</span>}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">{profile.email}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg hover:bg-slate-200 flex items-center justify-center transition-colors mt-1"
          >
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 p-6 space-y-6 overflow-y-auto">

          {/* Status + Joined */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-slate-50 rounded-xl p-3.5 border border-slate-100">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Status</p>
              <Badge className={`${statusCfg.badgeClass} border-none font-semibold text-xs gap-1`}>
                <StatusIcon className="w-3 h-3" />
                {statusCfg.label}
              </Badge>
            </div>
            <div className="bg-slate-50 rounded-xl p-3.5 border border-slate-100">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Joined</p>
              <p className="text-sm font-semibold text-slate-700">
                {member.created_at ? new Date(member.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
              </p>
            </div>
          </div>

          {/* No access warning */}
          {status === "no_access" && (
            <div className="bg-red-50 border border-red-100 rounded-xl p-4 flex items-start gap-3">
              <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-bold text-red-700">No role assigned</p>
                <p className="text-xs text-red-600 mt-1 leading-relaxed">
                  This user can't access anything until a role is assigned below.
                </p>
              </div>
            </div>
          )}

          {/* Role assignment */}
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Role</p>
            <Select value={localRole} onValueChange={setLocalRole}>
              <SelectTrigger className="h-10 text-sm">
                <SelectValue placeholder="Select a role…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none"><span className="text-slate-400 italic">No role</span></SelectItem>
                {ROLE_OPTIONS.map(r => (
                  <SelectItem key={r.value} value={r.value}>
                    <div>
                      <p className="font-medium">{r.label}</p>
                      <p className="text-[10px] text-slate-400">{ROLES[r.value]?.description}</p>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {localRole !== (member.role || "none") && (
              <Button
                className="w-full mt-2 h-9 bg-[#1a2744] hover:bg-[#243b67] text-sm"
                onClick={handleSaveRole}
                disabled={saving}
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" /> : null}
                Save Role Change
              </Button>
            )}
          </div>

          {/* Permissions */}
          {roleDef && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Access Permissions</p>
              <div className="space-y-2">
                {roleDef.permissions.map(perm => (
                  <div key={perm} className="flex items-center gap-2.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                    <span className="text-sm text-slate-600">{perm}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <Separator />

          {/* Details */}
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Details</p>
            <div className="space-y-3">
              {[
                { label: "Last active", value: formatLastActive(profile.updated_at) },
                { label: "Scope", value: "All Properties" },
                { label: "Membership ID", value: member.id?.slice(0, 8) + "…" },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">{label}</span>
                  <span className="text-xs font-medium text-slate-700 font-mono">{value}</span>
                </div>
              ))}
            </div>
          </div>

          <Separator />

          {/* Actions */}
          <div className="space-y-2">
            {status === "invited" && (
              <Button
                variant="outline" size="sm" className="w-full h-9 text-sm gap-2"
                onClick={() => onResendInvite(member)}
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Resend Invite Email
              </Button>
            )}
            <Button
              variant="outline" size="sm"
              className="w-full h-9 text-sm gap-2 border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300"
              onClick={() => {
                if (!window.confirm(`Remove ${profile.full_name || profile.email} from this organization?`)) return;
                onRemove(member.user_id);
              }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Remove from Organization
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Invite Dialog ─────────────────────────────────────────────────────────
function InviteDialog({ open, onClose, orgId, onSuccess }) {
  const [form, setForm] = useState({ email: "", full_name: "", role: "viewer" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const reset = () => { setForm({ email: "", full_name: "", role: "viewer" }); setError(""); };

  const handleInvite = async () => {
    if (!form.email || !form.email.includes("@")) { setError("Enter a valid email address."); return; }
    if (!form.role) { setError("Select a role."); return; }
    setError("");
    setLoading(true);
    try {
      const { error: fnErr } = await supabase.functions.invoke("invite-user", {
        body: { email: form.email.trim(), full_name: form.full_name.trim(), role: form.role, org_id: orgId },
      });
      if (fnErr) throw new Error(fnErr.message || "Invite failed");
      toast.success(`Invite sent to ${form.email}`);
      onSuccess();
      reset();
      onClose();
    } catch (e) {
      setError(e.message || "Failed to send invite. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) { reset(); onClose(); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-bold">Invite Team Member</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label className="text-xs font-semibold uppercase tracking-wider text-slate-600">
              Email Address <span className="text-red-500">*</span>
            </Label>
            <Input
              type="email"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="colleague@company.com"
              className="mt-1.5 h-10"
              autoFocus
            />
          </div>

          <div>
            <Label className="text-xs font-semibold uppercase tracking-wider text-slate-600">
              Full Name <span className="text-slate-400 font-normal normal-case">(optional)</span>
            </Label>
            <Input
              value={form.full_name}
              onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))}
              placeholder="Jane Smith"
              className="mt-1.5 h-10"
            />
          </div>

          <div>
            <Label className="text-xs font-semibold uppercase tracking-wider text-slate-600">
              Role <span className="text-red-500">*</span>
            </Label>
            <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v }))}>
              <SelectTrigger className="mt-1.5 h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map(r => (
                  <SelectItem key={r.value} value={r.value}>
                    <div>
                      <p className="font-medium">{r.label}</p>
                      <p className="text-[10px] text-slate-400">{ROLES[r.value]?.description}</p>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Role description preview */}
          {form.role && ROLES[form.role] && (
            <div className="bg-slate-50 rounded-xl p-3.5 border border-slate-100">
              <div className="flex items-center gap-2 mb-2">
                <Badge className={`${ROLES[form.role].badgeClass} border-none text-xs font-semibold`}>
                  {ROLES[form.role].label}
                </Badge>
                <span className="text-xs text-slate-500">{ROLES[form.role].description}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {ROLES[form.role].permissions.map(p => (
                  <span key={p} className="inline-flex items-center gap-1 text-[10px] bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded-full">
                    <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500" />
                    {p}
                  </span>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-100 rounded-lg px-3 py-2.5">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
              <p className="text-xs text-red-600">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => { reset(); onClose(); }} disabled={loading}>
            Cancel
          </Button>
          <Button
            className="bg-[#1a2744] hover:bg-[#243b67] gap-2"
            onClick={handleInvite}
            disabled={loading || !form.email}
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
            Send Invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── CSV Upload Dialog ─────────────────────────────────────────────────────
function CSVUploadDialog({ open, onClose, orgId, onSuccess }) {
  const fileRef = useRef(null);
  const [preview, setPreview] = useState(null); // [{email, full_name, role}]
  const [parseError, setParseError] = useState("");
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState(null); // { sent, failed }

  const reset = () => {
    setPreview(null);
    setParseError("");
    setResults(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target.result;
      const rows = parseCSV(text);
      if (rows === null) {
        setParseError("CSV must have an 'email' column. Format: email, name, role");
        setPreview(null);
      } else if (rows.length === 0) {
        setParseError("No valid email addresses found in the CSV.");
        setPreview(null);
      } else {
        setParseError("");
        setPreview(rows);
      }
    };
    reader.readAsText(file);
  };

  const handleBatchInvite = async () => {
    if (!preview || preview.length === 0) return;
    setSending(true);
    let sent = 0;
    let failed = 0;
    for (const row of preview) {
      try {
        const { error } = await supabase.functions.invoke("invite-user", {
          body: {
            email: row.email.trim(),
            full_name: row.full_name.trim() || undefined,
            role: ROLE_OPTIONS.find(r => r.label.toLowerCase() === row.role?.toLowerCase())?.value || "viewer",
            org_id: orgId,
          },
        });
        if (error) throw error;
        sent++;
      } catch {
        failed++;
      }
    }
    setSending(false);
    setResults({ sent, failed });
    if (sent > 0) onSuccess();
  };

  const downloadTemplate = () => {
    const csv = "email,name,role\njohn@example.com,John Smith,viewer\njane@example.com,Jane Doe,manager";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "invite-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) { reset(); onClose(); } }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base font-bold">Bulk Invite via CSV</DialogTitle>
        </DialogHeader>

        {results ? (
          <div className="py-6 text-center space-y-4">
            <div className={`w-16 h-16 rounded-2xl mx-auto flex items-center justify-center ${results.failed === 0 ? "bg-emerald-100" : "bg-amber-100"}`}>
              {results.failed === 0
                ? <CheckCircle2 className="w-8 h-8 text-emerald-600" />
                : <AlertCircle className="w-8 h-8 text-amber-600" />
              }
            </div>
            <div>
              <h3 className="text-lg font-bold text-slate-900">
                {results.sent} invite{results.sent !== 1 ? "s" : ""} sent
              </h3>
              {results.failed > 0 && (
                <p className="text-sm text-amber-600 mt-1">{results.failed} failed — check email validity or existing accounts</p>
              )}
            </div>
            <Button onClick={() => { reset(); onClose(); }} className="bg-[#1a2744] hover:bg-[#243b67]">
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* Template download */}
            <div className="flex items-center justify-between bg-slate-50 rounded-xl p-4 border border-slate-200">
              <div>
                <p className="text-sm font-semibold text-slate-700">CSV Template</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  Required column: <code className="bg-white border border-slate-200 rounded px-1 text-xs">email</code>
                  {" · "}Optional: <code className="bg-white border border-slate-200 rounded px-1 text-xs">name</code>
                  {", "}
                  <code className="bg-white border border-slate-200 rounded px-1 text-xs">role</code>
                </p>
              </div>
              <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={downloadTemplate}>
                <Download className="w-3.5 h-3.5" />
                Template
              </Button>
            </div>

            {/* Drop zone */}
            <div
              className="border-2 border-dashed border-slate-200 rounded-xl p-8 text-center cursor-pointer hover:border-slate-400 hover:bg-slate-50 transition-colors"
              onClick={() => fileRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
            >
              <Upload className="w-8 h-8 text-slate-300 mx-auto mb-3" />
              <p className="text-sm font-medium text-slate-600">Click to upload or drag & drop</p>
              <p className="text-xs text-slate-400 mt-1">CSV files only</p>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={e => handleFile(e.target.files?.[0])}
              />
            </div>

            {parseError && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-100 rounded-lg px-3 py-2.5">
                <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                <p className="text-xs text-red-600">{parseError}</p>
              </div>
            )}

            {/* Preview table */}
            {preview && preview.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-slate-600 mb-2">
                  {preview.length} user{preview.length !== 1 ? "s" : ""} ready to invite
                </p>
                <div className="border border-slate-200 rounded-xl overflow-hidden max-h-48 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold text-slate-500">Email</th>
                        <th className="text-left px-3 py-2 font-semibold text-slate-500">Name</th>
                        <th className="text-left px-3 py-2 font-semibold text-slate-500">Role</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((r, i) => (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="px-3 py-2 text-slate-700">{r.email}</td>
                          <td className="px-3 py-2 text-slate-500">{r.full_name || "—"}</td>
                          <td className="px-3 py-2">
                            <Badge className={`${ROLES[r.role]?.badgeClass || "bg-slate-100 text-slate-500"} border-none text-[10px]`}>
                              {ROLES[r.role]?.label || r.role || "viewer"}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {!results && (
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { reset(); onClose(); }} disabled={sending}>
              Cancel
            </Button>
            <Button
              className="bg-[#1a2744] hover:bg-[#243b67] gap-2"
              onClick={handleBatchInvite}
              disabled={!preview || preview.length === 0 || sending}
            >
              {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
              {sending ? "Sending…" : `Send ${preview?.length || 0} Invite${(preview?.length || 0) !== 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Bulk Role Dialog ──────────────────────────────────────────────────────
function BulkRoleDialog({ open, onClose, count, onConfirm, loading }) {
  const [role, setRole] = useState("");

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) { setRole(""); onClose(); } }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base font-bold">Assign Role to {count} User{count !== 1 ? "s" : ""}</DialogTitle>
        </DialogHeader>
        <div className="py-3 space-y-4">
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger className="h-10">
              <SelectValue placeholder="Select a role…" />
            </SelectTrigger>
            <SelectContent>
              {ROLE_OPTIONS.map(r => (
                <SelectItem key={r.value} value={r.value}>
                  <div>
                    <p className="font-medium">{r.label}</p>
                    <p className="text-[10px] text-slate-400">{ROLES[r.value]?.description}</p>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {role && (
            <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
              <div className="flex flex-wrap gap-1.5">
                {ROLES[role]?.permissions.map(p => (
                  <span key={p} className="inline-flex items-center gap-1 text-[10px] bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded-full">
                    <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500" />
                    {p}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => { setRole(""); onClose(); }} disabled={loading}>Cancel</Button>
          <Button
            className="bg-[#1a2744] hover:bg-[#243b67] gap-2"
            disabled={!role || loading}
            onClick={() => { onConfirm(role); setRole(""); }}
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Shield className="w-3.5 h-3.5" />}
            Apply to {count} User{count !== 1 ? "s" : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
