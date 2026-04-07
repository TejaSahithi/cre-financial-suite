import React, { useState, useEffect } from "react";
import { AccessRequestService } from "@/services/api";
import { Building2, Clock, CheckCircle2, Mail, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

import { redirectToLogin } from "@/services/auth";

export default function PendingApproval() {
  const [status, setStatus] = useState("pending"); // pending | approved | rejected
  const [checking, setChecking] = useState(false);
  const [userEmail, setUserEmail] = useState("");

  useEffect(() => {
    // Try to get email from URL params or local storage
    const location = useLocation();
  const params = new URLSearchParams(location.search);
    const email = params.get("email") || localStorage.getItem("cre_pending_email") || "";
    setUserEmail(email);

    checkStatus(email);
  }, []);

  const checkStatus = async (email) => {
    if (!email) return;
    setChecking(true);
    try {
      const requests = await AccessRequestService.filter({ email });
      if (requests.length > 0) {
        const latest = requests[0];
        setStatus(latest.status);
      }
    } catch (e) {}
    setChecking(false);
  };

  if (status === "approved") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#1a2744] to-[#243b67] flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-10 text-center">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-8 h-8 text-emerald-600" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Access Approved!</h2>
          <p className="text-slate-500 text-sm mb-6">
            Your access has been approved. Check your email for your sign-in link. Click the link in the email to get started.
          </p>
          <Button onClick={() => redirectToLogin()} className="w-full bg-[#1a2744] hover:bg-[#243b67] h-11">
            Sign In Now
          </Button>
        </div>
      </div>
    );
  }

  if (status === "rejected") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#1a2744] to-[#243b67] flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-10 text-center">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Mail className="w-8 h-8 text-red-500" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Request Not Approved</h2>
          <p className="text-slate-500 text-sm mb-6">
            Unfortunately your request was not approved at this time. Please reach out to us if you believe this is an error.
          </p>
          <div className="bg-slate-50 rounded-xl p-4 text-left mb-6">
            <p className="text-xs font-semibold text-slate-700 mb-1">Contact Us</p>
            <p className="text-sm text-slate-600">📧 support@creplatform.io</p>
            <p className="text-sm text-slate-600">📞 +1 (800) 555-0199</p>
          </div>
          <Button variant="outline" onClick={() => window.location.href = "/"} className="w-full">
            Back to Home
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1a2744] to-[#243b67] flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-10 text-center">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-10 h-10 bg-[#1a2744] rounded-xl flex items-center justify-center">
            <Building2 className="w-6 h-6 text-white" />
          </div>
          <span className="text-[#1a2744] font-bold text-xl tracking-tight">CRE PLATFORM</span>
        </div>

        {/* Status */}
        <div className="w-20 h-20 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <Clock className="w-10 h-10 text-amber-500" />
        </div>
        <h2 className="text-2xl font-bold text-slate-900 mb-2">Request Under Review</h2>
        <p className="text-slate-500 text-sm mb-2">
          Thank you for your interest in CRE Platform! Your access request has been submitted and is pending review by our team.
        </p>
        {userEmail && (
          <p className="text-xs text-slate-400 mb-6">
            Submitted for: <span className="font-medium text-slate-600">{userEmail}</span>
          </p>
        )}

        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-left mb-6">
          <p className="text-xs font-semibold text-blue-700 mb-2">What happens next?</p>
          <ul className="space-y-1.5">
            <li className="flex items-start gap-2 text-xs text-blue-600">
              <span className="w-4 h-4 bg-blue-200 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">1</span>
              Our team reviews your application (within 24–48 hours)
            </li>
            <li className="flex items-start gap-2 text-xs text-blue-600">
              <span className="w-4 h-4 bg-blue-200 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">2</span>
              You'll receive an email with your sign-in link if approved
            </li>
            <li className="flex items-start gap-2 text-xs text-blue-600">
              <span className="w-4 h-4 bg-blue-200 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">3</span>
              Complete company onboarding, sign MSA, and set up billing
            </li>
            <li className="flex items-start gap-2 text-xs text-blue-600">
              <span className="w-4 h-4 bg-blue-200 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">4</span>
              Access the full CRE Platform
            </li>
          </ul>
        </div>

        <Button
          variant="outline"
          onClick={() => checkStatus(userEmail)}
          disabled={checking}
          className="w-full mb-3"
        >
          {checking ? <RefreshCw className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
          Check Status
        </Button>

        <div className="mt-4 pt-4 border-t border-slate-100">
          <p className="text-xs text-slate-400">Questions? Contact us at</p>
          <a href="mailto:support@creplatform.io" className="text-xs text-blue-600 font-medium hover:underline">
            support@creplatform.io
          </a>
        </div>
      </div>
    </div>
  );
}