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
  const { enabledModules, isModuleEnabled } = useModuleAccess();
  const firstName = user?.full_name?.split(" ")[0] || "there";
  const [loading, setLoading] = useState(false);
  const [dots, setDots] = useState([]);

  // Generate floating celebration dots on mount
  useEffect(() => {
    const colors = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#1a2744"];
    const newDots = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: Math.random() * 10 + 4,
      delay: Math.random() * 2,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    setDots(newDots);
  }, []);

  const handleGoToDashboard = async () => {
    setLoading(true);
    try {
      // Mark onboarding as done and clear first_login flag
      await updateProfile({ onboarding_complete: true, first_login: false, dashboard_viewed: true });
      await refreshProfile();
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

    // Otherwise, filter by enabled modules
    const modulesToShow = enabledModules?.length > 0 
      ? enabledModules 
      : ['dashboard', 'portfolio', 'analytics_reports', 'documents']; // fallback/default

    let features = [];
    const hasBudgets = modulesToShow.includes('budgets');
    const hasCam = modulesToShow.includes('cam');

    // Special case: Combine Budgets & CAM if both enabled for Org Admin
    if (hasBudgets && hasCam) {
      features.push({ icon: Sparkles, label: "Budgeting & CAM", desc: "Full financial engine access" });
    }

    modulesToShow.forEach(key => {
      // Skip if already combined
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

    // Capping at 6 most relevant items
    return features.slice(0, 6);
  };

  const features = getDynamicFeatures();

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0f1c3a] via-[#1a2744] to-[#0f2553] flex items-center justify-center p-4 overflow-hidden relative">
      {/* Floating celebration dots */}
      {dots.map(dot => (
        <div
          key={dot.id}
          className="absolute rounded-full opacity-30 animate-bounce"
          style={{
            left: `${dot.x}%`,
            top: `${dot.y}%`,
            width: dot.size,
            height: dot.size,
            backgroundColor: dot.color,
            animationDelay: `${dot.delay}s`,
            animationDuration: `${1.5 + dot.delay}s`,
          }}
        />
      ))}

      <div className="max-w-2xl w-full relative z-10">
        {/* Logo */}
        <div className="flex justify-center mb-12">
          <div className="flex items-center gap-3">
             <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center shadow-lg shadow-white/10">
               <Building2 className="w-8 h-8 text-[#0f1c3a]" />
             </div>
             <div className="text-left">
               <h2 className="text-white text-2xl font-black tracking-tighter leading-none whitespace-nowrap">CRE SUITE</h2>
               <p className="text-blue-400 text-[10px] font-bold tracking-[0.2em] uppercase whitespace-nowrap">Budgeting & CAM</p>
             </div>
          </div>
        </div>

        {/* Success Badge */}
        <div className="flex justify-center mb-8">
          <div className="relative">
            <div className="absolute inset-0 bg-emerald-400/20 rounded-full animate-ping" />
            <div className="relative w-24 h-24 bg-gradient-to-br from-emerald-400 to-emerald-600 rounded-full flex items-center justify-center shadow-2xl shadow-emerald-500/30">
              <CheckCircle2 className="w-12 h-12 text-white" />
            </div>
          </div>
        </div>

        {/* Main Card */}
        <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-10 text-center shadow-2xl">
          <div className="flex items-center justify-center gap-2 text-emerald-400 mb-4">
            <Sparkles className="w-5 h-5" />
            <span className="text-sm font-bold uppercase tracking-widest">Account Activated</span>
            <Sparkles className="w-5 h-5" />
          </div>

          <h1 className="text-4xl font-black text-white mb-3 tracking-tight">
            Welcome Aboard, {firstName}! 🎉
          </h1>
          <p className="text-slate-300 text-base mb-2 max-w-lg mx-auto leading-relaxed">
            Your account has been <strong className="text-emerald-400">approved</strong> and your subscription is now active.
            You have full access to the CRE Financial Suite platform.
          </p>
          <p className="text-slate-400 text-sm mb-8">
            Here's everything that's unlocked for <strong className="text-white">{user?.activeOrg?.name || "your organization"}</strong>:
          </p>

          {/* Feature Grid */}
          <div className="grid grid-cols-2 gap-3 mb-10">
            {features.map(({ icon: Icon, label, desc }) => (
              <div key={label} className="bg-white/5 border border-white/10 rounded-2xl p-4 text-left hover:bg-white/10 transition-colors">
                <div className="w-10 h-10 bg-blue-500/20 rounded-xl flex items-center justify-center mb-3">
                  <Icon className="w-5 h-5 text-blue-400" />
                </div>
                <p className="text-white font-semibold text-sm">{label}</p>
                <p className="text-slate-400 text-xs mt-0.5">{desc}</p>
              </div>
            ))}
          </div>

          {/* CTA */}
          <Button
            onClick={handleGoToDashboard}
            disabled={loading}
            className="w-full h-14 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white text-base font-bold rounded-2xl shadow-lg shadow-blue-500/25 transition-all transform hover:scale-[1.02]"
          >
            {loading ? (
              <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Setting up your dashboard...</>
            ) : (
              <>Go to My Dashboard <ArrowRight className="w-5 h-5 ml-2" /></>
            )}
          </Button>

          <p className="text-slate-500 text-xs mt-4">
            You have access to all modules except the SuperAdmin portal.
          </p>
        </div>

        {/* Footer */}
        <p className="text-center text-slate-500 text-xs mt-6">
          CRE Financial Suite · Questions? support@cresuite.org
        </p>
      </div>
    </div>
  );
}
