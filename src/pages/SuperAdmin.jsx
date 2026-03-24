import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AccessRequestService, OrganizationService } from "@/services/api";
import { useAuth } from "@/lib/AuthContext";
import { supabase } from "@/services/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Shield, Users, Search, Download, CheckCircle2, X, Loader2, Package, Trash2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { ALL_MODULE_KEYS, MODULE_DEFINITIONS } from "@/lib/moduleConfig";

export default function SuperAdmin() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [selectedModules, setSelectedModules] = useState([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [processingRequests, setProcessingRequests] = useState(new Set());
  const [selectedRequests, setSelectedRequests] = useState(new Set());
  const [inviting, setInviting] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState(false);
  
  // Platform Admin Invite State
  const [showPlatformInviteModal, setShowPlatformInviteModal] = useState(false);
  const [platformInviteEmail, setPlatformInviteEmail] = useState("");
  const [platformInviting, setPlatformInviting] = useState(false);
  
  const [editingOrgModules, setEditingOrgModules] = useState(null);
  const authChecked = !!user || true;

  const { data: platformAdmins = [], isLoading: isLoadingAdmins } = useQuery({
    queryKey: ['platform-admins'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("memberships")
        .select("id, user_id, role, profiles(id, email, full_name)")
        .eq("role", "super_admin");
      if (error) throw error;
      return (data || []).map(m => ({
        membership_id: m.id,
        user_id: m.user_id,
        email: m.profiles?.email || "—",
        full_name: m.profiles?.full_name || "—",
        role: "super_admin"
      }));
    },
    enabled: authChecked,
  });

  const handleInvitePlatformAdmin = async () => {
    if (!platformInviteEmail) return;
    setPlatformInviting(true);
    try {
      const { data: result, error: fnError } = await supabase.functions.invoke('invite-user', {
        body: { email: platformInviteEmail, role: "super_admin", onboarding_type: "invited" }
      });

      if (fnError) throw new Error(fnError.message || "invite-user failed");
      
      const { toast } = await import("sonner");
      toast.success("Platform admin invited successfully!");
      setShowPlatformInviteModal(false);
      setPlatformInviteEmail("");
      queryClient.invalidateQueries({ queryKey: ['platform-admins'] });
    } catch(e) {
      console.error('Invite error:', e);
      const { toast } = await import("sonner");
      toast.error(e.message || "Failed to invite platform admin");
    }
    setPlatformInviting(false);
  };

  const handleInviteClient = async () => {
    if (!inviteEmail) return;
    setInviting(true);
    try {
      const { data: result, error: fnError } = await supabase.functions.invoke('invite-client', {
        body: { 
          email: inviteEmail, 
          role: "org_admin", 
          onboarding_type: "owner" // Important: owners go through onboarding
        }
      });
      
      if (fnError) throw new Error(fnError.message || "Failed to send invitation");
      setInviteSuccess(true);
    } catch(e) { 
      console.error('Invite error:', e);
      const { toast } = await import("sonner");
      toast.error(e.message || "Failed to send invitation");
    }
    setInviting(false);
  };

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ['access-requests'],
    queryFn: () => AccessRequestService.list('-created_at'),
    enabled: authChecked && user?.role === 'admin',
  });

  const { data: orgs = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => OrganizationService.list(),
    enabled: authChecked && user?.role === 'admin',
  });

  const updateRequest = useMutation({
    mutationFn: async ({ id, approved }) => {
      const { data: result, error: fnError } = await supabase.functions.invoke('approve-request', {
        body: { id, approved }
      });
      if (fnError) throw new Error(fnError.message || 'Action failed');
      return result;
    },
    onMutate: ({ id }) => {
      setProcessingRequests(prev => new Set(prev).add(id));
    },
    onSettled: (data, error, { id }) => {
      setProcessingRequests(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (error) {
        import('sonner').then(({ toast }) => toast.error(error.message || 'Action failed'));
      }
      queryClient.invalidateQueries({ queryKey: ['access-requests'] });
    },
  });

  // Revoke action: sets approved user back to pending_approval
  const revokeRequest = useMutation({
    mutationFn: async ({ id, email }) => {
      // Update access_request status
      const { error: reqError } = await supabase
        .from('access_requests')
        .update({ status: 'pending_approval', updated_at: new Date().toISOString() })
        .eq('id', id);
      if (reqError) throw reqError;

      // Also revert the profile status if they have one
      if (email) {
        const { error: profError } = await supabase
          .from('profiles')
          .update({ status: 'pending_approval' })
          .eq('email', email);
        if (profError) console.warn('[Revoke] Profile update warning:', profError.message);
      }

      return { id };
    },
    onMutate: ({ id }) => {
      setProcessingRequests(prev => new Set(prev).add(id));
    },
    onSettled: (data, error, { id }) => {
      setProcessingRequests(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (error) {
        import('sonner').then(({ toast }) => toast.error(error.message || 'Revoke failed'));
      } else {
        import('sonner').then(({ toast }) => toast.success('Access revoked. User must be re-approved.'));
      }
      queryClient.invalidateQueries({ queryKey: ['access-requests'] });
    },
  });

  const deleteRequest = useMutation({
    mutationFn: async (id) => {
      const success = await AccessRequestService.delete(id);
      if (!success) throw new Error('Deletion failed');
      return id;
    },
    onMutate: (id) => {
      setProcessingRequests(prev => new Set(prev).add(id));
    },
    onSettled: (data, error, id) => {
      setProcessingRequests(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (error) {
        import('sonner').then(({ toast }) => toast.error(error.message || 'Failed to delete request'));
      } else {
        import('sonner').then(({ toast }) => toast.success('Request deleted permanently'));
      }
      queryClient.invalidateQueries({ queryKey: ['access-requests'] });
    },
  });

  const handleBulkDelete = () => {
    if (selectedRequests.size === 0) return;
    if (window.confirm(`Are you sure you want to delete ${selectedRequests.size} requests?`)) {
      setProcessingRequests(prev => new Set([...prev, ...selectedRequests]));
      Promise.all(Array.from(selectedRequests).map(id => AccessRequestService.delete(id)))
        .then(() => {
          import('sonner').then(({ toast }) => toast.success(`Deleted ${selectedRequests.size} requests`));
          setSelectedRequests(new Set());
          queryClient.invalidateQueries({ queryKey: ['access-requests'] });
        })
        .catch(() => {
          import('sonner').then(({ toast }) => toast.error('Failed to delete some requests'));
        })
        .finally(() => {
          setProcessingRequests(prev => {
            const next = new Set(prev);
            selectedRequests.forEach(id => next.delete(id));
            return next;
          });
        });
    }
  };

  const toggleSelectAll = (checked) => {
    if (checked) {
      setSelectedRequests(new Set(requests.map(r => r.id)));
    } else {
      setSelectedRequests(new Set());
    }
  };

  const toggleSelect = (id, checked) => {
    setSelectedRequests(prev => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const pendingCount = requests.filter(r => r.status === 'pending_approval').length;

  if (!authChecked) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!user || user.role !== "admin") {
    return (
      <div className="flex flex-col items-center justify-center h-96 text-center px-4">
        <div className="w-16 h-16 bg-red-100 rounded-2xl flex items-center justify-center mb-4">
          <Shield className="w-8 h-8 text-red-500" />
        </div>
        <h2 className="text-2xl font-bold text-slate-900 mb-2">Access Denied</h2>
        <p className="text-slate-500 max-w-md">The SuperAdmin Console is restricted to platform administrators only. If you believe this is an error, contact your system administrator.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center"><Shield className="w-5 h-5 text-amber-600" /></div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-slate-900">SuperAdmin Console</h1>
              {pendingCount > 0 && <Badge className="bg-amber-100 text-amber-700">{pendingCount} pending approval</Badge>}
            </div>
            <p className="text-sm text-slate-500">Platform-wide management · CRE Platform v2.4.1 · All organizations</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => { setShowInviteModal(true); setInviteEmail(""); setInviteSuccess(false); }}><Users className="w-4 h-4 mr-2" />Invite Client</Button>
          <Button variant="outline">Settings</Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <Card><CardContent className="p-4"><p className="text-[10px] font-semibold text-slate-500 uppercase">Total Organizations</p><p className="text-2xl font-bold">{orgs.length}</p><p className="text-[10px] text-emerald-500">+3 this month</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-[10px] font-semibold text-slate-500 uppercase">Demo Requests</p><p className="text-2xl font-bold">{requests.filter(r => r.request_type === 'demo').length}</p><p className="text-[10px] text-violet-500">{requests.filter(r => r.request_type === 'demo' && r.demo_viewed).length} viewed</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-[10px] font-semibold text-slate-500 uppercase">MRR</p><p className="text-2xl font-bold">$124,800</p><p className="text-[10px] text-emerald-500">+8.2% MoM</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-[10px] font-semibold text-slate-500 uppercase">Pending Approvals</p><p className="text-2xl font-bold">{pendingCount}</p><p className="text-[10px] text-slate-400">Requires review</p></CardContent></Card>
      </div>

      <Tabs defaultValue="requests">
        <TabsList>
          <TabsTrigger value="requests">Access Requests {pendingCount > 0 && <Badge className="ml-1.5 bg-amber-500 text-white text-[10px] px-1.5">{pendingCount}</Badge>}</TabsTrigger>
          <TabsTrigger value="users">User Management</TabsTrigger>
          <TabsTrigger value="orgs">Organizations</TabsTrigger>
        </TabsList>

        <TabsContent value="requests" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base">Access Request Queue</CardTitle>
                <p className="text-xs text-slate-400">{pendingCount} pending</p>
              </div>
              <div className="flex gap-2">
                {selectedRequests.size > 0 && (
                  <Button variant="destructive" size="sm" onClick={handleBulkDelete}>
                    <Trash2 className="w-4 h-4 mr-1" />
                    Delete Selected ({selectedRequests.size})
                  </Button>
                )}
                <div className="relative"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" /><Input placeholder="Search requests..." className="pl-9 w-48 h-8" /></div>
                <Button variant="outline" size="sm"><Download className="w-4 h-4 mr-1" />Export</Button>
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50">
                    <TableHead className="w-10">
                      <Checkbox 
                        checked={requests.length > 0 && selectedRequests.size === requests.length}
                        onCheckedChange={toggleSelectAll}
                      />
                    </TableHead>
                    <TableHead className="text-[11px]">APPLICANT</TableHead>
                    <TableHead className="text-[11px]">COMPANY</TableHead>
                    <TableHead className="text-[11px]">PHONE</TableHead>
                    <TableHead className="text-[11px]">PORTFOLIOS</TableHead>
                    <TableHead className="text-[11px]">PLAN</TableHead>
                    <TableHead className="text-[11px]">TYPE</TableHead>
                    <TableHead className="text-[11px]">DEMO VIEWED</TableHead>
                    <TableHead className="text-[11px]">SUBMITTED</TableHead>
                    <TableHead className="text-[11px]">STATUS</TableHead>
                    <TableHead className="text-[11px]">ACTIONS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow><TableCell colSpan={10} className="text-center py-8"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></TableCell></TableRow>
                  ) : requests.length === 0 ? (
                    <TableRow><TableCell colSpan={10} className="text-center py-8 text-slate-400">No access requests</TableCell></TableRow>
                  ) : (
                    requests.map(r => (
                      <TableRow key={r.id}>
                        <TableCell>
                          <Checkbox 
                            checked={selectedRequests.has(r.id)}
                            onCheckedChange={(c) => toggleSelect(r.id, c)}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-xs font-bold">{r.full_name?.substring(0, 2).toUpperCase()}</div>
                            <div><p className="text-sm font-medium">{r.full_name}</p><p className="text-xs text-slate-400">{r.email}</p></div>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{r.company_name}</TableCell>
                        <TableCell className="text-sm text-slate-500">{r.phone || '—'}</TableCell>
                        <TableCell className="text-sm">{r.portfolios || r.properties_count || '—'}</TableCell>
                        <TableCell className="text-sm">{r.plan ? <Badge variant="outline" className="text-[10px] capitalize">{r.plan}</Badge> : '—'}</TableCell>
                        <TableCell>
                          {r.request_type === 'demo'
                            ? <Badge className="bg-violet-100 text-violet-700 text-[10px] border-none">🎥 DEMO</Badge>
                            : <Badge variant="outline" className="text-[10px] capitalize">ACCESS</Badge>
                          }
                        </TableCell>
                        <TableCell className="text-sm">
                          {r.request_type === 'demo' ? (
                            r.demo_viewed ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : <span className="text-slate-300">—</span>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-slate-500">
                          {r.created_at ? new Date(r.created_at).toLocaleString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
                          }) : '—'}
                        </TableCell>
                        <TableCell><Badge className={r.status === 'pending_approval' ? 'bg-amber-100 text-amber-700' : r.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}>{r.status?.toUpperCase()}</Badge></TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {r.status !== 'approved' && (
                              <Button 
                                size="sm" 
                                className="text-xs h-7 bg-emerald-600 hover:bg-emerald-700 text-white border-none"
                                disabled={processingRequests.has(r.id)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  console.log('Approve clicked for:', r.id);
                                  updateRequest.mutate({ id: r.id, approved: true });
                                }}>
                                {processingRequests.has(r.id) ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
                                Approve
                              </Button>
                            )}
                            {r.status !== 'rejected' && r.status !== 'approved' && (
                              <Button 
                                size="sm" 
                                variant="outline"
                                className="text-xs h-7 text-red-600 border-red-200 hover:bg-red-50"
                                disabled={processingRequests.has(r.id)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  updateRequest.mutate({ id: r.id, approved: false });
                                }}>
                                {processingRequests.has(r.id) ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <X className="w-3 h-3 mr-1" />}
                                Reject
                              </Button>
                            )}
                            {r.status === 'approved' && (
                              <Button 
                                size="sm" 
                                variant="outline"
                                className="text-xs h-7 text-amber-600 border-amber-200 hover:bg-amber-50"
                                disabled={processingRequests.has(r.id)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  revokeRequest.mutate({ id: r.id, email: r.email });
                                }}>
                                {processingRequests.has(r.id) ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Shield className="w-3 h-3 mr-1" />}
                                Revoke
                              </Button>
                            )}
                            <Button 
                              size="sm" 
                              variant="ghost"
                              className="text-xs h-7 px-2 text-slate-400 hover:text-red-600 hover:bg-red-50 ml-1"
                              disabled={processingRequests.has(r.id)}
                              onClick={() => {
                                if (window.confirm("Are you sure you want to permanently delete this request?")) {
                                  deleteRequest.mutate(r.id);
                                }
                              }}>
                              {processingRequests.has(r.id) ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="users" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <div>
                <CardTitle className="text-base">Platform Administrators</CardTitle>
                <p className="text-xs text-slate-400">Manage users with full administrative access to the platform.</p>
              </div>
              <Button onClick={() => setShowPlatformInviteModal(true)} size="sm" className="bg-blue-600 hover:bg-blue-700 h-8 text-xs">
                <Shield className="w-3 h-3 mr-2" /> Invite Admin
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50">
                    <TableHead className="text-[11px]">NAME</TableHead>
                    <TableHead className="text-[11px]">EMAIL</TableHead>
                    <TableHead className="text-[11px]">ROLE</TableHead>
                    <TableHead className="text-[11px]">ACTIONS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoadingAdmins ? (
                    <TableRow><TableCell colSpan={4} className="text-center py-8"><Loader2 className="w-5 h-5 animate-spin mx-auto text-slate-400" /></TableCell></TableRow>
                  ) : platformAdmins.length === 0 ? (
                    <TableRow><TableCell colSpan={4} className="text-center py-8 text-sm text-slate-400">No platform admins found</TableCell></TableRow>
                  ) : platformAdmins.map(admin => (
                    <TableRow key={admin.membership_id}>
                      <TableCell className="font-medium text-sm">{admin.full_name}</TableCell>
                      <TableCell className="text-sm text-slate-500">{admin.email}</TableCell>
                      <TableCell>
                        <Badge className="bg-purple-100 text-purple-700 hover:bg-purple-100 border-none text-[10px]">Super Admin</Badge>
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-red-50" disabled={admin.user_id === user.id} onClick={async () => {
                          if (!window.confirm(`Remove ${admin.email} from platform admins?`)) return;
                          try {
                            await supabase.from("memberships").delete().eq("id", admin.membership_id);
                            queryClient.invalidateQueries({ queryKey: ['platform-admins'] });
                            const { toast } = await import("sonner");
                            toast.success("Admin removed");
                          } catch (e) { console.error(e); }
                        }}>
                          <X className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="orgs" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Organizations & Module Access</CardTitle>
              <p className="text-xs text-slate-400">Configure which modules each organization can access. Empty = all modules (admin/legacy).</p>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50">
                    <TableHead className="text-[11px]">ORGANIZATION</TableHead>
                    <TableHead className="text-[11px]">PLAN</TableHead>
                    <TableHead className="text-[11px]">STATUS</TableHead>
                    <TableHead className="text-[11px]">ENABLED MODULES</TableHead>
                    <TableHead className="text-[11px]">ACTIONS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orgs.length === 0 ? (
                    <TableRow><TableCell colSpan={5} className="text-center py-8 text-sm text-slate-400">No organizations</TableCell></TableRow>
                  ) : orgs.map(org => (
                    <TableRow key={org.id}>
                      <TableCell>
                        <div><p className="text-sm font-medium">{org.name}</p><p className="text-[10px] text-slate-400">{org.primary_contact_email}</p></div>
                      </TableCell>
                      <TableCell><Badge variant="outline" className="text-[10px] capitalize">{org.plan}</Badge></TableCell>
                      <TableCell><Badge className={`text-[9px] uppercase ${org.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{org.status}</Badge></TableCell>
                      <TableCell>
                        {org.enabled_modules?.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {org.enabled_modules.slice(0, 4).map(m => (
                              <Badge key={m} variant="outline" className="text-[9px]">{MODULE_DEFINITIONS[m]?.label || m}</Badge>
                            ))}
                            {org.enabled_modules.length > 4 && <Badge variant="outline" className="text-[9px]">+{org.enabled_modules.length - 4}</Badge>}
                          </div>
                        ) : (
                          <span className="text-[10px] text-slate-400">All modules (unrestricted)</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {org.status === 'pending_approval' && (
                            <Button 
                              variant="outline" 
                              size="sm" 
                              className="h-7 text-[10px] px-2 text-emerald-600 border-emerald-200 hover:bg-emerald-50"
                              disabled={processingRequests.has(`org_${org.id}`)}
                              onClick={async () => {
                                setProcessingRequests(prev => new Set(prev).add(`org_${org.id}`));
                                try {
                                  const { data: result, error: fnError } = await supabase.functions.invoke('approve-organization', {
                                    body: { orgId: org.id }
                                  });
                                  if (fnError) throw new Error(fnError.message || 'Failed to approve organization');

                                  queryClient.invalidateQueries({ queryKey: ['organizations'] });
                                  const { toast } = await import("sonner");
                                  toast.success("Organization approved successfully!");
                                } catch (e) {
                                  console.error(e);
                                  const { toast } = await import("sonner");
                                  toast.error(e.message || "Failed to approve organization");
                                } finally {
                                  setProcessingRequests(prev => {
                                    const next = new Set(prev);
                                    next.delete(`org_${org.id}`);
                                    return next;
                                  });
                                }
                              }}
                            >
                              {processingRequests.has(`org_${org.id}`) ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
                              Approve
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" className="h-7 text-[10px] px-2" onClick={() => { setEditingOrgModules(org); setSelectedModules(org.enabled_modules || []); }}>
                            <Package className="w-3 h-3 mr-1" /> Modules
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Module Configuration Dialog */}
      <Dialog open={!!editingOrgModules} onOpenChange={() => setEditingOrgModules(null)}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Configure Modules — {editingOrgModules?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <div className="flex justify-between items-center mb-3">
              <p className="text-xs text-slate-500">{selectedModules.length === 0 ? 'Unrestricted (all modules)' : `${selectedModules.length} modules enabled`}</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="text-[10px] h-6" onClick={() => setSelectedModules([...ALL_MODULE_KEYS])}>Select All</Button>
                <Button variant="outline" size="sm" className="text-[10px] h-6" onClick={() => setSelectedModules([])}>Clear All</Button>
              </div>
            </div>
            {ALL_MODULE_KEYS.map(key => {
              const mod = MODULE_DEFINITIONS[key];
              const checked = selectedModules.includes(key);
              return (
                <div key={key} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-50 border border-transparent hover:border-slate-200">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(val) => {
                      if (val) setSelectedModules(prev => [...prev, key]);
                      else setSelectedModules(prev => prev.filter(m => m !== key));
                    }}
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{mod.label}</p>
                    <p className="text-[10px] text-slate-400">{mod.pages.join(', ')}</p>
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingOrgModules(null)}>Cancel</Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700"
              onClick={async () => {
                await OrganizationService.update(editingOrgModules.id, { enabled_modules: selectedModules });
                queryClient.invalidateQueries({ queryKey: ['organizations'] });
                setEditingOrgModules(null);
              }}
            >
              Save Modules
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showInviteModal} onOpenChange={setShowInviteModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite Client</DialogTitle>
          </DialogHeader>
          {inviteSuccess ? (
            <div className="text-center py-4">
              <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
              <p className="font-semibold text-slate-900">Invitation Sent!</p>
              <p className="text-sm text-slate-500 mt-1">An invitation email has been sent to <strong>{inviteEmail}</strong>.</p>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <div>
                <Label className="text-sm font-semibold text-slate-700">Client Email Address</Label>
                <Input
                  type="email"
                  placeholder="client@company.com"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  className="mt-1"
                />
              </div>
              <p className="text-xs text-slate-400">The client will receive an invitation to sign in and complete onboarding.</p>
            </div>
          )}
          <DialogFooter>
            {inviteSuccess ? (
              <Button onClick={() => setShowInviteModal(false)}>Close</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setShowInviteModal(false)}>Cancel</Button>
                <Button onClick={handleInviteClient} disabled={inviting || !inviteEmail} className="bg-blue-600 hover:bg-blue-700">
                  {inviting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Send Invitation
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPlatformInviteModal} onOpenChange={setShowPlatformInviteModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite Platform Administrator</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-sm font-semibold text-slate-700">Email Address</Label>
              <Input
                type="email"
                placeholder="admin@cresuite.io"
                value={platformInviteEmail}
                onChange={e => setPlatformInviteEmail(e.target.value)}
                className="mt-1"
              />
            </div>
            <p className="text-xs text-amber-600 font-medium">
              Warning: This user will have unrestricted access to all organizations, users, and platform settings.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPlatformInviteModal(false)}>Cancel</Button>
            <Button onClick={handleInvitePlatformAdmin} disabled={platformInviting || !platformInviteEmail} className="bg-blue-600 hover:bg-blue-700">
              {platformInviting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Invite Admin
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}