import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { History, ChevronRight } from "lucide-react";

const actionColors = {
  create: "bg-emerald-100 text-emerald-700", update: "bg-blue-100 text-blue-700",
  delete: "bg-red-100 text-red-700", approve: "bg-green-100 text-green-700",
  override: "bg-amber-100 text-amber-700", sign: "bg-indigo-100 text-indigo-700",
  lock: "bg-slate-200 text-slate-700",
};

export default function AuditTrailPanel({ entityType, entityId, maxItems = 8 }) {
  const { data: logs = [] } = useQuery({
    queryKey: ['audit-panel', entityType, entityId],
    queryFn: async () => {
      const allLogs = await auditLogService.list('-created_date', 50);
      return allLogs.filter(l => {
        if (entityId && l.entity_id === entityId) return true;
        if (entityType && l.entity_type === entityType) return true;
        return false;
      });
    },
    enabled: !!(entityType || entityId),
  });

  if (logs.length === 0) return null;

  return (
    <div className="bg-white border border-slate-200 rounded-lg">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100">
        <div className="flex items-center gap-1.5">
          <History className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-xs font-bold text-slate-700">Audit Trail</span>
          <span className="text-[9px] text-slate-400">{logs.length} changes</span>
        </div>
        <Link to={createPageUrl("AuditLog")} className="text-[9px] text-blue-600 font-semibold flex items-center gap-0.5 hover:underline">
          Full log <ChevronRight className="w-2.5 h-2.5" />
        </Link>
      </div>
      <div className="max-h-[250px] overflow-y-auto divide-y divide-slate-50">
        {logs.slice(0, maxItems).map((log, i) => (
          <div key={i} className="px-3 py-2 flex items-start gap-2 text-xs hover:bg-slate-50">
            <Badge className={`${actionColors[log.action] || 'bg-slate-100 text-slate-600'} text-[8px] uppercase px-1 py-0 mt-0.5`}>{log.action}</Badge>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1 flex-wrap">
                <span className="font-medium text-slate-700">{log.field_changed || log.entity_type}</span>
                {log.old_value && log.new_value && (
                  <span className="text-slate-400">
                    <span className="line-through text-red-400">{log.old_value.substring(0, 20)}</span>
                    {' → '}
                    <span className="text-emerald-600 font-medium">{log.new_value.substring(0, 20)}</span>
                  </span>
                )}
              </div>
              <span className="text-[9px] text-slate-400">{log.user_name || log.user_email || 'System'} · {log.created_date ? new Date(log.created_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}