import React, { useEffect, useRef } from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { CheckCircle2, Download, ArrowRight, Receipt, Building2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createPageUrl } from "@/utils";

export default function PaymentSuccess() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const state = location.state || {};
  const confettiRef = useRef(null);

  // Read from state (when navigated via navigate()) or query params (from Onboarding redirect)
  const plan = state.plan || searchParams.get("plan") || "Professional";
  const amount = state.amount || searchParams.get("amount") || null;
  const billingCycle = state.billing_cycle || searchParams.get("billing") || "monthly";
  const invoiceId = state.invoice_id || `INV-${Date.now().toString().slice(-8)}`;
  const orgName = state.org_name || searchParams.get("org") || "Your Organization";
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });


  // Confetti-like particle animation on mount
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

  const handleDownloadInvoice = () => {
    // Build a simple printable invoice
    const printContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Invoice ${invoiceId}</title>
        <style>
          body { font-family: 'Helvetica Neue', sans-serif; color: #1e293b; margin: 0; padding: 40px; }
          .header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 40px; }
          .logo { font-size: 20px; font-weight: 800; color: #0f1c3a; }
          .logo span { color: #2563eb; }
          .invoice-title { font-size: 28px; font-weight: 800; color: #0f1c3a; }
          .meta { color: #64748b; font-size: 14px; }
          .divider { border: none; border-top: 2px solid #e2e8f0; margin: 24px 0; }
          .row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #f1f5f9; font-size: 15px; }
          .total-row { display: flex; justify-content: space-between; padding: 16px 0; font-size: 18px; font-weight: 800; color: #0f1c3a; }
          .badge { display: inline-block; background: #d1fae5; color: #065f46; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; }
          .footer { margin-top: 60px; text-align: center; color: #94a3b8; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="logo">CRE <span>Suite</span></div>
          <div style="text-align:right">
            <div class="invoice-title">Invoice</div>
            <div class="meta">${invoiceId}</div>
            <div class="meta">${date}</div>
          </div>
        </div>
        <div class="meta">Billed to: <strong>${orgName}</strong></div>
        <hr class="divider" />
        <div class="row"><span>Plan</span><span>${plan} (${billingCycle})</span></div>
        <div class="row"><span>Billing Period</span><span>${date}</span></div>
        ${amount ? `<div class="total-row"><span>Total Due</span><span>$${Number(amount).toLocaleString()}</span></div>` : ""}
        <div style="margin-top:20px"><span class="badge">✓ PAID</span></div>
        <div class="footer">CRE Financial Suite · Thank you for your business.</div>
      </body>
      </html>
    `;
    const win = window.open("", "_blank");
    if (win) {
      win.document.write(printContent);
      win.document.close();
      win.print();
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
        .slide-5 { animation: slideUp 0.5s ease 1s both; }
      `}</style>

      <div ref={confettiRef} className="confetti-container" />

      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-emerald-50 flex flex-col items-center justify-center p-6 relative z-10">
        {/* Soft glows */}
        <div className="absolute top-20 left-1/2 -translate-x-1/2 w-96 h-96 bg-emerald-200/20 rounded-full blur-3xl pointer-events-none" />

        <div className="max-w-lg w-full text-center">
          {/* Success icon */}
          <div className="check-icon inline-flex w-24 h-24 rounded-3xl bg-emerald-100 items-center justify-center mb-8 shadow-lg shadow-emerald-200/50">
            <CheckCircle2 className="w-12 h-12 text-emerald-600" strokeWidth={1.5} />
          </div>

          {/* Heading */}
          <div className="slide-1">
            <div className="inline-flex items-center gap-1.5 bg-emerald-100 text-emerald-700 px-3 py-1 rounded-full text-xs font-bold mb-4">
              <Sparkles className="w-3 h-3" /> Payment Confirmed
            </div>
            <h1 className="text-4xl font-black text-slate-900 mb-3">You're all set!</h1>
            <p className="text-slate-500 text-lg">
              Welcome to the <strong className="text-slate-800">{plan}</strong> plan.
            </p>
          </div>

          {/* Invoice card */}
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
                <span className="text-xs text-slate-400">A confirmation email has been sent to your account.</span>
              </div>
            </div>
          </div>

          {/* Actions */}
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
              onClick={() => navigate(createPageUrl("Dashboard"))}
              className="h-12 px-8 rounded-xl bg-[#0f1c3a] hover:bg-[#1a2744] text-white font-bold gap-2 shadow-lg shadow-blue-900/10 group transition-all hover:scale-[1.02]"
            >
              Go to Dashboard
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </Button>
          </div>

          {/* Brand footer */}
          <div className="slide-4 mt-10 flex items-center justify-center gap-2 text-slate-400">
            <Building2 className="w-4 h-4" />
            <span className="text-xs font-medium">CRE Financial Suite · Enterprise Real Estate Intelligence</span>
          </div>
        </div>
      </div>
    </>
  );
}
