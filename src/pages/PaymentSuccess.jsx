import React, { useEffect, useRef } from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { CheckCircle2, Download, ArrowRight, Receipt, Building2, Sparkles, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createPageUrl } from "@/utils";
import { useAuth } from "@/lib/AuthContext";

export default function PaymentSuccess() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const state = location.state || {};
  const confettiRef = useRef(null);
  const { refreshProfile } = useAuth();

  const plan = state.plan || searchParams.get("plan") || "Professional";
  const rawAmount = state.amount || searchParams.get("amount") || null;
  const amount = rawAmount && !isNaN(parseFloat(rawAmount)) ? parseFloat(rawAmount) : null;
  const billingCycle = state.billing_cycle || searchParams.get("billing") || "monthly";
  const invoiceId = state.invoice_id || `INV-${Date.now().toString().slice(-8)}`;
  const orgName = state.org_name || state.org || searchParams.get("org") || "Your Organization";
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  useEffect(() => {
    const container = confettiRef.current;
    if (!container) return;

    const colors = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"];
    for (let i = 0; i < 40; i++) {
      const el = document.createElement("div");
      const size = Math.random() * 8 + 4;
      el.style.cssText = `
        position: absolute;
        width: ${size}px;
        height: ${size}px;
        background: ${colors[Math.floor(Math.random() * colors.length)]};
        border-radius: ${Math.random() > 0.5 ? "50%" : "2px"};
        left: ${Math.random() * 100}%;
        top: -10px;
        opacity: ${Math.random() * 0.7 + 0.3};
        animation: confettiFall ${Math.random() * 2 + 2}s ease-in ${Math.random() * 1.5}s forwards;
      `;
      container.appendChild(el);
    }

    return () => {
      while (container.firstChild) container.removeChild(container.firstChild);
    };
  }, []);

  const handleDownloadInvoice = async () => {
    try {
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF();

      doc.setFont("helvetica", "bold");
      doc.setFontSize(22);
      doc.setTextColor("#0f1c3a");
      doc.text("CRE Suite", 20, 24);
      doc.setFontSize(20);
      doc.text("Invoice", 190, 24, { align: "right" });

      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor("#64748b");
      doc.text(`Invoice ID: ${invoiceId}`, 20, 38);
      doc.text(`Date: ${date}`, 20, 45);
      doc.text(`Billed To: ${orgName}`, 20, 52);

      doc.setDrawColor(226, 232, 240);
      doc.line(20, 60, 190, 60);

      doc.setFont("helvetica", "bold");
      doc.setTextColor("#0f1c3a");
      doc.text("Subscription", 20, 74);
      doc.text("Cycle", 120, 74);
      doc.text("Amount", 190, 74, { align: "right" });

      doc.setFont("helvetica", "normal");
      doc.setTextColor("#334155");
      doc.text(plan, 20, 86);
      doc.text(billingCycle, 120, 86);
      doc.text(amount ? `$${Number(amount).toLocaleString()}` : "Paid", 190, 86, { align: "right" });

      doc.line(20, 94, 190, 94);
      doc.setFont("helvetica", "bold");
      doc.setTextColor("#0f1c3a");
      doc.text("Status: PAID", 20, 108);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor("#64748b");
      doc.text("Thank you for choosing CRE Financial Suite.", 20, 122);

      doc.save(`${invoiceId}.pdf`);
    } catch (error) {
      console.error("[PaymentSuccess] Invoice download failed:", error);
    }
  };

  return (
    <>
      <style>{`
        @keyframes confettiFall {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
        }
        @keyframes scaleIn {
          0% { transform: scale(0); opacity: 0; }
          60% { transform: scale(1.1); }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes slideUp {
          0% { transform: translateY(24px); opacity: 0; }
          100% { transform: translateY(0); opacity: 1; }
        }
        .confetti-container { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: 0; }
        .check-icon { animation: scaleIn 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) 0.2s both; }
        .slide-1 { animation: slideUp 0.5s ease 0.4s both; }
        .slide-2 { animation: slideUp 0.5s ease 0.55s both; }
        .slide-3 { animation: slideUp 0.5s ease 0.7s both; }
        .slide-4 { animation: slideUp 0.5s ease 0.85s both; }
      `}</style>

      <div ref={confettiRef} className="confetti-container" />

      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-emerald-50 flex flex-col items-center justify-center p-6 relative z-10">
        <div className="absolute top-20 left-1/2 -translate-x-1/2 w-96 h-96 bg-emerald-200/20 rounded-full blur-3xl pointer-events-none" />

        <div className="max-w-lg w-full text-center">
          <div className="check-icon inline-flex w-24 h-24 rounded-3xl bg-emerald-100 items-center justify-center mb-8 shadow-lg shadow-emerald-200/50">
            <CheckCircle2 className="w-12 h-12 text-emerald-600" strokeWidth={1.5} />
          </div>

          <div className="slide-1">
            <div className="inline-flex items-center gap-1.5 bg-emerald-100 text-emerald-700 px-3 py-1 rounded-full text-xs font-bold mb-4">
              <Sparkles className="w-3 h-3" /> Payment Confirmed
            </div>
            <h1 className="text-4xl font-black text-slate-900 mb-3">You&apos;re all set!</h1>
            <p className="text-slate-500 text-lg">
              Welcome to the <strong className="text-slate-800">{plan}</strong> plan.
            </p>
            <div className="mt-4 p-4 bg-blue-50 border border-blue-100 rounded-xl flex items-start gap-3 text-left">
              <div className="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                <CheckCircle2 className="w-3 h-3 text-white" />
              </div>
              <div>
                <p className="text-sm font-bold text-blue-900">Next Step: Administrator Review</p>
                <p className="text-xs text-blue-700 leading-relaxed">Our team is reviewing your account for security compliance. You will receive a welcome email once your access is activated.</p>
              </div>
            </div>
          </div>

          <div className="slide-2 mt-8 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden text-left">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Receipt className="w-4 h-4 text-slate-400" />
                <span className="text-sm font-semibold text-slate-700">Invoice Summary</span>
              </div>
              <span className="text-xs font-mono text-slate-500">{invoiceId}</span>
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
              {amount && (
                <div className="flex justify-between pt-3 border-t border-slate-100">
                  <span className="font-bold text-slate-900">Total Charged</span>
                  <span className="font-black text-slate-900 text-lg">${Number(amount).toLocaleString()}</span>
                </div>
              )}
              <div className="flex items-center gap-2 pt-2">
                <span className="inline-flex items-center gap-1 bg-emerald-100 text-emerald-700 px-2.5 py-0.5 rounded-full text-xs font-bold">
                  <CheckCircle2 className="w-3 h-3" /> PAID
                </span>
                <span className="text-xs text-slate-400">Your payment has been recorded successfully.</span>
              </div>
            </div>
          </div>

          <div className="slide-3 mt-6 flex flex-col sm:flex-row gap-3 justify-center">
            <Button
              onClick={handleDownloadInvoice}
              variant="outline"
              className="h-12 px-6 rounded-xl font-semibold border-slate-200 gap-2 hover:border-slate-300"
            >
              <Download className="w-4 h-4" />
              Download Invoice
            </Button>
            <Button
              onClick={async () => {
                import("sonner").then(({ toast }) => toast.info("Checking status..."));
                const freshUser = await refreshProfile();
                if (freshUser?.profile?.status === 'active') {
                  navigate('/Dashboard');
                } else {
                  import("sonner").then(({ toast }) => toast.info("Account is still under review."));
                }
              }}
              title="Refresh access status"
              className="h-12 px-8 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold gap-2 shadow-sm"
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
