import React, { useState, useEffect } from "react";
import { supabase } from "@/services/supabaseClient";
import { Building2, Shield, Loader2, RefreshCw, Smartphone, Check, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * MFAGuard — Supabase TOTP MFA Interceptor
 *
 * Shown AFTER successful password login when the session is at aal1 (single factor).
 * Handles two states:
 *  1. ENROLLMENT — No TOTP factor enrolled yet → shows QR code to scan with Authenticator app
 *  2. CHALLENGE   — Factor already enrolled → prompts for 6-digit code
 *
 * Once aal2 is reached, calls onVerified() to proceed into the app.
 */
export default function MFAGuard({ onVerified }) {
  const [phase, setPhase] = useState("loading"); // loading | enroll | challenge
  const [factorId, setFactorId] = useState(null);
  const [qrCode, setQrCode] = useState(null);
  const [secret, setSecret] = useState(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [enrolling, setEnrolling] = useState(false);

  useEffect(() => {
    initialize();
  }, []);

  const initialize = async () => {
    try {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;

      const totpFactor = data?.totp?.[0];
      if (totpFactor && totpFactor.status === "verified") {
        // Factor already enrolled and verified — just need to challenge
        setFactorId(totpFactor.id);
        setPhase("challenge");
      } else {
        // No verified factor — need to enroll
        setPhase("enroll");
        await startEnrollment();
      }
    } catch (err) {
      console.error("[MFAGuard] initialize error:", err);
      setPhase("enroll");
    }
  };

  const startEnrollment = async () => {
    setEnrolling(true);
    setError("");
    try {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        issuer: "CRE Suite",
      });
      if (error) throw error;

      setFactorId(data.id);
      setQrCode(data.totp.qr_code);
      setSecret(data.totp.secret);
    } catch (err) {
      setError(err.message || "Failed to start enrollment. Please refresh.");
    } finally {
      setEnrolling(false);
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    if (!code || code.length !== 6) {
      setError("Please enter your 6-digit code.");
      return;
    }
    setVerifying(true);
    setError("");

    try {
      if (phase === "enroll") {
        // During enrollment — challengeAndVerify
        const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
        if (challengeError) throw challengeError;

        const { error: verifyError } = await supabase.auth.mfa.verify({
          factorId,
          challengeId: challengeData.id,
          code,
        });
        if (verifyError) throw verifyError;
      } else {
        // Challenge existing factor
        const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
        if (challengeError) throw challengeError;

        const { error: verifyError } = await supabase.auth.mfa.verify({
          factorId,
          challengeId: challengeData.id,
          code,
        });
        if (verifyError) throw verifyError;
      }

      // Refresh session to get aal2
      await supabase.auth.refreshSession();
      if (onVerified) onVerified();
    } catch (err) {
      console.error("[MFAGuard] verify error:", err);
      setError(err.message === "Invalid TOTP code entered"
        ? "Incorrect code. Please check your Authenticator app."
        : err.message || "Verification failed. Please try again.");
      setCode("");
    } finally {
      setVerifying(false);
    }
  };

  if (phase === "loading") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-slate-400 mx-auto mb-3" />
          <p className="text-sm text-slate-500">Setting up security...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 flex flex-col">
      {/* Header */}
      <div className="px-6 py-5 max-w-6xl mx-auto w-full">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-[#1a2744] rounded-lg flex items-center justify-center">
            <Building2 className="w-4 h-4 text-white" />
          </div>
          <span className="text-[#1a2744] font-bold text-lg tracking-tight">CRE Suite</span>
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 flex items-center justify-center px-4 pb-16">
        <div className="max-w-md w-full">
          {/* Icon header */}
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Shield className="w-8 h-8 text-blue-600" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">
              {phase === "enroll" ? "Set Up Two-Factor Authentication" : "Enter Verification Code"}
            </h1>
            <p className="text-slate-500 text-sm">
              {phase === "enroll"
                ? "Scan the QR code with your Authenticator app to add an extra layer of security."
                : "Open your Authenticator app and enter the 6-digit code for CRE Suite."}
            </p>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-8">
            {phase === "enroll" && (
              <>
                {enrolling ? (
                  <div className="flex flex-col items-center py-8">
                    <Loader2 className="w-8 h-8 animate-spin text-slate-400 mb-3" />
                    <p className="text-sm text-slate-500">Generating QR code...</p>
                  </div>
                ) : qrCode ? (
                  <div className="space-y-5">
                    {/* Step 1 */}
                    <div className="flex items-start gap-3">
                      <div className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold flex-shrink-0 mt-0.5">1</div>
                      <div>
                        <p className="text-sm font-semibold text-slate-800">Download an Authenticator App</p>
                        <p className="text-xs text-slate-500 mt-0.5">Google Authenticator, Authy, or Microsoft Authenticator</p>
                      </div>
                    </div>
                    {/* Step 2 */}
                    <div className="flex items-start gap-3">
                      <div className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold flex-shrink-0 mt-0.5">2</div>
                      <div>
                        <p className="text-sm font-semibold text-slate-800">Scan This QR Code</p>
                        <div className="mt-3 flex flex-col items-center bg-slate-50 rounded-xl p-4 border border-slate-200">
                          <img src={qrCode} alt="TOTP QR Code" className="w-44 h-44" />
                          {secret && (
                            <div className="mt-3 w-full">
                              <p className="text-[10px] text-slate-400 text-center mb-1">Or enter manually:</p>
                              <code className="block text-xs text-center text-slate-600 bg-slate-100 rounded px-2 py-1 font-mono break-all">{secret}</code>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    {/* Step 3 */}
                    <div className="flex items-start gap-3">
                      <div className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold flex-shrink-0 mt-0.5">3</div>
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-slate-800">Enter the 6-Digit Code</p>
                        <p className="text-xs text-slate-500 mt-0.5">Enter the code shown in your app to complete setup</p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-6">
                    <p className="text-sm text-red-500 mb-3">{error || "Failed to generate QR code."}</p>
                    <Button variant="outline" size="sm" onClick={startEnrollment}><RefreshCw className="w-4 h-4 mr-2" />Retry</Button>
                  </div>
                )}
              </>
            )}

            {/* Verification form - shown for both enroll and challenge */}
            {(phase === "challenge" || (phase === "enroll" && qrCode)) && (
              <form onSubmit={handleVerify} className={`space-y-4 ${phase === "enroll" ? "mt-5 pt-5 border-t border-slate-100" : ""}`}>
                {phase === "challenge" && (
                  <div className="flex items-center gap-2 bg-blue-50 rounded-xl p-3 mb-2">
                    <Smartphone className="w-4 h-4 text-blue-600 flex-shrink-0" />
                    <p className="text-xs text-blue-700">Open your Authenticator app and enter the current 6-digit code for <strong>CRE Suite</strong>.</p>
                  </div>
                )}
                <div>
                  <Input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="000000"
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value.replace(/\D/g, "").substring(0, 6));
                      setError("");
                    }}
                    className="text-center text-2xl font-mono h-14 tracking-[0.5em] letter-spacing-wide"
                    autoComplete="one-time-code"
                  />
                </div>

                {error && (
                  <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 rounded-lg p-3">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    {error}
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full h-12 bg-[#1a2744] hover:bg-[#243b67] gap-2"
                  disabled={verifying || code.length !== 6}
                >
                  {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  {verifying ? "Verifying..." : phase === "enroll" ? "Complete Setup" : "Verify & Sign In"}
                </Button>
              </form>
            )}
          </div>

          <p className="text-center text-[11px] text-slate-400 mt-4">
            Protected by enterprise-grade two-factor authentication.
          </p>
        </div>
      </div>
    </div>
  );
}
