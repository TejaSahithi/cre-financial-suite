import React, { useState } from "react";
import { Shield, KeyRound, ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createPageUrl } from "@/utils";
import { useAuth } from "@/lib/AuthContext";
import { updateProfile } from "@/services/auth";
import { supabase } from "@/services/supabaseClient";

export default function Welcome() {
  const { user, refreshProfile } = useAuth();
  const firstName = user?.full_name?.split(" ")[0] || "there";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleResetPassword = async (e) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);
    try {
      // 1. Update the user's password securely
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;

      // 2. Mark first_login as false
      const profileUpdates = { first_login: false };

      // 3. If an invited user, jump them straight to active
      if (user?.profile?.onboarding_type === 'invited') {
        profileUpdates.status = 'active';
        profileUpdates.onboarding_complete = true;
      }

      await updateProfile(profileUpdates);
      await refreshProfile();
      
      // 4. Navigate out!
      // If onboarding is already finished, go to Dashboard. Otherwise go to Onboarding.
      const isOwner = user?.profile?.onboarding_type !== 'invited';
      const needsOnboarding = isOwner && !user?.profile?.onboarding_complete;
      
      console.log('[Welcome] Password reset complete, navigating to:', needsOnboarding ? 'Onboarding' : 'Dashboard');
      
      window.location.href = createPageUrl(needsOnboarding ? 'Onboarding' : 'Dashboard');
    } catch (err) {
      console.error("[Welcome] Reset Password Error:", err);
      setError(err.message || "An error occurred while saving your new password.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] flex flex-col items-center justify-center p-4">
      
      <div className="max-w-md w-full">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="w-16 h-16 bg-[var(--accent-soft)] rounded-[8px] flex items-center justify-center mx-auto mb-5 border border-[var(--border-cre)]">
            <KeyRound className="w-8 h-8 text-[var(--accent)]" />
          </div>
          <h1 className="text-[28px] font-bold text-[var(--ink)] tracking-tight mb-2">
            Welcome, {firstName}!
          </h1>
          <p className="text-[var(--muted)] text-[15px] px-4">
            For your security, please change your temporary password to something only you know.
          </p>
        </div>

        {/* Reset Form */}
        <Card className="border-[var(--border-cre)] shadow-[var(--shadow-soft)] shadow-slate-200/40 rounded-[8px] overflow-hidden">
          <CardContent className="p-8">
            <form onSubmit={handleResetPassword} className="space-y-5">
              
              {error && (
                <div className="bg-[var(--danger-soft)] text-[var(--danger)] text-sm font-medium p-3 rounded-lg border border-[var(--border-cre)] flex items-start gap-2">
                  <div className="mt-0.5 mt-0.5 shrink-0 px-0.5">⚠️</div>
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="password" className="text-[var(--muted)] font-semibold">New Password</Label>
                  <Input 
                    id="password" 
                    type="password" 
                    placeholder="Enter new password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-11 bg-[var(--surface-2)]"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword" className="text-[var(--muted)] font-semibold">Confirm Password</Label>
                  <Input 
                    id="confirmPassword" 
                    type="password" 
                    placeholder="Confirm new password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="h-11 bg-[var(--surface-2)]"
                  />
                </div>
              </div>

              <div className="pt-2">
                <Button 
                  type="submit" 
                  disabled={loading || !password || !confirmPassword} 
                  className="w-full h-11 bg-[var(--accent)] hover:bg-[var(--accent)] text-white font-semibold rounded-[8px]"
                >
                  {loading ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving Password...</>
                  ) : (
                    <>Save & Continue <ArrowRight className="w-4 h-4 ml-2" /></>
                  )}
                </Button>
              </div>

            </form>
          </CardContent>
        </Card>

        {/* Security Notice */}
        <div className="mt-8 flex items-center justify-center gap-2 text-[var(--muted)]">
          <Shield className="w-4 h-4" />
          <span className="text-xs font-medium uppercase tracking-widest">Secure Login Portal</span>
        </div>
      </div>

    </div>
  );
}
