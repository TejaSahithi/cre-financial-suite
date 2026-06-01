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
 *                   + "Show QR" toggle to re-enroll if user lost access to their app
 *
 * Once aal2 is reached, calls onVerified() to proceed into the app.
 */
export default function MFAGuard({ onVerified }) {
  const [phase, setPhase] = useState("loading"); // loading | enroll | challenge | session_error
  const [factorId, setFactorId] = useState(null);
  const [qrCode, setQrCode] = useState(null);
  const [secret, setSecret] = useState(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [showQrOnChallenge, setShowQrOnChallenge] = useState(false);
  const [resetting, setResetting] = useState(false);

  const isInitializing = React.useRef(false);

  useEffect(() => {
    if (isInitializing.current) return;
    initialize();
  }, []);

  const initialize = async () => {
    if (isInitializing.current) return;
    isInitializing.current = true;
    try {
      // Guard: if there's no valid session, redirect to login immediately
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData?.session) {
        setPhase("session_error");
        return;
      }

      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;

      const totpFactors = data?.totp || [];
      const verifiedFactor = totpFactors.find(f => f.status === "verified");
      const unverifiedFactors = totpFactors.filter(f => f.status === "unverified");

      if (import.meta.env.DEV) console.log("[MFAGuard] Initializing factors:", { verified: !!verifiedFactor, unverifiedCount: unverifiedFactors.length });

      if (verifiedFactor) {
        setFactorId(verifiedFactor.id);
        setPhase("challenge");
      } else {
        // Always clean up unverified factors before starting fresh
        if (unverifiedFactors.length > 0) {
          await cleanupUnverifiedFactors(unverifiedFactors);
        }
        setPhase("enroll");
        await startEnrollment();
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error("[MFAGuard] initialize error:", err);
      setError(err.message || "Failed to initialize security.");
    } finally {
      isInitializing.current = false;
    }
  };

  const cleanupUnverifiedFactors = async (factors) => {
    if (import.meta.env.DEV) console.log(`[MFAGuard] Cleaning up ${factors.length} unverified factors...`);
    for (const f of factors) {
      await supabase.auth.mfa.unenroll({ factorId: f.id }).catch(e => {
        if (import.meta.env.DEV) console.warn("[MFAGuard] Cleanup failed for:", f.id, e);
      });
    }
    // Small delay to ensure Supabase DB propagates the deletions
    await new Promise(resolve => setTimeout(resolve, 500));
  };

  const startEnrollment = async () => {
    setEnrolling(true);
    setError("");
    try {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        issuer: "CRE Suite",
        friendlyName: `Auth_${Date.now().toString().slice(-4)}`
      });

      if (error) {
        // Fallback: If enrollment fails because a factor was just created/exists
        if (error.message?.includes("Maximum number of verified factors") || error.status === 422) {
          const { data: listData } = await supabase.auth.mfa.listFactors();
          const verified = listData?.totp?.find(f => f.status === "verified");
          if (verified) {
            setFactorId(verified.id);
            setPhase("challenge");
            return;
          }
          // No verified factor visible at aal1 but max is reached
          throw new Error("Maximum number of factors reached but none are verified. Please contact support to reset your 2FA.");
        }
        throw error;
      }

      setFactorId(data.id);
      setQrCode(data.totp.qr_code);
      setSecret(data.totp.secret);
    } catch (err) {
      if (import.meta.env.DEV) console.error("[MFAGuard] Enrollment error:", err);
      setError(err.message || "Enrollment failed. Please refresh.");
    } finally {
      setEnrolling(false);
    }
  };

  const handleVerify = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    if (!code || code.length !== 6) {
      setError("Please enter your 6-digit code.");
      return;
    }
    setVerifying(true);
    setError("");

    try {
      if (!factorId) {
        throw new Error("Factor ID is missing. Please refresh the page.");
      }
      
      const { data, error } = await supabase.auth.mfa.challengeAndVerify({
        factorId,
        code,
      });
      
      if (error) {
        throw error;
      }

      // Refresh session to get aal2
      await supabase.auth.refreshSession();
      if (onVerified) onVerified();
    } catch (err) {
      if (import.meta.env.DEV) console.error("[MFAGuard] verify error:", err);
      setError(err.message === "Invalid TOTP code entered" || err.message?.includes("TOTP code")
        ? "Incorrect code. Please check your Authenticator app."
        : err.message || "Verification failed. Please try again.");
      
      // Auto-recover if the factor was mysteriously lost or expired
      if (err.message?.includes("Factor not found") || err.status === 404) {
        if (import.meta.env.DEV) console.warn("[MFAGuard] Factor not found! Auto-generating a new QR code...");
        setError("Your setup session expired. Generating a new QR code...");
        setFactorId(null);
        setQrCode(null);
        setPhase("enroll");
        startEnrollment();
      } else {
        setCode("");
      }
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

  if (phase === "session_error") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 flex items-center justify-center px-4">
        <div className="max-w-sm w-full text-center bg-white rounded-2xl border border-slate-200 shadow-sm p-8">
          <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-7 h-7 text-red-500" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">Session Expired</h2>
          <p className="text-slate-500 text-sm mb-6">
            Your session has expired or the link you used is no longer valid. Please sign in again to continue.
          </p>
          <Button
            className="w-full bg-[#1a2744] hover:bg-[#243460] text-white font-semibold rounded-xl h-11"
            onClick={() => { supabase.auth.signOut().finally(() => { window.location.href = '/Login'; }); }}
          >
            Sign In Again
          </Button>
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
            {/* ── ENROLL phase: QR code steps ── */}
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
                      <div className="flex-1">
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
                  <div className="text-center py-6 space-y-3">
                    <p className="text-sm text-red-500">
                      {error?.includes("Maximum number") ? "Maximum number of verified factors reached, unenroll to continue" : (error || "Failed to generate QR code.")}
                    </p>
                    <p className="text-xs text-slate-400">This can happen if a previous setup was interrupted. Click below to try again.</p>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={resetting}
                      onClick={error?.includes("Maximum number") ? handleResetAndShowQR : startEnrollment}
                      className="w-full"
                    >
                      {resetting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                      {resetting ? "Resetting..." : "Refresh QR Code"}
                    </Button>
                  </div>
                )}

                {/* Verification form for ENROLL phase */}
                {qrCode && (
                  <form onSubmit={handleVerify} className="space-y-4 mt-5 pt-5 border-t border-slate-100">
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
                      className="text-center text-2xl font-mono h-14 tracking-[0.5em]"
                      autoComplete="one-time-code"
                    />

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
                      {verifying ? "Verifying..." : "Complete Setup"}
                    </Button>
                  </form>
                )}
              </>
            )}

            {/* ── CHALLENGE phase: code input + QR re-scan option ── */}
            {phase === "challenge" && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 bg-blue-50 rounded-xl p-3">
                  <Smartphone className="w-4 h-4 text-blue-600 flex-shrink-0" />
                  <p className="text-xs text-blue-700">Open your Authenticator app and enter the current 6-digit code for <strong>CRE Suite</strong>.</p>
                </div>

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
                  onKeyDown={(e) => { if (e.key === "Enter") handleVerify(e); }}
                  className="text-center text-2xl font-mono h-14 tracking-[0.5em]"
                  autoComplete="one-time-code"
                  autoFocus
                />

                {error && (
                  <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 rounded-lg p-3">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    {error}
                  </div>
                )}

                <Button
                  onClick={handleVerify}
                  className="w-full h-12 bg-[#1a2744] hover:bg-[#243b67] gap-2"
                  disabled={verifying || code.length !== 6}
                >
                  {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  {verifying ? "Verifying..." : "Verify & Sign In"}
                </Button>

                <div className="mt-6 text-center">
                  <p className="text-sm text-slate-500">
                    Can’t access your authenticator? <br />
                    Contact your administrator or support to reset MFA.
                  </p>
                </div>
              </div>
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
