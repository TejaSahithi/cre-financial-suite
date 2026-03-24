import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "react-router-dom";
import { ArrowRight, Clock } from "lucide-react";
import { AuditLogService } from "@/services/api";
import { useQuery } from "@tanstack/react-query";

export default function RecentActivity() {
  const { data: logs = [] } = useQuery({
    queryKey: ['recent-audit-logs'],
    queryFn: () => AuditLogService.list('-created_date', 8),
  });

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-base font-bold">Recent Activity</CardTitle>
        <Link to="/AuditLog" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
          Full Log <ArrowRight className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardContent>
        {logs.length > 0 ? (
          <div className="max-h-[320px] overflow-y-auto pr-1">
            {logs.map((log, i) => (
              <div key={i} className="flex items-start gap-3 py-3 border-b border-slate-100 last:border-0">
                <div className="w-7 h-7 rounded-full bg-blue-500 flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0 mt-0.5">
                  {(log.user_name || log.user_email || '?').substring(0, 1).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-700">
                    <span className="font-semibold">{log.user_name || log.user_email || 'System'}</span>{" "}
                    <span className="text-slate-500">{log.action} {log.entity_type}</span>
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">{log.created_date ? new Date(log.created_date).toLocaleDateString() : ''}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Clock className="w-10 h-10 text-slate-200 mb-3" />
            <p className="text-sm font-medium text-slate-400">No recent activity</p>
            <p className="text-xs text-slate-300 mt-1">Actions will appear here as you use the platform</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}