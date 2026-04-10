/**
 * AcceptInvite.jsx
 * Landed on after clicking a Supabase magic-link invite email.
 * Steps: Set password → Complete profile → Continue to app (MFA handled by App.jsx)
 */
import React, { useState, useEffect } from "react";
import { Eye, EyeOff, Check, Loader2, User, Lock, ArrowRight, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/services/supabaseClient";
import { updateProfile } from "@/services/auth";
import { toast } from "sonner";

const STEPS = ["Set Password", "Your Profile", "All Set!"];

export default function AcceptInvite() {
  const [step, setStep] = useState(0);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [session, setSession] = useState(null);

  // Supabase auto-exchanges the hash token in the URL on page load
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data?.session) setSession(data.session);
    });

    // Listen for when Supabase exchanges the invite token
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      if (s) setSession(s);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const invitedName = session?.user?.user_metadata?.full_name || session?.user?.user_metadata?.name || "";
    if (invitedName && !fullName) {
      setFullName(invitedName);
    }
  }, [fullName, session]);

  const rules = [
    { label: "At least 8 characters", ok: password.length >= 8 },
    { label: "One uppercase letter",  ok: /[A-Z]/.test(password) },
    { label: "One number",            ok: /\d/.test(password) },
    { label: "Passwords match",       ok: password === confirm && confirm.length > 0 },
  ];
  const passwordValid = rules.every((r) => r.ok);

  const handleSetPassword = async () => {
    if (!passwordValid) return;
    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setStep(1);
    } catch (err) {
      toast.error("Failed to set password: " + (err.message || "Unknown error"));
    }
    setSaving(false);
  };

  const handleSaveProfile = async () => {
    setSaving(true);
    try {
      await updateProfile({
        full_name: fullName || undefined,
        status: "active",
        first_login: false,
        onboarding_complete: true,
        dashboard_viewed: false,
      });
      const membershipUpdate = supabase
        .from("memberships")
        .update(phone ? { phone, status: "active" } : { status: "active" })
        .eq("user_id", session?.user?.id);

      if (session?.user?.user_metadata?.org_id) {
        membershipUpdate.eq("org_id", session.user.user_metadata.org_id);
      }

      const { error: membershipError } = await membershipUpdate;
      if (membershipError) throw membershipError;
      setStep(2);
    } catch (err) {
      toast.error("Failed to save profile: " + (err.message || "Unknown error"));
    }
    setSaving(false);
  };

  const handleFinish = () => {
    window.location.href = "/WelcomeAboard";
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-[#1a2744] rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-900/20">
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <rect x="2" y="7" width="20" height="14" rx="2" />
              <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Welcome to CRE Suite</h1>
          <p className="text-slate-500 text-sm mt-1">Let's get your account set up</p>
        </div>

        {/* Org/Role Info */}
        {(session?.user?.user_metadata?.org_name || session?.user?.user_metadata?.role) && (
          <div className="mb-8 p-4 bg-blue-50/50 border border-blue-100 rounded-xl text-center animate-in fade-in slide-in-from-top-4 duration-700">
            <p className="text-sm text-slate-600">
              You've been invited to join <span className="font-bold text-blue-900">{session.user.user_metadata.org_name || "the organization"}</span>
            </p>
            <p className="text-xs text-slate-500 mt-0.5">
              as <span className="font-medium text-slate-700 capitalize">{(session.user.user_metadata.role || "team member").replaceAll("_", " ")}</span>
            </p>
          </div>
        )}

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {STEPS.map((s, i) => (
            <React.Fragment key={s}>
              <div className={`flex items-center gap-1.5 text-xs font-semibold ${i === step ? "text-blue-600" : i < step ? "text-emerald-600" : "text-slate-300"}`}>
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border-2 ${
                  i < step ? "bg-emerald-100 border-emerald-400 text-emerald-600"
                  : i === step ? "bg-blue-100 border-blue-400 text-blue-600"
                  : "bg-white border-slate-200 text-slate-300"
                }`}>
                  {i < step ? <Check className="w-3 h-3" /> : i + 1}
                </div>
                <span className="hidden sm:block">{s}</span>
              </div>
              {i < STEPS.length - 1 && <div className={`h-px w-8 ${i < step ? "bg-emerald-300" : "bg-slate-200"}`} />}
            </React.Fragment>
          ))}
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-7">
          {/* Step 0 — Set Password */}
          {step === 0 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <Lock className="w-4 h-4 text-slate-400" />
                <h2 className="font-bold text-slate-900">Create your password</h2>
              </div>
              <div>
                <Label>New Password</Label>
                <div className="relative mt-1">
                  <Input type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min. 8 characters" className="pr-10" />
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
                {rules.map((r) => (
                  <div key={r.label} className={`flex items-center gap-2 text-xs ${r.ok ? "text-emerald-600" : "text-slate-400"}`}>
                    <Check className={`w-3.5 h-3.5 ${r.ok ? "text-emerald-500" : "text-slate-200"}`} />
                    {r.label}
                  </div>
                ))}
              </div>
              <Button onClick={handleSetPassword} disabled={!passwordValid || saving} className="w-full h-11 bg-[#1a2744] hover:bg-[#243b67] mt-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Continue <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          )}

          {/* Step 1 — Profile */}
          {step === 1 && (
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
              <Button onClick={handleSaveProfile} disabled={saving} className="w-full h-11 bg-[#1a2744] hover:bg-[#243b67] mt-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Save & Continue <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          )}

          {/* Step 2 — Done */}
          {step === 2 && (
            <div className="text-center py-4 space-y-4">
              <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-9 h-9 text-emerald-600" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-900">You're all set!</h2>
                <p className="text-slate-500 text-sm mt-2">
                  Your account is ready. You'll be guided through setting up two-factor authentication next to keep your account secure.
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
