import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bell, AlertTriangle, CheckCircle2, Info, Clock } from "lucide-react";
import { notificationService } from "@/services/notificationService";
import { useQuery } from "@tanstack/react-query";

const iconMap = {
  lease_expiry: AlertTriangle,
  budget_approval: Info,
  cam_variance: AlertTriangle,
  reconciliation_pending: Clock,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle2,
  system: Info,
};

const colorMap = {
  high: { border: "border-l-red-500", bg: "bg-red-50", icon: "text-red-500" },
  medium: { border: "border-l-amber-500", bg: "bg-amber-50", icon: "text-amber-500" },
  low: { border: "border-l-slate-300", bg: "bg-slate-50", icon: "text-slate-400" },
};

export default function AlertsNotifications() {
  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications-recent'],
    queryFn: () => notificationService.list('-created_date', 6),
  });

  const unreadCount = notifications.filter(n => !n.is_read).length;

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-base font-bold">Alerts & Notifications</CardTitle>
        {unreadCount > 0 && <Badge className="bg-red-100 text-red-600 text-[10px] font-semibold">{unreadCount} new</Badge>}
      </CardHeader>
      <CardContent>
        {notifications.length > 0 ? (
          <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
            {notifications.map((n, i) => {
              const colors = colorMap[n.priority] || colorMap.low;
              const Icon = iconMap[n.type] || Info;
              return (
                <div key={i} className={`border-l-4 ${colors.border} ${colors.bg} rounded-r-lg p-3 flex items-start gap-2.5`}>
                  <Icon className={`w-4 h-4 ${colors.icon} flex-shrink-0 mt-0.5`} />
                  <div>
                    <p className="text-sm text-slate-700">{n.message || n.title}</p>
                    <p className="text-xs text-slate-400 mt-1">{n.created_date ? new Date(n.created_date).toLocaleDateString() : ''}</p>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Bell className="w-10 h-10 text-slate-200 mb-3" />
            <p className="text-sm font-medium text-slate-400">No notifications yet</p>
            <p className="text-xs text-slate-300 mt-1">Alerts will appear here for lease expirations, budget approvals, and more</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}