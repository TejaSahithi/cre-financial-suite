import React, { useEffect, useState } from "react";
import { CheckCircle2, Sparkles, ArrowRight, BarChart2, Building2, Users, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createPageUrl } from "@/utils";
import { useAuth } from "@/lib/AuthContext";
import { useModuleAccess } from "@/lib/ModuleAccessContext";
import { updateProfile } from "@/services/auth";
import { MODULE_DEFINITIONS } from "@/lib/moduleConfig";

export default function WelcomeAboard() {
  const { user, refreshProfile } = useAuth();
  const { enabledModules } = useModuleAccess();
  const firstName = user?.full_name?.split(" ")[0] || "there";
  const [loading, setLoading] = useState(false);

  const handleGoToDashboard = async () => {
    setLoading(true);
    try {
      // Mark onboarding as done and clear first_login flag
      await updateProfile({ onboarding_complete: true, first_login: false, dashboard_viewed: true });
      await refreshProfile(false);
    } catch (e) {
      console.error("[WelcomeAboard] Profile update failed:", e);
    }
    window.location.href = createPageUrl("Dashboard");
  };

  // Map module keys to rich display info
  const featureDisplayMap = {
    dashboard:      { icon: BarChart2, desc: "High-level performance metrics" },
    portfolio:      { icon: Building2, desc: "Track all properties & holdings" },
    properties:     { icon: Building2, desc: "Detailed building/unit management" },
    tenants:        { icon: Users,     desc: "Tenant leases & communications" },
    leases:         { icon: FileText,  desc: "Digital lease tracking & review" },
    cam:            { icon: Sparkles,  desc: "Automated expense reconciliation" },
    budgets:        { icon: FileText,  desc: "Operational budgeting & control" },
    analytics_reports: { icon: BarChart2, desc: "Real-time insights & reporting" },
    expenses:       { icon: FileText,  desc: "Track and project expenditures" },
    vendors:        { icon: Users,     desc: "Manage service providers" },
    reconciliation: { icon: FileText,  desc: "Financial data reconciliation" },
  };

  const getDynamicFeatures = () => {
    // If SuperAdmin, show a curated set of all major ones
    if (user?._raw_role === 'super_admin') {
      return [
        { icon: BarChart2, label: "Analytics & Reports", desc: "Global platform insights" },
        { icon: Sparkles,  label: "Budgeting & CAM",    desc: "Advanced financial control" },
        { icon: Building2, label: "Organization Management", desc: "Configure all clients" },
        { icon: Users,     label: "User Control",      desc: "Manage permissions centrally" },
      ];
    }

    const modulesToShow = enabledModules?.length > 0 
      ? enabledModules 
      : ['dashboard', 'portfolio', 'analytics_reports'];

    let features = [];
    const hasBudgets = modulesToShow.includes('budgets');
    const hasCam = modulesToShow.includes('cam');

    // Combine Budgets & CAM if both enabled
    if (hasBudgets && hasCam) {
      features.push({ icon: Sparkles, label: "Budgeting & CAM", desc: "Full financial engine access" });
    }

    modulesToShow.forEach(key => {
      if ((key === 'budgets' || key === 'cam') && hasBudgets && hasCam) return;
      const mod = MODULE_DEFINITIONS[key];
      const display = featureDisplayMap[key];
      if (!mod) return;
      features.push({
        icon: display?.icon || Sparkles,
        label: mod.label,
        desc: display?.desc || "Full module access"
      });
    });

    return features.slice(0, 6);
  };

  const features = getDynamicFeatures();

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 py-12 relative overflow-hidden font-sans">
      {/* Subtle background decoration */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-100/30 rounded-full blur-3xl" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-100/30 rounded-full blur-3xl" />
      </div>

      <div className="max-w-4xl w-full relative z-10">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 bg-emerald-100 text-emerald-700 px-4 py-1.5 rounded-full text-xs font-bold mb-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Account Activated
          </div>
          <h1 className="text-4xl md:text-5xl font-black text-slate-900 mb-4 tracking-tight animate-in fade-in slide-in-from-bottom-4 duration-700 delay-100">
            Welcome to the Suite, <span className="text-blue-600">{firstName}!</span>
          </h1>
          <p className="text-slate-500 text-lg max-w-xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200">
            Your workspace for <strong className="text-slate-900">{user?.activeOrg?.name || "your organization"}</strong> is ready. Explore your unlocked modules below.
          </p>
        </div>

        {/* Feature Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mb-12">
          {features.map((feature, idx) => (
            <div 
              key={idx}
              style={{ animationDelay: `${300 + idx * 100}ms` }}
              className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md hover:border-blue-200 transition-all duration-300 group animate-in fade-in zoom-in-95 duration-700 fill-mode-both"
            >
              <div className="w-11 h-11 bg-slate-50 rounded-xl flex items-center justify-center mb-4 group-hover:bg-blue-50 transition-colors">
                <feature.icon className="w-5 h-5 text-slate-600 group-hover:text-blue-600 transition-colors" />
              </div>
              <h3 className="font-bold text-slate-900 mb-1">{feature.label}</h3>
              <p className="text-slate-500 text-xs leading-relaxed">{feature.desc}</p>
            </div>
          ))}
        </div>

        {/* Action */}
        <div className="text-center animate-in fade-in slide-in-from-bottom-4 duration-700 delay-500 fill-mode-both">
          <Button 
            onClick={handleGoToDashboard}
            disabled={loading}
            className="h-14 px-12 rounded-2xl bg-[#0f1c3a] hover:bg-[#1a2744] text-white font-bold text-lg shadow-xl shadow-blue-900/10 gap-3 group transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            {loading ? (
              <Loader2 className="w-6 h-6 animate-spin" />
            ) : (
              <>
                Go to Dashboard
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </>
            )}
          </Button>
          <p className="text-slate-400 text-[10px] font-medium tracking-wider uppercase mt-8 opacity-60">
            Real-time Commercial Real Estate Intelligence
          </p>
        </div>
      </div>
    </div>
  );
}
