import React, { useEffect } from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { CheckCircle2, Building2, Clock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/AuthContext";

export default function PaymentSuccess() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const state = location.state || {};
  const { refreshProfile } = useAuth();

  const plan = state.plan || searchParams.get("plan") || "Professional";
  const billingCycle = state.billing_cycle || searchParams.get("billing") || "monthly";
  const orgName = state.org_name || state.org || searchParams.get("org") || "Your Organization";
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  // Auto-poll every 10 seconds for org activation.
  useEffect(() => {
    const poll = setInterval(async () => {
      const freshUser = await refreshProfile();
      const isActive = freshUser?.profile?.status === 'active' || freshUser?.activeOrg?.status === 'active';
      if (isActive) {
        clearInterval(poll);
        navigate('/WelcomeAboard', { replace: true });
      }
    }, 10000);
    return () => clearInterval(poll);
  }, [refreshProfile, navigate]);

  return (
    <>
      <style>{`
        @keyframes scaleIn {
          0% { transform: scale(0); opacity: 0; }
          60% { transform: scale(1.1); }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes slideUp {
          0% { transform: translateY(24px); opacity: 0; }
          100% { transform: translateY(0); opacity: 1; }
        }
        .check-icon { animation: scaleIn 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) 0.2s both; }
        .slide-1 { animation: slideUp 0.5s ease 0.4s both; }
        .slide-2 { animation: slideUp 0.5s ease 0.55s both; }
        .slide-3 { animation: slideUp 0.5s ease 0.7s both; }
        .slide-4 { animation: slideUp 0.5s ease 0.85s both; }
      `}</style>

      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 flex flex-col items-center justify-center p-6 relative z-10">
        <div className="absolute top-20 left-1/2 -translate-x-1/2 w-96 h-96 bg-blue-200/20 rounded-full blur-3xl pointer-events-none" />

        <div className="max-w-lg w-full text-center">
          <div className="check-icon inline-flex w-24 h-24 rounded-3xl bg-blue-100 items-center justify-center mb-8 shadow-lg shadow-blue-200/50">
            <Clock className="w-12 h-12 text-blue-600" strokeWidth={1.5} />
          </div>

          <div className="slide-1">
            <div className="inline-flex items-center gap-1.5 bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-xs font-bold mb-4">
              Setup Submitted
            </div>
            <h1 className="text-4xl font-black text-slate-900 mb-3">You&apos;re almost there!</h1>
            <p className="text-slate-500 text-lg">
              Pending payment verification for the <strong className="text-slate-800">{plan}</strong> plan.
            </p>
            <div className="mt-4 p-4 bg-amber-50 border border-amber-100 rounded-xl flex items-start gap-3 text-left">
              <div className="w-5 h-5 bg-amber-500 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                <CheckCircle2 className="w-3 h-3 text-white" />
              </div>
              <div>
                <p className="text-sm font-bold text-amber-900">Next Step: Verification & Approval</p>
                <p className="text-xs text-amber-700 leading-relaxed">Our system is verifying your payment details. You will receive an email once your access is activated.</p>
              </div>
            </div>
          </div>

          <div className="slide-2 mt-8 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden text-left">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-slate-400" />
                <span className="text-sm font-semibold text-slate-700">Account Details</span>
              </div>
            </div>
            <div className="px-6 py-5 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Organization</span>
                <span className="font-medium text-slate-800">{orgName}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Plan</span>
                <span className="font-medium text-slate-800 capitalize">{plan} ({billingCycle})</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Date</span>
                <span className="font-medium text-slate-800">{date}</span>
              </div>
              <div className="flex items-center gap-2 pt-2 border-t border-slate-100 mt-2">
                <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-700 px-2.5 py-0.5 rounded-full text-xs font-bold">
                  <Clock className="w-3 h-3" /> PENDING VERIFICATION
                </span>
                <span className="text-xs text-slate-400">Waiting for payment confirmation.</span>
              </div>
            </div>
          </div>

          <div className="slide-3 mt-6 flex flex-col sm:flex-row gap-3 justify-center">
            <Button
              onClick={async () => {
                const { toast } = await import("sonner");
                toast.info("Checking status...");
                const freshUser = await refreshProfile();
                const isActive = freshUser?.profile?.status === 'active' || freshUser?.activeOrg?.status === 'active';
                if (isActive) {
                  navigate('/WelcomeAboard', { replace: true });
                } else {
                  toast.info("Account is still pending verification. You'll be notified once approved.");
                }
              }}
              title="Refresh access status"
              className="h-12 px-8 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold gap-2 shadow-sm"
            >
              Refresh Status
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>

          <div className="slide-4 mt-10 flex items-center justify-center gap-2 text-slate-400">
            <Building2 className="w-4 h-4" />
            <span className="text-xs font-medium">CRE Financial Suite · Enterprise Real Estate Intelligence</span>
          </div>
        </div>
      </div>
    </>
  );
}
