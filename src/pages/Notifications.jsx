import React from "react";
import useOrgQuery from "@/hooks/useOrgQuery";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { notificationService } from "@/services/notificationService";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Bell, AlertTriangle, Clock, CheckCircle2, Info, X, DollarSign } from "lucide-react";

const typeIcons = {
  lease_expiry: AlertTriangle, budget_approval: Clock, cam_variance: AlertTriangle,
  reconciliation_pending: Clock, expense_threshold: DollarSign,
  access_request: Info, cpi_change: Info, system: Info, info: Info,
  warning: AlertTriangle, success: CheckCircle2,
  low_confidence_alert: AlertTriangle, draft_lease_created: Clock
};
const typeColors = {
  lease_expiry: "border-l-red-500 bg-red-50", budget_approval: "border-l-blue-500 bg-blue-50",
  cam_variance: "border-l-amber-500 bg-amber-50", reconciliation_pending: "border-l-slate-400 bg-slate-50",
  expense_threshold: "border-l-orange-500 bg-orange-50",
  system: "border-l-slate-400 bg-slate-50", info: "border-l-blue-500 bg-blue-50",
  warning: "border-l-amber-500 bg-amber-50", success: "border-l-emerald-500 bg-emerald-50",
  low_confidence_alert: "border-l-amber-500 bg-amber-50",
  draft_lease_created: "border-l-blue-500 bg-blue-50"
};

export default function Notifications() {
  const queryClient = useQueryClient();

  const { data: notifications = [], orgId } = useOrgQuery("Notification");

  const unread = notifications.filter(n => !n.is_read).length;
  const warnings = notifications.filter(n => ['warning', 'cam_variance', 'lease_expiry'].includes(n.type)).length;
  const pending = notifications.filter(n => ['budget_approval', 'reconciliation_pending'].includes(n.type) && !n.is_read).length;

  const markRead = useMutation({
    mutationFn: (id) => notificationService.update(id, { is_read: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['Notification', orgId] }),
  });

  const markAllRead = useMutation({
    mutationFn: async () => {
      const unreadItems = notifications.filter(n => !n.is_read);
      for (const n of unreadItems) {
        await notificationService.update(n.id, { is_read: true });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['Notification', orgId] }),
  });

  const deleteNotif = useMutation({
    mutationFn: (id) => notificationService.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['Notification', orgId] }),
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900">Notification Center</h1>
          {unread > 0 && <Badge className="bg-red-100 text-red-700">{unread} unread</Badge>}
        </div>
        <div className="flex gap-2">
          {unread > 0 && (
            <Button variant="outline" size="sm" onClick={() => markAllRead.mutate()} disabled={markAllRead.isPending}>
              Mark All Read
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <Card><CardContent className="p-4"><p className="text-[10px] font-semibold text-slate-500 uppercase">Total</p><p className="text-2xl font-bold">{notifications.length}</p></CardContent></Card>
        <Card className="border-l-4 border-l-red-500"><CardContent className="p-4"><p className="text-[10px] font-semibold text-red-600 uppercase">Unread</p><p className="text-2xl font-bold text-red-600">{unread}</p></CardContent></Card>
        <Card className="border-l-4 border-l-amber-500"><CardContent className="p-4"><p className="text-[10px] font-semibold text-amber-600 uppercase">Warnings</p><p className="text-2xl font-bold">{warnings}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-[10px] font-semibold text-slate-500 uppercase">Pending Action</p><p className="text-2xl font-bold">{pending}</p></CardContent></Card>
      </div>

      {notifications.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Bell className="w-12 h-12 text-slate-200 mx-auto mb-4" />
            <p className="text-lg font-medium text-slate-400">No notifications yet</p>
            <p className="text-sm text-slate-300 mt-1">Notifications will appear automatically when leases expire, budgets are approved, or expenses exceed thresholds.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {notifications.map(n => {
            const Icon = typeIcons[n.type] || Info;
            return (
              <Card key={n.id} className={`border-l-4 ${typeColors[n.type] || 'border-l-slate-300 bg-white'} ${n.is_read ? 'opacity-70' : ''}`}>
                <CardContent className="p-5 flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    <Icon className="w-5 h-5 text-slate-500 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-slate-900">{n.title}</p>
                        {!n.is_read && <div className="w-2 h-2 rounded-full bg-blue-600" />}
                        {n.priority === 'high' && <Badge className="bg-red-100 text-red-600 text-[9px]">HIGH</Badge>}
                      </div>
                      <p className="text-sm text-slate-600 mt-1">{n.message}</p>
                      <p className="text-xs text-slate-400 mt-2">
                        {n.created_at || n.created_date ? new Date(n.created_at || n.created_date).toLocaleString() : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {!n.is_read && (
                      <Button variant="ghost" size="sm" className="text-xs" onClick={() => markRead.mutate(n.id)}>
                        Mark read
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteNotif.mutate(n.id)}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}