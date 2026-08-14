import { Badge } from "@/components/ui/badge";

export default function ManagerAssignmentBadges({ managers = [], emptyLabel = "Unassigned", limit = 2 }) {
  if (!managers.length) {
    return <span className="text-xs font-medium text-slate-400">{emptyLabel}</span>;
  }

  const visibleManagers = managers.slice(0, limit);
  const extraCount = managers.length - visibleManagers.length;

  return (
    <div className="flex max-w-full flex-wrap items-center gap-1.5">
      {visibleManagers.map((manager) => (
        <Badge
          key={`${manager.userId}-${manager.scope}-${manager.roleLabel}`}
          variant="outline"
          className="max-w-[230px] truncate border-blue-200 bg-blue-50/70 text-[10px] font-semibold text-blue-700"
          title={manager.label}
        >
          {manager.label}
        </Badge>
      ))}
      {extraCount > 0 && (
        <Badge variant="outline" className="border-slate-200 bg-slate-50 text-[10px] text-slate-500">
          +{extraCount}
        </Badge>
      )}
    </div>
  );
}
