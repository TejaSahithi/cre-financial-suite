import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AuditLogService } from "@/services/api";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { ChevronRight, Activity } from "lucide-react";

const actionColors = { create: "bg-emerald-500", update: "bg-blue-500", delete: "bg-red-500", approve: "bg-violet-500", upload: "bg-amber-500", override: "bg-orange-500", sign: "bg-teal-500", lock: "bg-slate-600", reject: "bg-rose-500", login: "bg-cyan-500", export: "bg-indigo-500" };

export default function ActivityFeed() {
  const { data: logs = [] } = useQuery({
    queryKey: ['audit-logs-dash'],
    queryFn: () => AuditLogService.list('-created_date', 12),
  });

  const formatTime = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 172800) return 'Yesterday';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-1 pt-3 px-4 flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-sm font-bold text-slate-900">Audit Trail</CardTitle>
          <p className="text-xs text-slate-500">{logs.length} recent actions · Full compliance log</p>
        </div>
        <Link to={createPageUrl("AuditLog")} className="text-xs text-blue-600 font-semibold flex items-center gap-0.5 hover:underline">
          Full log <ChevronRight className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-1">
        {logs.length > 0 ? (
          <div className="space-y-0 max-h-[280px] overflow-y-auto">
            {logs.map((log, i) => (
              <div key={i} className="flex gap-2 py-1.5 border-b border-slate-50 last:border-0">
                <div className="flex flex-col items-center pt-1">
                  <div className={`w-1.5 h-1.5 rounded-full ${actionColors[log.action] || 'bg-slate-400'}`} />
                  {i < logs.length - 1 && <div className="w-px flex-1 bg-slate-100 mt-0.5" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-bold text-slate-700 capitalize">{log.action}</span>
                    <span className="text-xs text-slate-400">{log.entity_type}</span>
                    <span className="text-xs text-slate-300 ml-auto flex-shrink-0">{formatTime(log.created_date || log.timestamp)}</span>
                  </div>
                  <p className="text-xs text-slate-500 truncate">
                    {log.user_name || log.user_email || 'System'}
                    {log.property_name && ` · ${log.property_name}`}
                    {log.field_changed && ` · ${log.field_changed}`}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center py-6 text-xs text-slate-400">
            <Activity className="w-4 h-4 mr-2 text-slate-300" /> No activity yet
          </div>
        )}
      </CardContent>
    </Card>
  );
}