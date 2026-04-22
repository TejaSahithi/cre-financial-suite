/**
 * AcceptInvite.jsx
 * Enterprise invite flow:
 * 1. Verify the invite callback and establish a session
 * 2. Let the user set their password
 * 3. Complete their profile
 * 4. Continue into the secured app flow
 */
import React, { useEffect, useState } from "react";
import { Eye, EyeOff, Check, Loader2, User, Lock, ArrowRight, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/services/supabaseClient";
import { updateProfile } from "@/services/auth";
import { toast } from "sonner";

const STEPS = ["Verify Invite", "Set Password", "Your Profile", "All Set!"];
const OTP_TYPES = new Set(["invite", "recovery", "email", "signup", "magiclink"]);

function cleanupAuthUrl() {
  const url = new URL(window.location.href);
  ["code", "token_hash", "type", "next", "redirect_to"].forEach((key) => {
    url.searchParams.delete(key);
  });
  url.hash = "";
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}`);
}

function getHashParams() {
  return new URLSearchParams(window.location.hash.replace(/^#/, ""));
}

export default function AcceptInvite() {
  const [step, setStep] = useState(0);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [session, setSession] = useState(null);
  const [isVerifyingInvite, setIsVerifyingInvite] = useState(true);
  const [inviteError, setInviteError] = useState("");

  useEffect(() => {
    let cancelled = false;

    const resolveInviteSession = async () => {
      if (!supabase) {
        if (!cancelled) {
          setInviteError("Authentication is not configured for this environment.");
          setIsVerifyingInvite(false);
        }
        return;
      }

      setInviteError("");
      setIsVerifyingInvite(true);

      try {
        let activeSession = null;
        const searchParams = new URLSearchParams(window.location.search);
        const hashParams = getHashParams();

        const sessionResult = await supabase.auth.getSession();
        activeSession = sessionResult.data?.session || null;

        if (!activeSession) {
          const code = searchParams.get("code");
          if (code) {
            const { data, error } = await supabase.auth.exchangeCodeForSession(code);
            if (error) throw error;
            activeSession = data?.session || null;
          }
        }

        if (!activeSession) {
          const tokenHash = searchParams.get("token_hash") || hashParams.get("token_hash");
          const type = searchParams.get("type") || hashParams.get("type");

          if (tokenHash && type && OTP_TYPES.has(type)) {
            const { data, error } = await supabase.auth.verifyOtp({
              token_hash: tokenHash,
              type,
            });
            if (error) throw error;
            activeSession = data?.session || null;
          }
        }

        if (!activeSession) {
          const accessToken = hashParams.get("access_token");
          const refreshToken = hashParams.get("refresh_token");

          if (accessToken && refreshToken) {
            const { data, error } = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            });
            if (error) throw error;
            activeSession = data?.session || null;
          }
        }

        if (!activeSession) {
          const retrySession = await supabase.auth.getSession();
          activeSession = retrySession.data?.session || null;
        }

        if (!activeSession) {
          throw new Error("This invite link could not be verified. Please request a new invite.");
        }

        if (!cancelled) {
          setSession(activeSession);
          cleanupAuthUrl();
          setStep((currentStep) => (currentStep === 0 ? 1 : currentStep));
        }
      } catch (err) {
        const message = err?.message || "This invite link could not be verified. Please request a new invite.";
        if (!cancelled) {
          setInviteError(message);
        }
      } finally {
        if (!cancelled) {
          setIsVerifyingInvite(false);
        }
      }
    };

    resolveInviteSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (cancelled) return;
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "INITIAL_SESSION") {
        if (nextSession) {
          setSession(nextSession);
          setInviteError("");
          setIsVerifyingInvite(false);
          setStep((currentStep) => (currentStep === 0 ? 1 : currentStep));
        }
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const invitedName = session?.user?.user_metadata?.full_name || session?.user?.user_metadata?.name || "";
    if (invitedName && !fullName) {
      setFullName(invitedName);
    }
  }, [fullName, session]);

  const rules = [
    { label: "At least 8 characters", ok: password.length >= 8 },
    { label: "One uppercase letter", ok: /[A-Z]/.test(password) },
    { label: "One number", ok: /\d/.test(password) },
    { label: "Passwords match", ok: password === confirm && confirm.length > 0 },
  ];
  const passwordValid = rules.every((rule) => rule.ok);

  const handleSetPassword = async () => {
    if (!session) {
      toast.error("Invite session not ready. Please wait for verification to finish.");
      return;
    }

    if (!passwordValid) return;

    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setStep(2);
    } catch (err) {
      toast.error(`Failed to set password: ${err.message || "Unknown error"}`);
    }
    setSaving(false);
  };

  const handleSaveProfile = async () => {
    if (!session) {
      toast.error("Invite session not ready. Please refresh the page.");
      return;
    }

    setSaving(true);
    try {
      await updateProfile({
        full_name: fullName || undefined,
        phone: phone || undefined,
        status: "active",
        first_login: false,
        onboarding_complete: true,
        dashboard_viewed: false,
      });

      const membershipUpdate = supabase
        .from("memberships")
        .update(phone ? { phone, status: "active" } : { status: "active" })
        .eq("user_id", session.user.id);

      if (session.user.user_metadata?.org_id) {
        membershipUpdate.eq("org_id", session.user.user_metadata.org_id);
      }

      const { error: membershipError } = await membershipUpdate;
      if (membershipError) throw membershipError;

      const invitationUpdate = supabase
        .from("invitations")
        .update({ status: "accepted", updated_at: new Date().toISOString() })
        .eq("email", session.user.email)
        .in("status", ["pending", "pending_approval"]);

      if (session.user.user_metadata?.org_id) {
        invitationUpdate.eq("org_id", session.user.user_metadata.org_id);
      }

      const { error: invitationError } = await invitationUpdate;
      if (invitationError) console.warn("[AcceptInvite] invitation status update failed:", invitationError.message);

      setStep(3);
    } catch (err) {
      toast.error(`Failed to save profile: ${err.message || "Unknown error"}`);
    }
    setSaving(false);
  };

  const handleFinish = () => {
    window.location.href = "/WelcomeAboard";
  };

  const currentStepForIndicator = isVerifyingInvite ? 0 : step;

  if (isVerifyingInvite) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-100">
            <Loader2 className="h-7 w-7 animate-spin text-blue-600" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Verifying your invite</h1>
          <p className="mt-2 text-sm text-slate-500">
            We&apos;re securely validating your invitation and creating your sign-in session before setup begins.
          </p>
        </div>
      </div>
    );
  }

  if (inviteError) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-100">
            <AlertCircle className="h-7 w-7 text-red-600" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Invite link could not be verified</h1>
          <p className="mt-2 text-sm text-slate-500">{inviteError}</p>
          <div className="mt-6 space-y-3">
            <Button className="w-full bg-[#1a2744] hover:bg-[#243b67]" onClick={() => window.location.reload()}>
              Retry Verification
            </Button>
            <Button variant="outline" className="w-full" onClick={() => { window.location.href = "/Login"; }}>
              Go to Login
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-[#1a2744] rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-900/20">
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <rect x="2" y="7" width="20" height="14" rx="2" />
              <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Welcome to CRE Suite</h1>
          <p className="text-slate-500 text-sm mt-1">Let&apos;s get your invited account ready</p>
        </div>

        {(session?.user?.user_metadata?.org_name || session?.user?.user_metadata?.role) && (
          <div className="mb-8 p-4 bg-blue-50/50 border border-blue-100 rounded-xl text-center animate-in fade-in slide-in-from-top-4 duration-700">
            <p className="text-sm text-slate-600">
              You&apos;ve been invited to join <span className="font-bold text-blue-900">{session.user.user_metadata.org_name || "the organization"}</span>
            </p>
            <p className="text-xs text-slate-500 mt-0.5">
              as <span className="font-medium text-slate-700 capitalize">{(session.user.user_metadata.role || "team member").replaceAll("_", " ")}</span>
            </p>
          </div>
        )}

        <div className="flex items-center justify-center gap-2 mb-8">
          {STEPS.map((label, index) => (
            <React.Fragment key={label}>
              <div className={`flex items-center gap-1.5 text-xs font-semibold ${index === currentStepForIndicator ? "text-blue-600" : index < currentStepForIndicator ? "text-emerald-600" : "text-slate-300"}`}>
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border-2 ${
                  index < currentStepForIndicator
                    ? "bg-emerald-100 border-emerald-400 text-emerald-600"
                    : index === currentStepForIndicator
                    ? "bg-blue-100 border-blue-400 text-blue-600"
                    : "bg-white border-slate-200 text-slate-300"
                }`}>
                  {index < currentStepForIndicator ? <Check className="w-3 h-3" /> : index + 1}
                </div>
                <span className="hidden sm:block">{label}</span>
              </div>
              {index < STEPS.length - 1 && (
                <div className={`h-px w-8 ${index < currentStepForIndicator ? "bg-emerald-300" : "bg-slate-200"}`} />
              )}
            </React.Fragment>
          ))}
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-7">
          {step === 1 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <Lock className="w-4 h-4 text-slate-400" />
                <h2 className="font-bold text-slate-900">Create your password</h2>
              </div>
              <div>
                <Label>New Password</Label>
                <div className="relative mt-1">
                  <Input
                    type={showPw ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    className="pr-10"
                  />
                  <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div>
                <Label>Confirm Password</Label>
                <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat password" className="mt-1" />
              </div>
              <div className="space-y-1.5 pt-1">
                {rules.map((rule) => (
                  <div key={rule.label} className={`flex items-center gap-2 text-xs ${rule.ok ? "text-emerald-600" : "text-slate-400"}`}>
                    <Check className={`w-3.5 h-3.5 ${rule.ok ? "text-emerald-500" : "text-slate-200"}`} />
                    {rule.label}
                  </div>
                ))}
              </div>
              <Button onClick={handleSetPassword} disabled={!passwordValid || saving || !session} className="w-full h-11 bg-[#1a2744] hover:bg-[#243b67] mt-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Continue <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <User className="w-4 h-4 text-slate-400" />
                <h2 className="font-bold text-slate-900">Complete your profile</h2>
              </div>
              <div>
                <Label>Full Name</Label>
                <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your full name" className="mt-1" />
              </div>
              <div>
                <Label>Phone Number <span className="text-slate-400 font-normal">(optional)</span></Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 (555) 000-0000" className="mt-1" />
              </div>
              <Button onClick={handleSaveProfile} disabled={saving || !session} className="w-full h-11 bg-[#1a2744] hover:bg-[#243b67] mt-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Save & Continue <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          )}

          {step === 3 && (
            <div className="text-center py-4 space-y-4">
              <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-9 h-9 text-emerald-600" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-900">You&apos;re all set!</h2>
                <p className="text-slate-500 text-sm mt-2">
                  Your account is secure and ready. Next you&apos;ll continue into the protected welcome flow for your assigned workspace.
                </p>
              </div>
              <Button onClick={handleFinish} className="w-full h-11 bg-[#1a2744] hover:bg-[#243b67]">
                Enter CRE Suite <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-slate-400 mt-6">
          Secure invite link · single-use · expires in 24 hours
        </p>
      </div>
    </div>
  );
}
