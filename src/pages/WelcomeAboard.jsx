import React, { useState } from "react";
import {
  CheckCircle2, Sparkles, ArrowRight, BarChart2, Building2, Users, FileText,
  Loader2, DollarSign, Calculator, TrendingUp, PieChart, Layers, GitMerge,
  Shield, Settings, Globe, Zap, Star
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { createPageUrl } from "@/utils";
import { useAuth } from "@/lib/AuthContext";
import { useModuleAccess } from "@/lib/ModuleAccessContext";
import { updateProfile } from "@/services/auth";
import { MODULE_DEFINITIONS } from "@/lib/moduleConfig";

const MODULE_RICH = {
  dashboard: {
    icon: BarChart2,
    label: "Executive Dashboard",
    desc: "High-level KPIs, rent collection trends, occupancy rates, and NOI tracking at a glance. Your command center for the entire portfolio.",
    color: "from-blue-500 to-indigo-600",
    badge: "Core"
  },
  portfolio: {
    icon: Layers,
    label: "Portfolio Overview",
    desc: "Manage and analyze all properties and holdings in one view. View portfolio-level metrics, asset allocation, and performance benchmarks.",
    color: "from-violet-500 to-purple-600",
    badge: "Core"
  },
  properties: {
    icon: Building2,
    label: "Property Management",
    desc: "Full management of buildings, units, floors, and amenities. Track occupancy, vacancy, maintenance schedules, and building documentation.",
    color: "from-slate-600 to-slate-700",
    badge: "Core"
  },
  tenants: {
    icon: Users,
    label: "Tenant Management",
    desc: "Centralize all tenant relationships from move-in to move-out. Track rental history, communications, escalations, and tenant profiles.",
    color: "from-emerald-500 to-green-600",
    badge: "Core"
  },
  leases: {
    icon: FileText,
    label: "Lease Lifecycle",
    desc: "Digital lease tracking from execution to expiration. AI-assisted lease review, clause extraction, renewal forecasting, and compliance monitoring.",
    color: "from-amber-500 to-orange-500",
    badge: "Smart"
  },
  cam: {
    icon: Calculator,
    label: "CAM Reconciliation",
    desc: "Automate Common Area Maintenance calculations and annual reconciliations. Generate tenant-ready statements with full audit trails.",
    color: "from-pink-500 to-rose-600",
    badge: "Financial"
  },
  budgets: {
    icon: DollarSign,
    label: "Budget Management",
    desc: "Build property and portfolio budgets, track actuals vs. forecast, and get real-time variance alerts. Supports multi-year planning.",
    color: "from-emerald-600 to-teal-600",
    badge: "Financial"
  },
  analytics_reports: {
    icon: TrendingUp,
    label: "Analytics & Reports",
    desc: "Unlock powerful reporting with NOI analysis, rent projection, market benchmarks, and exportable dashboards.",
    color: "from-blue-600 to-cyan-500",
    badge: "Insights"
  },
  expenses: {
    icon: PieChart,
    label: "Expense Tracking",
    desc: "Log, categorize, and project operating expenses by property or unit. Integrates directly with Budget and CAM modules.",
    color: "from-orange-500 to-amber-500",
    badge: "Financial"
  },
  vendors: {
    icon: Globe,
    label: "Vendor Management",
    desc: "Manage your service provider ecosystem with contract terms, insurance tracking, invoice history, and performance ratings.",
    color: "from-teal-500 to-emerald-500",
    badge: "Operations"
  },
  reconciliation: {
    icon: GitMerge,
    label: "Financial Reconciliation",
    desc: "Reconcile bank statements, rent rolls, and payable ledgers against your operational data.",
    color: "from-indigo-500 to-blue-500",
    badge: "Financial"
  },
  workflows: {
    icon: Zap,
    label: "Workflow Automation",
    desc: "Automate approval workflows, maintenance tickets, notifications, and task assignments.",
    color: "from-yellow-500 to-orange-400",
    badge: "Operations"
  },
  documents: {
    icon: FileText,
    label: "Document Center",
    desc: "Secure storage for leases, contracts, insurance certs, and inspection reports with permission-based access.",
    color: "from-slate-500 to-slate-600",
    badge: "Core"
  },
};

const SUPER_ADMIN_FEATURES = [
  {
    icon: Shield,
    label: "Platform Administration",
    desc: "Full visibility across all organizations. Approve accounts, monitor platform health, and manage access requests from a unified console.",
    color: "from-red-600 to-rose-700",
    badge: "Admin"
  },
  {
    icon: Users,
    label: "Global User Management",
    desc: "Manage every user across all organizations. Assign roles, revoke access, review invitations, and control permissions.",
    color: "from-amber-600 to-orange-600",
    badge: "Admin"
  },
  {
    icon: BarChart2,
    label: "Cross-Portfolio Analytics",
    desc: "Aggregate and compare performance metrics across all client organizations for internal review.",
    color: "from-blue-600 to-indigo-700",
    badge: "Insights"
  },
  {
    icon: Building2,
    label: "Organization Oversight",
    desc: "Review all registered organizations, their billing status, plan tiers, onboarding progress, and operational KPIs.",
    color: "from-slate-600 to-slate-700",
    badge: "Admin"
  },
  {
    icon: Settings,
    label: "Platform Configuration",
    desc: "Configure system defaults, module availability flags, email templates, and security settings across the platform.",
    color: "from-violet-600 to-purple-700",
    badge: "Admin"
  },
  {
    icon: Star,
    label: "Full CRE Suite Access",
    desc: "All modules are available to you across every client organization.",
    color: "from-emerald-600 to-teal-600",
    badge: "All Access"
  },
];

const badgeColors = {
  Admin: "bg-rose-100 text-rose-700",
  Core: "bg-blue-100 text-blue-700",
  Financial: "bg-emerald-100 text-emerald-700",
  Smart: "bg-violet-100 text-violet-700",
  Insights: "bg-amber-100 text-amber-700",
  Operations: "bg-teal-100 text-teal-700",
  "All Access": "bg-gradient-to-r from-blue-600 to-emerald-600 text-white",
};

function formatLabel(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\bYo Y\b/g, "YoY")
    .trim();
}

export default function WelcomeAboard() {
  const { user, refreshProfile } = useAuth();
  const { enabledModules, assignedPagesByModule, activeMembership } = useModuleAccess();
  const firstName = user?.full_name?.split(" ")[0] || "there";
  const [loading, setLoading] = useState(false);

  const isSuperAdmin = user?._raw_role === "super_admin";
  const isOrgAdmin = user?._raw_role === "org_admin" || user?.role?.includes("org_admin");
  const orgName = user?.activeOrg?.name || "your organization";
  const roleName = activeMembership?.role ? formatLabel(activeMembership.role) : "Team member";
  const totalAssignedPages = Object.values(assignedPagesByModule || {}).reduce(
    (count, pages) => count + pages.length,
    0
  );

  const handleGoToDashboard = async () => {
    setLoading(true);
    try {
      await updateProfile({ onboarding_complete: true, first_login: false, dashboard_viewed: true });
      await refreshProfile(false);
    } catch (e) {
      console.error("[WelcomeAboard] Profile update failed:", e);
    }
    window.location.href = createPageUrl("Dashboard");
  };

  const getFeatures = () => {
    if (isSuperAdmin) return SUPER_ADMIN_FEATURES.map((feature, index) => ({ key: `super-${index}`, ...feature }));
    if (isOrgAdmin) return Object.entries(MODULE_RICH).map(([key, value]) => ({ key, ...value }));

    const assigned = enabledModules?.length > 0 ? enabledModules : ["dashboard"];
    return assigned
      .map((key) => ({
        key,
        ...(MODULE_RICH[key] || {
          icon: Sparkles,
          label: MODULE_DEFINITIONS[key]?.label || formatLabel(key),
          desc: "Full module access",
          color: "from-slate-500 to-slate-600",
          badge: "Module",
        }),
      }))
      .filter(Boolean);
  };

  const features = getFeatures();

  const getRoleLabel = () => {
    if (isSuperAdmin) return { text: "Platform SuperAdmin", color: "bg-rose-100 text-rose-700 border border-rose-200" };
    if (isOrgAdmin) return { text: "Organization Admin", color: "bg-amber-100 text-amber-700 border border-amber-200" };
    return { text: roleName, color: "bg-blue-100 text-blue-700 border border-blue-200" };
  };

  const roleLabel = getRoleLabel();

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 flex flex-col items-center justify-start p-6 py-16 relative overflow-hidden font-sans">
      <div className="absolute top-0 right-0 h-[500px] w-[500px] rounded-full bg-blue-200/20 blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 left-0 h-[400px] w-[400px] rounded-full bg-indigo-200/20 blur-3xl pointer-events-none" />

      <div className="max-w-5xl w-full relative z-10">
        <div className="text-center mb-14 animate-in fade-in slide-in-from-bottom-6 duration-700">
          <div className="inline-flex items-center gap-2 bg-emerald-100 text-emerald-700 px-4 py-1.5 rounded-full text-xs font-bold mb-6">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Account Activated
          </div>
          <h1 className="text-4xl md:text-5xl font-black text-slate-900 mb-4 tracking-tight">
            Welcome aboard, <span className="text-blue-600">{firstName}!</span>
          </h1>
          <div className="flex items-center justify-center gap-2 mb-4 flex-wrap">
            <span className={`px-3 py-1 rounded-full text-xs font-bold ${roleLabel.color}`}>
              {roleLabel.text}
            </span>
            {!isSuperAdmin && <span className="text-slate-400 text-xs">·</span>}
            {!isSuperAdmin && <span className="text-slate-500 text-sm font-medium">{orgName}</span>}
          </div>
          <p className="text-slate-500 text-base max-w-2xl mx-auto leading-relaxed">
            {isSuperAdmin
              ? "You have full SuperAdmin access to the CRE Financial Suite platform. Monitor all organizations, manage users, and configure the platform from your console."
              : isOrgAdmin
              ? `Your entire workspace for ${orgName} is ready. As Organization Admin, you have access to all modules in the suite.`
              : `Your workspace for ${orgName} is ready. Your assigned modules and pages are listed below so you can jump straight into the areas your administrator enabled.`}
          </p>
        </div>

        {!isSuperAdmin && !isOrgAdmin && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10 animate-in fade-in duration-700">
            {[
              { label: "Assigned Modules", value: features.length, icon: Layers },
              { label: "Assigned Pages", value: totalAssignedPages, icon: FileText },
              { label: "Role", value: roleName, icon: Shield },
            ].map((stat) => (
              <div key={stat.label} className="bg-white rounded-2xl border border-slate-200 px-6 py-5 text-center shadow-sm">
                <stat.icon className="w-4 h-4 text-slate-400 mx-auto mb-2" />
                <p className="text-xl font-black text-slate-900">{stat.value}</p>
                <p className="text-xs text-slate-400 font-medium mt-0.5">{stat.label}</p>
              </div>
            ))}
          </div>
        )}

        <div className={`grid grid-cols-1 md:grid-cols-2 ${features.length > 4 ? "lg:grid-cols-3" : "lg:grid-cols-2"} gap-5 mb-14`}>
          {features.map((feature, idx) => {
            const assignedPages = assignedPagesByModule?.[feature.key] || [];

            return (
              <div
                key={feature.key}
                style={{ animationDelay: `${100 + idx * 60}ms` }}
                className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-lg hover:border-blue-200 transition-all duration-300 group animate-in fade-in zoom-in-95 duration-500 fill-mode-both cursor-default"
              >
                <div className="flex items-start gap-4">
                  <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${feature.color} flex items-center justify-center shrink-0 shadow-sm group-hover:scale-105 transition-transform`}>
                    <feature.icon className="w-5 h-5 text-white" strokeWidth={1.75} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      <h3 className="font-bold text-slate-900 text-sm leading-snug">{feature.label}</h3>
                      {feature.badge && (
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wide ${badgeColors[feature.badge] || "bg-slate-100 text-slate-500"}`}>
                          {feature.badge}
                        </span>
                      )}
                    </div>
                    <p className="text-slate-500 text-xs leading-relaxed">{feature.desc}</p>

                    {!isSuperAdmin && !isOrgAdmin && assignedPages.length > 0 && (
                      <div className="mt-4">
                        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400 mb-2">
                          Assigned Pages
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {assignedPages.map((pageName) => (
                            <span
                              key={`${feature.key}-${pageName}`}
                              className="inline-flex items-center rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-600"
                            >
                              {formatLabel(pageName)}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {(isOrgAdmin || isSuperAdmin) && (
          <div className="grid grid-cols-3 gap-4 mb-14 animate-in fade-in duration-700 delay-500 fill-mode-both">
            {[
              { label: "Modules Available", value: isSuperAdmin ? "All" : Object.keys(MODULE_RICH).length, icon: Layers },
              { label: "Role", value: isSuperAdmin ? "SuperAdmin" : "Org Admin", icon: Shield },
              { label: "Status", value: "Active", icon: CheckCircle2 },
            ].map((stat) => (
              <div key={stat.label} className="bg-white rounded-2xl border border-slate-200 px-6 py-5 text-center shadow-sm">
                <stat.icon className="w-4 h-4 text-slate-400 mx-auto mb-2" />
                <p className="text-xl font-black text-slate-900">{stat.value}</p>
                <p className="text-xs text-slate-400 font-medium mt-0.5">{stat.label}</p>
              </div>
            ))}
          </div>
        )}

        <div className="text-center animate-in fade-in slide-in-from-bottom-4 duration-700 delay-700 fill-mode-both">
          <Button
            onClick={handleGoToDashboard}
            disabled={loading}
            className="h-14 px-14 rounded-2xl bg-[#0f1c3a] hover:bg-[#1a2744] text-white font-bold text-base shadow-2xl shadow-blue-900/20 gap-3 group transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <>
                {isSuperAdmin ? "Go to Admin Console" : "Go to Dashboard"}
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </>
            )}
          </Button>
          <p className="text-slate-400 text-[11px] font-medium tracking-wider uppercase mt-8 opacity-60">
            CRE Financial Suite · Enterprise Real Estate Intelligence
          </p>
        </div>
      </div>
    </div>
  );
}
