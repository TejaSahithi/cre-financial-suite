import React, { useState, useEffect } from "react";
import { AccessRequestService } from "@/services/api";
import { Building2, Clock, CheckCircle2, Mail, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation } from "react-router-dom";

import { redirectToLogin } from "@/services/auth";

export default function PendingApproval() {
  const [status, setStatus] = useState("pending"); // pending | approved | rejected
  const [checking, setChecking] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const location = useLocation();

  useEffect(() => {
    // Try to get email from URL params or local storage
    const params = new URLSearchParams(location.search);
    const email = params.get("email") || localStorage.getItem("cre_pending_email") || "";
    setUserEmail(email);

    checkStatus(email);
  }, [location.search]);

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
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center p-6">
        <div className="bg-[var(--surface)] rounded-[8px] shadow-[var(--shadow)] max-w-md w-full p-10 text-center">
          <div className="w-16 h-16 bg-[var(--success-soft)] rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-8 h-8 text-[var(--success)]" />
          </div>
          <h2 className="text-2xl font-bold text-[var(--ink)] mb-2">Access Approved!</h2>
          <p className="text-[var(--muted)] text-sm mb-6">
            Your access has been approved. Check your email for your sign-in link. Click the link in the email to get started.
          </p>
          <Button onClick={() => redirectToLogin()} className="w-full bg-[var(--ink)] hover:bg-[var(--ink)] h-11">
            Sign In Now
          </Button>
        </div>
      </div>
    );
  }

  if (status === "rejected") {
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center p-6">
        <div className="bg-[var(--surface)] rounded-[8px] shadow-[var(--shadow)] max-w-md w-full p-10 text-center">
          <div className="w-16 h-16 bg-[var(--danger-soft)] rounded-full flex items-center justify-center mx-auto mb-4">
            <Mail className="w-8 h-8 text-[var(--danger)]" />
          </div>
          <h2 className="text-2xl font-bold text-[var(--ink)] mb-2">Request Not Approved</h2>
          <p className="text-[var(--muted)] text-sm mb-6">
            Unfortunately your request was not approved at this time. Please reach out to us if you believe this is an error.
          </p>
          <div className="bg-[var(--bg)] rounded-[8px] p-4 text-left mb-6">
            <p className="text-xs font-semibold text-[var(--muted)] mb-1">Contact Us</p>
            <p className="text-sm text-[var(--muted)]">📧 support@creplatform.io</p>
            <p className="text-sm text-[var(--muted)]">📞 +1 (800) 555-0199</p>
          </div>
          <Button variant="outline" onClick={() => window.location.href = "/"} className="w-full">
            Back to Home
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center p-6">
      <div className="bg-[var(--surface)] rounded-[8px] shadow-[var(--shadow)] max-w-md w-full p-10 text-center">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-10 h-10 bg-[var(--ink)] rounded-[8px] flex items-center justify-center">
            <Building2 className="w-6 h-6 text-white" />
          </div>
          <span className="text-[var(--ink)] font-bold text-xl tracking-tight">CRE PLATFORM</span>
        </div>

        {/* Status */}
        <div className="w-20 h-20 bg-[var(--warning-soft)] rounded-full flex items-center justify-center mx-auto mb-6">
          <Clock className="w-10 h-10 text-[var(--warning)]" />
        </div>
        <h2 className="text-2xl font-bold text-[var(--ink)] mb-2">Request Under Review</h2>
        <p className="text-[var(--muted)] text-sm mb-2">
          Thank you for your interest in CRE Platform! Your access request has been submitted and is pending review by our team.
        </p>
        {userEmail && (
          <p className="text-xs text-[var(--muted)] mb-6">
            Submitted for: <span className="font-medium text-[var(--muted)]">{userEmail}</span>
          </p>
        )}

        <div className="bg-[var(--accent-soft)] border border-[var(--border-cre)] rounded-[8px] p-4 text-left mb-6">
          <p className="text-xs font-semibold text-[var(--accent)] mb-2">What happens next?</p>
          <ul className="space-y-1.5">
            <li className="flex items-start gap-2 text-xs text-[var(--accent)]">
              <span className="w-4 h-4 bg-[var(--accent-soft)] rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">1</span>
              Our team reviews your application (within 24–48 hours)
            </li>
            <li className="flex items-start gap-2 text-xs text-[var(--accent)]">
              <span className="w-4 h-4 bg-[var(--accent-soft)] rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">2</span>
              You'll receive an email with your sign-in link if approved
            </li>
            <li className="flex items-start gap-2 text-xs text-[var(--accent)]">
              <span className="w-4 h-4 bg-[var(--accent-soft)] rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">3</span>
              Complete company onboarding, sign MSA, and set up billing
            </li>
            <li className="flex items-start gap-2 text-xs text-[var(--accent)]">
              <span className="w-4 h-4 bg-[var(--accent-soft)] rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">4</span>
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

        <div className="mt-4 pt-4 border-t border-[var(--border-cre)]">
          <p className="text-xs text-[var(--muted)]">Questions? Contact us at</p>
          <a href="mailto:support@creplatform.io" className="text-xs text-[var(--accent)] font-medium hover:underline">
            support@creplatform.io
          </a>
        </div>
      </div>
    </div>
  );
}