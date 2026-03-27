import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Lock, Eye, EyeOff, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/services/supabaseClient";
import { createPageUrl } from "@/utils";

export default function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  // Wait for Supabase to process the recovery token from the URL
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setSessionReady(true);
      }
    });

    // Also check if a session already exists (direct navigation)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setSessionReady(true);
    });

    return () => subscription?.unsubscribe();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    const hasUpper = /[A-Z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);
    if (!hasUpper || !hasNumber || !hasSpecial) {
      setError("Password must include an uppercase letter, a number, and a special character.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setSuccess(true);
      // Sign out so they log in fresh (MFA will be required)
      await supabase.auth.signOut();
      setTimeout(() => navigate(createPageUrl("Login")), 2500);
    } catch (err) {
      setError(err.message || "Failed to update password.");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 flex flex-col">
      {/* Top Bar */}
      <div className="px-6 py-5 flex items-center max-w-6xl mx-auto w-full">
        <a href={createPageUrl("Landing")} className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-[#1a2744] rounded-lg flex items-center justify-center">
            <Building2 className="w-4 h-4 text-white" />
          </div>
          <span className="text-[#1a2744] font-bold text-lg tracking-tight">CRE Platform</span>
        </a>
      </div>

      <div className="flex-1 flex items-center justify-center px-4 pb-16">
        <div className="max-w-[420px] w-full">
          {success ? (
            <div className="text-center">
              <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-emerald-100 flex items-center justify-center">
                <CheckCircle2 className="w-10 h-10 text-emerald-600" />
              </div>
              <h2 className="text-2xl font-bold text-slate-900 mb-2">Password updated!</h2>
              <p className="text-slate-500 text-sm">Redirecting you to sign in with your new password…</p>
            </div>
          ) : (
            <>
              <div className="text-center mb-8">
                <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-blue-100 flex items-center justify-center">
                  <Lock className="w-7 h-7 text-blue-600" />
                </div>
                <h1 className="text-3xl font-bold text-slate-900 tracking-tight mb-2">Set new password</h1>
                <p className="text-slate-500 text-sm">Choose a strong password for your account.</p>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-8">
                {!sessionReady ? (
                  <div className="flex flex-col items-center py-6 gap-3">
                    <Loader2 className="w-7 h-7 animate-spin text-slate-400" />
                    <p className="text-slate-500 text-sm">Verifying your reset link…</p>
                  </div>
                ) : (
                  <form onSubmit={handleSubmit} className="space-y-5">
                    <div>
                      <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">New Password</Label>
                      <div className="relative mt-1.5">
                        <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <Input
                          type={showPassword ? "text" : "password"}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="Min 8 chars, uppercase, number, symbol"
                          className="h-11 pl-10 pr-10"
                          required
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    <div>
                      <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Confirm Password</Label>
                      <div className="relative mt-1.5">
                        <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <Input
                          type={showConfirm ? "text" : "password"}
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          placeholder="Repeat your new password"
                          className="h-11 pl-10 pr-10"
                          required
                        />
                        <button
                          type="button"
                          onClick={() => setShowConfirm(!showConfirm)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                          {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    {error && (
                      <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
                        <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                        <p className="text-red-600 text-sm">{error}</p>
                      </div>
                    )}

                    <Button
                      type="submit"
                      disabled={loading}
                      className="w-full h-11 bg-[#1a2744] hover:bg-[#243b67] font-semibold"
                    >
                      {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                      {loading ? "Updating…" : "Update Password"}
                    </Button>

                    <p className="text-center text-sm text-slate-500">
                      <button type="button" onClick={() => navigate(createPageUrl("Login"))} className="text-blue-600 hover:underline font-medium">
                        Back to Sign In
                      </button>
                    </p>
                  </form>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
