import React from "react";
import { useAuth } from "@/lib/AuthContext";
import { Lock, Eye } from "lucide-react";

/**
 * RoleGuard - Wraps UI elements to enforce role-based visibility and interactivity.
 * 
 * Props:
 * - allowedRoles: array of roles that can see/interact (e.g. ["admin", "org_admin", "finance"])
 * - mode: "hide" | "disable" | "readonly" (default: "hide")
 * - children: the wrapped content
 * - fallback: optional custom fallback component
 */
export default function RoleGuard({ allowedRoles = [], mode = "hide", children, fallback }) {
  const { user } = useAuth();
  const role = user?.role;

  // Admin always has full access
  if (role === "admin") return children;

  const hasAccess = allowedRoles.includes(role);

  if (hasAccess) return children;

  if (mode === "hide") {
    return fallback || null;
  }

  if (mode === "disable") {
    return (
      <div className="relative opacity-50 pointer-events-none select-none">
        {children}
        <div className="absolute inset-0 flex items-center justify-center bg-white/60 rounded-lg">
          <div className="flex items-center gap-1.5 bg-slate-100 rounded-full px-3 py-1">
            <Lock className="w-3 h-3 text-slate-500" />
            <span className="text-[10px] font-semibold text-slate-500">Locked</span>
          </div>
        </div>
      </div>
    );
  }

  if (mode === "readonly") {
    return (
      <div className="relative pointer-events-none select-none">
        {children}
        <div className="absolute top-1 right-1">
          <div className="flex items-center gap-1 bg-amber-100 rounded-full px-2 py-0.5">
            <Eye className="w-2.5 h-2.5 text-amber-600" />
            <span className="text-[8px] font-bold text-amber-600">READ-ONLY</span>
          </div>
        </div>
      </div>
    );
  }

  return children;
}