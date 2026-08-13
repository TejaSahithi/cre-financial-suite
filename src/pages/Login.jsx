import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Loader2, Mail, ArrowRight, AlertCircle, Lock, Eye, EyeOff, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createPageUrl } from "@/utils";
import { useAuth } from "@/lib/AuthContext";
import { supabase } from "@/services/supabaseClient";
import { verifyAccessRequest } from "@/services/api";
import { toast } from "sonner";
import ProFormaBrand from "@/components/ProFormaBrand";

async function getFunctionErrorMessage(fnError) {
  if (!fnError) return "";

  let detail = fnError.message || "";
  try {
    const ctx = fnError.context;
    if (ctx && typeof ctx.json === "function") {
      const body = await ctx.json();
      if (body?.error) detail = body.error;
    }
  } catch {
    // Ignore body parse failures and keep the top-level message.
  }

  return detail;
}

function resolveSignupOnboardingType(verifiedRole) {
  const normalizedRole = String(verifiedRole || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  const explicitOwnerRoles = new Set([
    "admin",
    "org_admin",
    "super_admin",
    "owner",
    "landlord",
    "organization_owner",
    "admin_(landlord)",
    "landlord_admin",
    "admin_landlord",
  ]);

  if (explicitOwnerRoles.has(normalizedRole)) return "owner";
  if (normalizedRole.startsWith("admin_") || normalizedRole.endsWith("_admin")) return "owner";
  if (normalizedRole.includes("owner")) return "owner";
  return "member";
}

function getSafeReturnUrl() {
  const returnUrl = new URLSearchParams(window.location.search).get("returnUrl");
  if (!returnUrl || !returnUrl.startsWith("/") || returnUrl.startsWith("//")) return "/";
  return returnUrl;
}

export default function Login() {
  const navigate = useNavigate();
  const { login, loginWithGoogle } = useAuth();

  const [view, setView] = useState("login"); // "login" | "create"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Registration specifics
  const [fullName, setFullName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verifiedCompany, setVerifiedCompany] = useState(null);
  const [verifiedRole, setVerifiedRole] = useState(null);
  const [verifiedOnboardingType, setVerifiedOnboardingType] = useState(null);
  const [isValidatingEmail, setIsValidatingEmail] = useState(false);
  const [registrationSuccess, setRegistrationSuccess] = useState(false);
  const [confirmationRequired, setConfirmationRequired] = useState(false);
  const [resentConfirmation, setResentConfirmation] = useState(false);
  const [registrationFlow, setRegistrationFlow] = useState("signup");

  const resetForm = () => {
    setError("");
    setPassword("");
    setConfirmPassword("");
    setFullName("");
    setEmail("");
    setVerifiedCompany(null);
    setVerifiedRole(null);
    setVerifiedOnboardingType(null);
    setConfirmationRequired(false);
    setResentConfirmation(false);
    setRegistrationFlow("signup");
  };

  const handleEmailLogin = async (e) => {
    e.preventDefault();
    if (!email) { setError("Please enter your email."); return; }
    if (!password) { setError("Please enter your password."); return; }

    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate(getSafeReturnUrl());
    } catch (err) {
      console.error("[DEBUG LOGIN ERROR]:", err);
      setError(err.message || "Invalid email or password.");
    }
    setLoading(false);
  };



  const validateApprovedEmail = async (emailToCheck) => {
    if (!emailToCheck) {
      setVerifiedCompany(null);
      setVerifiedRole(null);
      setVerifiedOnboardingType(null);
      return false;
    }

    setIsValidatingEmail(true);
    setError("");
    try {
      const res = await verifyAccessRequest(emailToCheck);
      if (res && res.valid) {
        setVerifiedCompany(res.company_name);
        setVerifiedRole(res.role || "Admin (Owner)");
        setVerifiedOnboardingType(res.onboarding_type || null);
        setIsValidatingEmail(false);
        return true;
      } else {
        setVerifiedCompany(null);
        setVerifiedRole(null);
        setVerifiedOnboardingType(null);
        setError(res?.message || "Your email is not approved for account creation.");
        setIsValidatingEmail(false);
        return false;
      }
    } catch (err) {
      console.error("[Login] validateApprovedEmail error:", err);
      setVerifiedCompany(null);
      setVerifiedRole(null);
      setVerifiedOnboardingType(null);
      const msg = err?.message || "";
      if (msg.includes("verify_access_request") || msg.includes("schema cache")) {
        setError("Email verification is not yet configured. Please contact your administrator or try again later.");
      } else {
        setError("Database error checking email. Please try again.");
      }
      setIsValidatingEmail(false);
      return false;
    }
  };

  const handleEmailBlur = async () => {
    if (view === "create" && email && !verifiedCompany) {
      await validateApprovedEmail(email);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    if (!fullName) { setError("Please enter your full name."); return; }
    if (!password) { setError("Please enter a password."); return; }
    if (password !== confirmPassword) { setError("Passwords do not match."); return; }

    if (!verifiedCompany) {
      const isValid = await validateApprovedEmail(email);
      if (!isValid) return;
    }

    // Password rules
    const hasUpper = /[A-Z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);
    if (password.length < 8 || !hasUpper || !hasNumber || !hasSpecial) {
      setError("Password must be at least 8 characters and include uppercase, number, and special character.");
      return;
    }

    setError("");
    setLoading(true);
    try {
      // Try edge function first (sends confirmation or invite-completion links via Resend).
      // If not yet deployed, fall back to supabase.auth.signUp() so signup still works.
      let usedEdgeFunction = false;
      try {
        const resolvedOnboardingType = verifiedOnboardingType || resolveSignupOnboardingType(verifiedRole);
        const { data: fnData, error: fnError } = await supabase.functions.invoke("signup", {
          body: {
            email,
            password,
            full_name: fullName,
            onboarding_type: resolvedOnboardingType,
          },
        });

        if (fnError) {
          const detail = await getFunctionErrorMessage(fnError);
          throw new Error(detail || fnError.message || "Failed to create account.");
        }

        if (fnData?.error) {
          throw new Error(fnData.error);
        }

        if (fnData?.success) {
          usedEdgeFunction = true;
          setRegistrationFlow(fnData?.flow === "invite" ? "invite" : "signup");
          setConfirmationRequired(Boolean(fnData?.confirmationRequired ?? true));
          setRegistrationSuccess(true);
        }
      } catch (edgeErr) {
        const edgeMessage = edgeErr?.message || "";
        const functionUnavailable =
          edgeMessage.includes("Failed to send a request")
          || edgeMessage.includes("NetworkError")
          || edgeMessage.includes("fetch");

        if (!functionUnavailable) {
          throw edgeErr;
        }
      }

      if (!usedEdgeFunction) {
        const resolvedOnboardingType = verifiedOnboardingType || resolveSignupOnboardingType(verifiedRole);
        // Fallback: native Supabase signUp (uses Supabase's email service)
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/Onboarding`,
            data: {
              full_name: fullName,
              onboarding_type: resolvedOnboardingType,
            },
          },
        });
        if (signUpError) throw signUpError;
        setRegistrationFlow("signup");
        setConfirmationRequired(!data?.session);
        setRegistrationSuccess(true);
        if (data?.session) navigate(createPageUrl("Onboarding"));
      }
    } catch (err) {
      const msg = err.message || "";
      if (msg.toLowerCase().includes("user already registered") || msg.toLowerCase().includes("already exists")) {
        setError("An account with this email already exists. Please Sign In using the link below instead.");
      } else {
        setError(msg || "Failed to create account.");
      }
    }
    setLoading(false);
  };

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError("");
    try {
      await loginWithGoogle();
    } catch (err) {
      if (err.message?.includes("Multiple accounts with the same email")) {
        toast.error("Account Linking Required", {
          description: "An account with this email already exists. Please use your original login method or contact support to link your Google account.",
          duration: 10000
        });
      } else {
        setError(err.message || "Failed to sign in with Google.");
      }
      setLoading(false);
    }
  };

  // ─── Account Creation Success ────────────────────────────
  if (registrationSuccess) {
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center">
          <div className="w-20 h-20 mx-auto mb-6 rounded-[8px] bg-[var(--accent-soft)] flex items-center justify-center">
            <Mail className="w-10 h-10 text-[var(--accent)]" />
          </div>
          <h2 className="text-2xl font-bold text-[var(--ink)] mb-2">{confirmationRequired ? "Check your email!" : "Account created"}</h2>
          {confirmationRequired ? (
            <>
              <p className="text-[var(--muted)] text-sm mb-6 leading-relaxed">
                {registrationFlow === "invite"
                  ? <>We&apos;ve sent a secure invite-completion link to <strong>{email}</strong>. Open that email to finish creating your invited account and continue into your welcome setup.</>
                  : <>We&apos;ve sent a confirmation link to <strong>{email}</strong>. Once you click it, you&apos;ll be redirected into the secure setup flow and prompted for MFA.</>}
              </p>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={async () => {
                  setError("");
                  try {
                    let sent = false;
                    try {
                      const { data: fnData, error: fnError } = await supabase.functions.invoke("signup", {
                        body: { email, full_name: fullName, action: "resend" },
                      });
                      if (fnError) {
                        const detail = await getFunctionErrorMessage(fnError);
                        throw new Error(detail || fnError.message || "Failed to resend confirmation email.");
                      }
                      if (fnData?.error) throw new Error(fnData.error);
                      if (fnData?.success) {
                        sent = true;
                        setRegistrationFlow(fnData?.flow === "invite" ? "invite" : "signup");
                      }
                    } catch { /* edge function not deployed — fall back */ }

                    if (!sent) {
                      const { error: resendError } = await supabase.auth.resend({
                        type: "signup",
                        email,
                        options: { emailRedirectTo: `${window.location.origin}/Onboarding` },
                      });
                      if (resendError) throw resendError;
                    }
                    setResentConfirmation(true);
                  } catch (err) {
                    setError(err.message || "Failed to resend confirmation email.");
                  }
                }}
              >
                {registrationFlow === "invite" ? "Resend invite email" : "Resend confirmation email"}
              </Button>
              {resentConfirmation && (
                <p className="text-xs text-[var(--success)] mt-3">
                  {registrationFlow === "invite"
                    ? "A new invite-completion email has been sent."
                    : "A new confirmation email has been sent."}
                </p>
              )}
              <p className="text-[var(--muted)] text-xs italic mt-3">
                If you don&apos;t see it, check spam or confirm email delivery is enabled in Supabase Auth.
              </p>
            </>
          ) : (
            <p className="text-[var(--muted)] text-sm mb-6 leading-relaxed">
              Your account is ready and you&apos;re being redirected to complete security setup.
            </p>
          )}
          {error && <p className="text-[var(--danger)] text-xs mt-4">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] flex flex-col">
      {/* Top Bar */}
      <div className="px-6 py-5 flex items-center justify-between max-w-6xl mx-auto w-full">
        <Link to={createPageUrl("Landing")} className="flex items-center">
          <ProFormaBrand className="pf-page-brand" />
        </Link>
        <Link to={createPageUrl("RequestAccess")} className="text-sm text-[var(--muted)] hover:text-[var(--muted)] font-medium transition-colors">
          Request Access <ArrowRight className="inline w-3.5 h-3.5" />
        </Link>
      </div>

      {/* Main */}
      <div className="flex-1 flex items-center justify-center px-4 pb-16">
        <div className="max-w-[420px] w-full">
          <div className="text-center mb-8">
            <h1 className="text-[28px] font-bold text-[var(--ink)] tracking-tight mb-2">
              {view === "create" ? "Create your account" : "Welcome back"}
            </h1>
            <p className="text-[var(--muted)] text-sm">
              {view === "create" ? "Complete your approved registration" : "Sign in to your ProForma OS account"}
            </p>
          </div>

          <div className="bg-[var(--surface)] rounded-[8px] border border-[var(--border-cre)] shadow-[var(--shadow-soft)] p-8">
            {/* Google Login (Only for Sign In view) */}
            {view === "login" && (
              <>
                <div className="mb-6">
                  <button
                    type="button"
                    onClick={handleGoogleLogin}
                    disabled={loading}
                    className="w-full h-12 rounded-[8px] border border-[var(--border-cre)] bg-[var(--surface)] hover:bg-[var(--bg)] flex items-center justify-center gap-3 text-sm font-medium text-[var(--muted)] transition-all hover:border-[var(--border-cre)] hover:shadow-[var(--shadow-soft)] disabled:opacity-50"
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                    </svg>
                    Continue with Google
                  </button>
                </div>
                <div className="flex items-center gap-4 mb-6">
                  <div className="flex-1 h-px bg-[var(--border-cre)]" />
                  <span className="text-xs text-[var(--muted)] font-medium uppercase tracking-wider">or continue with email</span>
                  <div className="flex-1 h-px bg-[var(--border-cre)]" />
                </div>
              </>
            )}

            {/* Form */}
            <form onSubmit={view === "create" ? handleRegister : handleEmailLogin} className="space-y-4">

              {/* Login View */}
              {view === "login" && (
                <div className="space-y-4 animate-in fade-in duration-300">
                  <div>
                    <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">Email</Label>
                    <div className="relative mt-1.5">
                      <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted)]" />
                      <Input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@company.com"
                        className="h-11 pl-10"
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mt-4">
                      <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">Password</Label>
                      <button type="button" className="text-[11px] text-[var(--accent)] hover:text-[var(--accent)] font-medium">Forgot password?</button>
                    </div>
                    <div className="relative mt-1.5">
                      <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted)]" />
                      <Input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        className="h-11 pl-10 pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-[var(--muted)]"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Create Account View */}
              {view === "create" && (
                <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                  <div>
                    <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">Full Name</Label>
                    <Input
                      type="text"
                      className="mt-1.5 h-11"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Jane Doe"
                      required
                    />
                  </div>

                  <div>
                    <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">Email</Label>
                    <div className="relative mt-1.5">
                      <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted)]" />
                      <Input
                        type="email"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          setError("");
                          setVerifiedCompany(null);
                          setVerifiedRole(null);
                          setVerifiedOnboardingType(null);
                        }}
                        onBlur={handleEmailBlur}
                        placeholder="you@company.com"
                        className="h-11 pl-10"
                      />
                      {isValidatingEmail && (
                        <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-[var(--muted)]" />
                      )}
                      {verifiedCompany && (
                        <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--success)]" />
                      )}
                    </div>
                  </div>

                  <div>
                    <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">Password</Label>
                    <div className="relative mt-1.5">
                      <Input
                        type={showPassword ? "text" : "password"}
                        className="h-11 pr-10"
                        value={password}
                        onChange={(e) => { setPassword(e.target.value); setError(""); }}
                        placeholder="••••••••"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-[var(--muted)]"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">Confirm Password</Label>
                    <Input
                      type={showPassword ? "text" : "password"}
                      className="mt-1.5 h-11"
                      value={confirmPassword}
                      onChange={(e) => { setConfirmPassword(e.target.value); setError(""); }}
                      placeholder="••••••••"
                      required
                    />
                  </div>

                  {password && (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[!@#$%^&*(),.?":{}|<>]/.test(password)) && (
                    <div className="bg-[var(--danger-soft)] p-3 rounded-lg border border-[var(--border-cre)] flex gap-2 items-start mt-2">
                      <AlertCircle className="w-4 h-4 text-[var(--danger)] mt-0.5 flex-shrink-0" />
                      <p className="text-[11px] text-[var(--danger)] leading-relaxed font-medium">
                        Password must contain at least 8 characters, 1 uppercase letter, 1 number, and 1 special character.
                      </p>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3 pt-2">
                    <div>
                      <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider flex items-center justify-between">
                        Company Name
                      </Label>
                      <Input
                        type="text"
                        className="mt-1.5 h-11 bg-[var(--bg)] text-[var(--muted)] placeholder:text-[var(--muted)]"
                        value={verifiedCompany || ""}
                        placeholder="Auto-detected"
                        readOnly
                        disabled={!verifiedCompany}
                      />
                    </div>
                    <div>
                      <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">
                        Role
                      </Label>
                      <Input
                        type="text"
                        className="mt-1.5 h-11 bg-[var(--bg)] text-[var(--muted)] placeholder:text-[var(--muted)]"
                        value={verifiedRole || ""}
                        placeholder="Auto-detected"
                        readOnly
                        disabled={!verifiedRole}
                      />
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <div className="flex items-center gap-2 text-sm text-[var(--danger)] bg-[var(--danger-soft)] border border-[var(--border-cre)] rounded-lg p-3">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {/* Company not verified warning */}
              {view === "create" && !verifiedCompany && email && !isValidatingEmail && !error && (
                <div className="flex items-center gap-2 text-sm text-[var(--warning)] bg-[var(--warning-soft)] border border-[var(--border-cre)] rounded-lg p-3">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 text-[var(--warning)]" />
                  <span>Enter your approved email to auto-detect your company. Only approved applicants can create an account.</span>
                </div>
              )}

              <Button
                type="submit"
                disabled={loading || isValidatingEmail || (view === "create" && !verifiedCompany)}
                title={view === "create" && !verifiedCompany ? "Your email must be approved before creating an account" : undefined}
                className={`w-full h-12 font-semibold rounded-[8px] shadow-[var(--shadow-soft)] gap-2 text-sm transition-colors mt-6 ${view === "create" ? "bg-[var(--success)] hover:bg-[var(--success)] text-white disabled:opacity-40" : "bg-[var(--ink)] hover:bg-[var(--ink)] text-white"
                  }`}
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {view === "create" ? "Create Account" : "Sign In"}
              </Button>
            </form>
          </div>

          <div className="text-center mt-6">
            {view === "login" ? (
              <p className="text-sm text-[var(--muted)] font-medium">
                Don't have an account?{" "}
                <button
                  onClick={() => { setView("create"); resetForm(); }}
                  className="text-[var(--success)] hover:text-[var(--success)] font-semibold"
                >
                  Create Account
                </button>
              </p>
            ) : (
              <p className="text-sm text-[var(--muted)] font-medium">
                Already have an account?{" "}
                <button
                  onClick={() => { setView("login"); resetForm(); }}
                  className="text-[var(--accent)] hover:text-[var(--accent)] font-semibold"
                >
                  Sign In
                </button>
              </p>
            )}
          </div>

          <p className="text-center text-[11px] text-[var(--muted)] mt-6">
            Protected by enterprise-grade security. <a href="#" className="text-[var(--accent)] hover:underline">Privacy</a> · <a href="#" className="text-[var(--accent)] hover:underline">Terms</a>
          </p>
        </div>
      </div>
    </div>
  );
}
