import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { notificationService } from "@/services/notificationService";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Bell, AlertTriangle, Info, CheckCircle2, Clock, ChevronRight, ShieldAlert } from "lucide-react";

const iconMap = { lease_expiry: AlertTriangle, budget_approval: Info, cam_variance: ShieldAlert, reconciliation_pending: Clock, warning: AlertTriangle, info: Info, success: CheckCircle2, system: Info };
const priorityStyles = { high: "border-l-red-500 bg-red-50/40", medium: "border-l-amber-500 bg-amber-50/40", low: "border-l-slate-300 bg-slate-50/40" };
const iconColors = { high: "text-red-500", medium: "text-amber-500", low: "text-slate-400" };

export default function AlertsPanel() {
  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications-dashboard'],
    queryFn: () => notificationService.list('-created_date', 10),
  });
  const unread = notifications.filter(n => !n.is_read).length;
  const highCount = notifications.filter(n => n.priority === 'high' && !n.is_read).length;

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-1 pt-3 px-4 flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-sm font-bold text-slate-900">Alerts</CardTitle>
          <p className="text-xs text-slate-500">
            {unread > 0 ? <>{unread} unread{highCount > 0 && <span className="text-red-600 font-bold"> · {highCount} critical</span>}</> : 'No pending alerts'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {unread > 0 && <Badge className="bg-red-500 text-white text-xs font-bold px-1.5">{unread}</Badge>}
          <Link to={createPageUrl("Notifications")} className="text-xs text-blue-600 font-semibold flex items-center gap-0.5 hover:underline">
            All <ChevronRight className="w-3 h-3" />
          </Link>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-1">
        {notifications.length > 0 ? (
          <div className="space-y-1 max-h-[280px] overflow-y-auto">
            {notifications.map((n, i) => {
              const Icon = iconMap[n.type] || Info;
              return (
                <div key={i} className={`border-l-[3px] ${priorityStyles[n.priority] || priorityStyles.low} rounded-r-md px-2.5 py-2 flex items-start gap-2 hover:bg-white transition-colors cursor-pointer`}>
                  <Icon className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${iconColors[n.priority] || iconColors.low}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-700 font-medium leading-snug">{n.title || n.message}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{n.created_date ? new Date(n.created_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</p>
                  </div>
                  {!n.is_read && <div className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0 mt-1" />}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex items-center justify-center py-6 text-xs text-slate-400">
            <Bell className="w-4 h-4 mr-2 text-slate-300" /> No notifications yet
          </div>
        )}
      </CardContent>
    </Card>
  );
}