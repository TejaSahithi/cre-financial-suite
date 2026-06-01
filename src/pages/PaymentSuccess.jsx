import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, Building2, Clock, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/AuthContext";
import { supabase } from "@/services/supabaseClient";

export default function PaymentSuccess() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { refreshProfile } = useAuth();
  
  const sessionId = searchParams.get("session_id");

  const [status, setStatus] = useState("verifying"); // verifying, confirmed, timeout
  const [invoice, setInvoice] = useState(null);
  const [org, setOrg] = useState(null);

  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  useEffect(() => {
    let attempts = 0;
    const maxAttempts = 30; // 5 minutes if polling every 10s

    const checkStatus = async () => {
      try {
        attempts++;
        const freshUser = await refreshProfile();
        const currentOrg = freshUser?.activeOrg;
        setOrg(currentOrg);

        if (currentOrg?.status === 'active' || freshUser?.profile?.status === 'active') {
          navigate('/WelcomeAboard', { replace: true });
          return;
        }

        if (sessionId) {
          const { data: inv } = await supabase
            .from('invoices')
            .select('*')
            .eq('stripe_session_id', sessionId)
            .maybeSingle();

          if (inv) {
            setInvoice(inv);
            setStatus("confirmed");
            return;
          }
        } else if (currentOrg?.status === 'under_review') {
           setStatus("confirmed");
           return;
        }

        if (attempts >= maxAttempts) {
          setStatus("timeout");
        }
      } catch (e) {
        console.error("Error checking payment status", e);
      }
    };

    checkStatus();
    const poll = setInterval(checkStatus, 10000);

    return () => clearInterval(poll);
  }, [sessionId, refreshProfile, navigate]);

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
      `}</style>

      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 flex flex-col items-center justify-center p-6 relative z-10">
        <div className="absolute top-20 left-1/2 -translate-x-1/2 w-96 h-96 bg-blue-200/20 rounded-full blur-3xl pointer-events-none" />

        <div className="max-w-lg w-full text-center">
          {status === "verifying" && (
            <>
              <div className="inline-flex w-24 h-24 rounded-3xl bg-amber-100 items-center justify-center mb-8 shadow-lg shadow-amber-200/50">
                <Loader2 className="w-12 h-12 text-amber-600 animate-spin" strokeWidth={1.5} />
              </div>
              <h1 className="text-3xl font-black text-slate-900 mb-3">Verifying Payment...</h1>
              <p className="text-slate-500 text-lg">Please wait while we confirm your payment with Stripe.</p>
            </>
          )}

          {status === "confirmed" && (
            <>
              <div className="check-icon inline-flex w-24 h-24 rounded-3xl bg-blue-100 items-center justify-center mb-8 shadow-lg shadow-blue-200/50">
                <Clock className="w-12 h-12 text-blue-600" strokeWidth={1.5} />
              </div>
              <div className="slide-1">
                <div className="inline-flex items-center gap-1.5 bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-xs font-bold mb-4">
                  Payment Confirmed
                </div>
                <h1 className="text-4xl font-black text-slate-900 mb-3">Setup Submitted</h1>
                <p className="text-slate-500 text-lg">
                  Your payment was verified. Pending admin review.
                </p>
                <div className="mt-4 p-4 bg-amber-50 border border-amber-100 rounded-xl flex items-start gap-3 text-left">
                  <div className="w-5 h-5 bg-amber-500 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                    <CheckCircle2 className="w-3 h-3 text-white" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-amber-900">Next Step: Verification & Approval</p>
                    <p className="text-xs text-amber-700 leading-relaxed">Our system is verifying your organization. You will receive an email once your access is activated.</p>
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
                    <span className="font-medium text-slate-800">{org?.name || "Your Organization"}</span>
                  </div>
                  {invoice && (
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Amount Paid</span>
                      <span className="font-medium text-slate-800">${invoice.amount}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-500">Date</span>
                    <span className="font-medium text-slate-800">{date}</span>
                  </div>
                  <div className="flex items-center gap-2 pt-2 border-t border-slate-100 mt-2">
                    <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-700 px-2.5 py-0.5 rounded-full text-xs font-bold">
                      <Clock className="w-3 h-3" /> PENDING ACTIVATION
                    </span>
                    <span className="text-xs text-slate-400">Waiting for SuperAdmin approval.</span>
                  </div>
                </div>
              </div>
            </>
          )}

          {status === "timeout" && (
            <>
              <div className="inline-flex w-24 h-24 rounded-3xl bg-red-100 items-center justify-center mb-8 shadow-lg shadow-red-200/50">
                <AlertCircle className="w-12 h-12 text-red-600" strokeWidth={1.5} />
              </div>
              <h1 className="text-3xl font-black text-slate-900 mb-3">Still waiting for confirmation</h1>
              <p className="text-slate-500 text-lg mb-6">Payment not found yet. Please check back later or contact support if the issue persists.</p>
              <Button
                onClick={() => window.location.reload()}
                className="h-12 px-8 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold"
              >
                Refresh Page
              </Button>
            </>
          )}

          <div className="slide-3 mt-10 flex items-center justify-center gap-2 text-slate-400">
            <Building2 className="w-4 h-4" />
            <span className="text-xs font-medium">CRE Financial Suite · Enterprise Real Estate Intelligence</span>
          </div>
        </div>
      </div>
    </>
  );
}
