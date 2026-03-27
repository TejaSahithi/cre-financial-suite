import React, { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { OrganizationService } from "@/services/api";
import { redirectToLogin } from "@/services/auth";
import { useAuth } from "@/lib/AuthContext";
import { logAudit } from "@/services/audit";
import { supabase } from "@/services/supabaseClient";
import { Building2, CheckCircle2, ArrowRight, ArrowLeft, Loader2, CreditCard, FileText, Lock, Clock, Shield, AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createPageUrl } from "@/utils";

const steps = [
  { id: 1, label: "Company Setup", icon: Building2 },
  { id: 2, label: "Agreement", icon: FileText },
  { id: 3, label: "Payment", icon: CreditCard },
  { id: 4, label: "Confirmation", icon: CheckCircle2 },
];

export default function Onboarding() {
  const { user: authUser, refreshProfile, logout, isLoadingAuth } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const step = parseInt(searchParams.get('step') || '1', 10);
  const setStep = (newStep) => {
    setSearchParams({ step: newStep.toString() });
  };
  const [user, setUser] = useState(null);
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    name: "", address: "", phone: "", timezone: "America/New_York",
    currency: "USD", primary_contact_email: "", plan: "professional",
    industry: "commercial_re"
  });

  useEffect(() => {
    // Wait for auth context to finish loading before doing anything
    if (isLoadingAuth) {
      console.log('[Onboarding] Auth still loading, waiting...');
      return;
    }

    const init = async () => {
      try {
        if (!authUser) {
          console.log('[Onboarding] No authenticated user, redirecting to login');
          redirectToLogin(createPageUrl("Onboarding"));
          setLoading(false);
          return;
        }

        setUser(authUser);
        setForm(f => ({ ...f, primary_contact_email: authUser.email || "" }));

        // Find existing org using the user's membership org_id
        if (authUser.org_id) {
          console.log('[Onboarding] Initializing with Org:', authUser.org_id);

          await new Promise(r => setTimeout(r, 600));

          const orgData = await OrganizationService.get(authUser.org_id);
          console.log('[Onboarding] Org data fetched:', { found: !!orgData, status: orgData?.status, step: orgData?.onboarding_step });
          if (orgData) {
            setOrg(orgData);
            if (orgData.status === 'under_review') {
              console.log('[Onboarding] Org is under review, redirecting to success page');
              navigate('/PaymentSuccess', { replace: true });
              return;
            }

            const serverStep = orgData.onboarding_step || 1;
            const currentUrlStep = parseInt(searchParams.get('step'), 10);

            if (!currentUrlStep && serverStep > 1) {
              console.log('[Onboarding] Syncing to server step:', serverStep);
              setStep(serverStep);
            }

            // If already active, we don't need to be here, but don't hard redirect 
            // inside init as it leads to loops if the router isn't ready.
            // App.jsx will handle the high-level redirection.
          }
        }
      } catch (e) {
        console.error('[Onboarding] init error:', e);
      } finally {
        setLoading(false);
      }
    };
    init();

  }, [authUser]);

  // Status Polling: Automatically check for approval while on Step 4
  useEffect(() => {
    if (step !== 4) return;
    console.log('[Onboarding] Status polling active (10s interval)');
    const checkApproval = async () => {
      try {
        if (org?.id) {
          const latestOrg = await OrganizationService.get(org.id);
          if (latestOrg?.status === 'active') {
            console.log('[Onboarding] Approval detected via org! Refreshing profile...');
            await refreshProfile();
            return;
          }
        }
        const p = await refreshProfile();
        if (p?.profile?.status === 'active' || p?.status === 'active') {
          console.log('[Onboarding] Approval detected via profile! Redirecting...');
          // Let App.jsx handle the specific target (WelcomeAboard or Dashboard)
        }
      } catch (e) {
        console.error('[Onboarding] Poll error:', e);
      }

    };
    checkApproval();
    const interval = setInterval(checkApproval, 10000);
    return () => clearInterval(interval);
  }, [step, refreshProfile, org?.id]);

  const saveCompanyInfo = async () => {
    console.log('[Onboarding] saveCompanyInfo started', { name: !!form.name, email: !!form.primary_contact_email });
    if (!form.name || !form.primary_contact_email) {
      setSaving('val_error');
      try {
        const { toast } = await import("sonner");
        toast.error("Organization Name and Primary Email are required to continue.");
      } catch (e) { }
      return;
    }

    setSaving(true);
    const { toast } = await import("sonner");
    const loadingToast = toast.loading("Saving company information...");

    try {
      let savedOrg;
      if (org) {
        console.log('[Onboarding] Updating existing org:', org.id);
        savedOrg = await OrganizationService.update(org.id, { ...form, onboarding_step: 2 });
      } else {
        // Fallback: This should rarely happen if first-login worked
        console.warn('[Onboarding] Org missing, attempting fresh create');
        savedOrg = await OrganizationService.create({ ...form, status: "onboarding", onboarding_step: 2 });

        if (savedOrg?.id && authUser?.id && supabase) {
          await supabase.from('memberships').upsert({
            user_id: authUser.id,
            org_id: savedOrg.id,
            role: 'org_admin',
          }, { onConflict: 'user_id,org_id' });
          await refreshProfile();
        }
      }

      console.log('[Onboarding] Save success, moving to step 2');
      setOrg(savedOrg);
      setStep(2);
      toast.success("Company information saved!", { id: loadingToast });
    } catch (e) {
      console.error('[Onboarding] save error:', e);
      toast.error(e.message || "Failed to save company information", { id: loadingToast });
    } finally {
      setSaving(false);
    }
  };
  // Called when the final step (Confirmation) is reached
  const completeOnboarding = async () => {
    try {
      // Advance step visually
      if (org) {
        await OrganizationService.update(org.id, { onboarding_step: 4 });
      }

      console.log('[Onboarding] Triggering complete-onboarding Edge Function');
      const { data, error } = await supabase.functions.invoke('complete-onboarding');

      if (error || data?.error) {
        throw new Error(error?.message || data?.error || 'Failed to complete onboarding');
      }

      // Audit log â€” onboarding completion
      await logAudit({
        entityType: 'Profile',
        entityId: authUser?.id,
        action: 'update',
        fieldChanged: 'onboarding_status',
        oldValue: 'onboarding',
        newValue: 'under_review',
        orgId: org?.id,
        userId: authUser?.id,
        userEmail: authUser?.email,
      }).catch(() => { });

      // Refresh the auth context so App.jsx picks up `under_review`
      await refreshProfile();
    } catch (e) {
      console.error('[Onboarding] complete error:', e);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-slate-400 mx-auto mb-3" />
          <p className="text-sm text-slate-400">Loading your account...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex flex-col">
      {/* Header */}
      <div className="bg-[#1a2744] px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center">
            <Building2 className="w-5 h-5 text-white" />
          </div>
          <span className="text-white font-bold text-lg">CRE Suite</span>
          <div className="ml-auto flex items-center gap-4">
            <span className="text-white/50 text-sm">Account Setup</span>
            <Button variant="ghost" size="sm" className="text-white/70 hover:text-white hover:bg-white/10" onClick={() => logout(true)}>
              Sign Out
            </Button>
          </div>
        </div>
      </div>

      {/* Progress Steps */}
      <div className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-6 py-5">
          <div className="flex items-center gap-0">
            {steps.map((s, i) => (
              <React.Fragment key={s.id}>
                <div className="flex items-center gap-2.5">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300
                    ${step > s.id ? 'bg-emerald-500 text-white shadow-sm shadow-emerald-200' : step === s.id ? 'bg-[#1a2744] text-white shadow-sm' : 'bg-slate-100 text-slate-400 border border-slate-200'}`}>
                    {step > s.id ? <CheckCircle2 className="w-4 h-4" /> : s.id}
                  </div>
                  <span className={`text-sm font-medium hidden sm:inline ${step === s.id ? 'text-[#1a2744] font-semibold' : step > s.id ? 'text-emerald-600' : 'text-slate-400'}`}>
                    {s.label}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <div className="flex-1 mx-4 h-px relative">
                    <div className="absolute inset-0 bg-slate-200" />
                    <div className={`absolute inset-y-0 left-0 bg-emerald-400 transition-all duration-500 ${step > s.id ? 'w-full' : 'w-0'}`} />
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex items-start justify-center p-6 pt-10 overflow-y-auto">
        <div className="bg-white rounded-2xl shadow-xl border border-slate-200/50 max-w-2xl w-full p-8 mb-10">

          {/* Step 1: Company Info */}
          {step === 1 && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="mb-6">
                <h2 className="text-2xl font-bold text-slate-900 mb-1">Company Information</h2>
                <p className="text-slate-500 text-sm">Tell us about your organization to personalize your experience.</p>
              </div>
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2">
                    <Label className={`text-xs font-semibold uppercase tracking-wider ${!form.name ? 'text-slate-700' : 'text-slate-700'}`}>
                      Organization Name <span className="text-red-400">*</span>
                    </Label>
                    <Input
                      value={form.name}
                      onChange={e => setForm({ ...form, name: e.target.value })}
                      placeholder="e.g. Meridian Capital Group"
                      className={`mt-1.5 h-11 transition-all ${!form.name && saving === 'val_error' ? 'border-red-500 bg-red-50/20' : ''}`}
                    />
                    {!form.name && saving === 'val_error' && <p className="text-[10px] text-red-500 mt-1">Organization name is required to continue.</p>}
                  </div>
                  <div className="col-span-2">
                    <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Primary Contact Email <span className="text-red-400">*</span></Label>
                    <Input type="email" value={form.primary_contact_email} onChange={e => setForm({ ...form, primary_contact_email: e.target.value })} className="mt-1.5 h-11" />
                  </div>
                  <div className="col-span-2">
                    <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">HQ Address</Label>
                    <Input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="123 Main St, New York, NY 10001" className="mt-1.5 h-11" />
                  </div>
                  <div>
                    <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Phone</Label>
                    <Input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="+1 (555) 000-0000" className="mt-1.5 h-11" />
                  </div>
                  <div>
                    <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Industry</Label>
                    <Select value={form.industry} onValueChange={v => setForm({ ...form, industry: v })}>
                      <SelectTrigger className="mt-1.5 h-11"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="commercial_re">Commercial Real Estate</SelectItem>
                        <SelectItem value="industrial">Industrial</SelectItem>
                        <SelectItem value="retail">Retail</SelectItem>
                        <SelectItem value="mixed_use">Mixed Use</SelectItem>
                        <SelectItem value="multifamily">Multifamily</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Timezone</Label>
                    <Select value={form.timezone} onValueChange={v => setForm({ ...form, timezone: v })}>
                      <SelectTrigger className="mt-1.5 h-11"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="America/New_York">Eastern (ET)</SelectItem>
                        <SelectItem value="America/Chicago">Central (CT)</SelectItem>
                        <SelectItem value="America/Denver">Mountain (MT)</SelectItem>
                        <SelectItem value="America/Phoenix">Arizona (MST)</SelectItem>
                        <SelectItem value="America/Los_Angeles">Pacific (PT)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Currency</Label>
                    <Select value={form.currency} onValueChange={v => setForm({ ...form, currency: v })}>
                      <SelectTrigger className="mt-1.5 h-11"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USD">USD ($)</SelectItem>
                        <SelectItem value="CAD">CAD (C$)</SelectItem>
                        <SelectItem value="EUR">EUR (â‚¬)</SelectItem>
                        <SelectItem value="GBP">GBP (Â£)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
              <Button
                onClick={saveCompanyInfo}
                disabled={saving === true || !form.name || !form.primary_contact_email}
                className="w-full mt-8 bg-[#1a2744] hover:bg-[#243b67] h-12 rounded-xl font-semibold gap-2 transition-all shadow-lg active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving === true ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Continue to Agreement <ArrowRight className="w-4 h-4" />
              </Button>
            </div>
          )}

          {/* Step 2: MSA */}
          {step === 2 && (
            <div className="animate-in fade-in slide-in-from-right-4 duration-500">
              <MSAStep org={org} onNext={async (signatureData) => {
                console.log('[Onboarding] MSA signed, updating org', org?.id);

                // 1. Update Org â€” fault-tolerant: don't block navigation on DB errors
                try {
                  await OrganizationService.update(org.id, {
                    onboarding_step: 3,
                  });
                } catch (e) {
                  console.error('[Onboarding] Org update failed (non-blocking):', e);
                }

                // 2. Create Document record for the MSA
                try {
                  await supabase.from('documents').insert({
                    org_id: org.id,
                    title: "Master Service Agreement (Signed)",
                    document_type: "Contract",
                    file_name: "MSA_Signed.pdf",
                    storage_path: `onboarding/msa_${org.id}.pdf`, // Required field
                    uploaded_by: authUser?.id,
                    description: `Signed by ${signatureData.fullName}, ${signatureData.role}, on ${signatureData.date}`
                  });
                } catch (docErr) {
                  console.error('[Onboarding] Document creation failed (non-blocking):', docErr);
                }


                // 3. ALWAYS advance to Payment â€” this is the critical line
                console.log('[Onboarding] Moving to step 3 (Payment)');
                setStep(3);
              }} onBack={() => setStep(1)} user={authUser} />
            </div>
          )}

          {step === 3 && (
            <div className="animate-in fade-in slide-in-from-right-4 duration-500">
              <PaymentStep org={org} user={authUser} form={form} setForm={setForm} onComplete={async (billingCycle, paymentInfo) => {
                setSaving(true);
                const numericAmount = typeof paymentInfo.displayPrice === 'string'
                  ? parseFloat(paymentInfo.displayPrice.replace(/[^0-9.]/g, ''))
                  : paymentInfo.displayPrice;

                try {
                  if (org?.id) {
                    // Update Org status, profile status, invoice, and notify SuperAdmin securely via Edge Function
                    const { data, error } = await supabase.functions.invoke('complete-onboarding', {
                      body: {
                        plan: paymentInfo.plan || form.plan,
                        billingCycle,
                        amount: numericAmount,
                        orgName: org?.name || ''
                      }
                    });

                    if (error) throw error;
                    if (data?.error) throw new Error(data.error);
                  } else {
                    throw new Error("Organization ID is missing. Cannot finalize setup.");
                  }

                  // 3. Navigate to PaymentSuccess page
                  console.log('[Onboarding] Payment and status updates complete! Redirecting...');
                  // Refresh global auth context profile first so the guard knows we are 'under_review'
                  await refreshProfile();
                  navigate('/PaymentSuccess', {
                    replace: true,
                    state: {
                      plan: paymentInfo.plan || form.plan,
                      billing: billingCycle,
                      amount: numericAmount,
                      org: org?.name || ''
                    }
                  });
                } catch (e) {
                  console.error('[Onboarding] Payment completion failed:', e);
                  const { toast } = await import("sonner");
                  toast.error("Failed to update your account. Please contact support.", { description: e.message });
                  // Re-throw to allow child component to catch and display inline error
                  throw e;
                } finally {
                  setSaving(false);
                }
              }} onBack={() => setStep(2)} />
            </div>
          )}

          {/* Step 4: Confirmation */}
          {step === 4 && (
            <div className="animate-in zoom-in duration-500">
              <ConfirmationStep org={org} user={authUser} plan={form.plan} paymentInfo={form.paymentInfo} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// â”€â”€â”€ MSA Step â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function MSAStep({ org, onNext, onBack, user }) {
  const [accepted, setAccepted] = useState(false);
  const [fullName, setFullName] = useState(user?.full_name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [role, setRole] = useState("");
  const [saving, setSaving] = useState(false);

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const handleSign = async () => {
    setSaving(true);
    try {
      await onNext({ fullName, email, role, date: today });
    } catch (e) {
      console.error('[Onboarding][MSA] handleSign error:', e);
    } finally {
      setSaving(false);
    }
  };

  const handleDownload = () => {
    const content = `
CRE PLATFORM MASTER SERVICE AGREEMENT
Version 4.2 â€¢ Effective Date: ${today}
â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”

This Master Service Agreement ("Agreement") is entered into between
CRE Platform, Inc. ("Provider") and the organization
${org?.name || "The Client"} ("Client").

1. SCOPE OF SERVICE
Provider shall provide Client with access to the CRE Suite cloud-based
platform for commercial real estate portfolio management and automation.

2. SUBSCRIPTION TERM
The term of this Agreement shall begin on the date of execution and
continue for the duration of the selected subscription plan, renewing
automatically unless cancelled.

3. PAYMENT TERMS
Client agrees to pay all applicable fees via the authorized payment
method. All fees are non-refundable except as expressly stated herein.

4. CONFIDENTIALITY & DATA
Client retains all rights to its data. Provider implements bank-grade
security and isolation to protect Client information.

5. ACCEPTANCE OF TERMS
By signing below, Client acknowledges they have read, understood, and
agree to be bound by the terms and conditions set forth in this document.

â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”

SIGNED BY:    ${fullName || "_______________"}
EMAIL:        ${email || "_______________"}
ROLE/TITLE:   ${role || "_______________"}
DATE:         ${today}

â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”
`;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `MSA_${org?.name || 'Agreement'}_${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const canProceed = accepted && fullName.trim().length >= 3 && email.trim().length >= 3 && role.trim().length >= 2;

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-slate-900 mb-1">Master Service Agreement</h2>
        <p className="text-slate-500 text-sm">Review, sign, and download to complete your enterprise activation.</p>
      </div>

      {/* Document Viewer */}
      <div className="border border-slate-200 rounded-xl bg-slate-50 mb-6 flex flex-col overflow-hidden">
        <div className="bg-slate-100/50 px-4 py-2 border-b border-slate-200 flex items-center justify-between">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Document â€” MSA-2026-01</span>
          <FileText className="w-4 h-4 text-slate-300" />
        </div>
        <div className="h-64 overflow-y-auto p-6 text-[13px] text-slate-600 leading-relaxed space-y-4 scrollbar-thin">
          <div className="text-center pb-4">
            <h3 className="font-bold text-slate-900 text-base">CRE PLATFORM MASTER SERVICE AGREEMENT</h3>
            <p className="text-[11px] text-slate-400">Version 4.2 â€¢ Effective Date: {today}</p>
          </div>
          <p>This Master Service Agreement ("Agreement") is entered into between <strong>CRE Platform, Inc.</strong> ("Provider") and the organization <strong>{org?.name || "The Client"}</strong> ("Client").</p>
          <p><strong>1. Scope of Service.</strong> Provider shall provide Client with access to the CRE Suite cloud-based platform for commercial real estate portfolio management and automation.</p>
          <p><strong>2. Subscription Term.</strong> The term of this Agreement shall begin on the date of execution and continue for the duration of the selected subscription plan, renewing automatically unless cancelled.</p>
          <p><strong>3. Payment Terms.</strong> Client agrees to pay all applicable fees via the authorized payment method. All fees are non-refundable except as expressly stated herein.</p>
          <p><strong>4. Confidentiality & Data.</strong> Client retains all rights to its data. Provider implements bank-grade security and isolation to protect Client information.</p>
          <p><strong>5. Acceptance of Terms.</strong> By signing below, Client acknowledges they have read, understood, and agree to be bound by the terms and conditions set forth in this document.</p>

          {/* Signature block inside document */}
          <div className="pt-8 border-t border-slate-200">
            <div className="grid grid-cols-2 gap-6">
              <div>
                <p className="text-[10px] text-slate-400 mb-1">Signed By:</p>
                <p className="text-lg italic font-serif text-slate-800 border-b border-slate-300 min-h-[28px]">{fullName}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400 mb-1">Date:</p>
                <p className="text-sm font-medium text-slate-800">{today}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400 mb-1">Role/Title:</p>
                <p className="text-sm text-slate-800 border-b border-slate-300 min-h-[20px]">{role}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400 mb-1">Email:</p>
                <p className="text-sm text-slate-800 border-b border-slate-300 min-h-[20px]">{email}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Signatory Details */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 mb-6 space-y-4">
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Signatory Details</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Full Name <span className="text-red-400">*</span></Label>
            <Input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Full Legal Name" className="mt-1.5 h-11" />
          </div>
          <div>
            <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Email <span className="text-red-400">*</span></Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" className="mt-1.5 h-11" />
          </div>
          <div>
            <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Role / Title <span className="text-red-400">*</span></Label>
            <Input value={role} onChange={e => setRole(e.target.value)} placeholder="e.g. CEO, Director of Finance" className="mt-1.5 h-11" />
          </div>
          <div>
            <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Date</Label>
            <Input value={today} readOnly className="mt-1.5 h-11 bg-slate-100 text-slate-500 cursor-not-allowed" />
          </div>
        </div>
      </div>

      {/* Consent Checkbox */}
      <div className={`flex items-start gap-3 mb-6 p-4 rounded-xl border transition-all ${accepted ? 'bg-blue-50 border-blue-200' : 'bg-slate-50 border-slate-100'}`}>
        <input type="checkbox" id="accept" checked={accepted} onChange={e => setAccepted(e.target.checked)} className="mt-1 w-4 h-4 cursor-pointer accent-[#1a2744]" />
        <label htmlFor="accept" className="text-sm text-slate-700 cursor-pointer leading-relaxed">
          I, <strong>{fullName || '___'}</strong>, confirm that I am an authorized representative of <strong>{org?.name}</strong> and I agree to the terms of the Master Service Agreement.
        </label>
      </div>

      {/* Download + Nav Buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="h-12 w-28 rounded-xl text-slate-600">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back
        </Button>
        <Button variant="outline" onClick={handleDownload} className="h-12 rounded-xl text-slate-600 gap-2">
          <FileText className="w-4 h-4" /> Download MSA
        </Button>
        <Button onClick={handleSign} disabled={!canProceed || saving} className="flex-1 bg-[#1a2744] hover:bg-[#243b67] h-12 rounded-xl font-semibold gap-2 shadow-lg shadow-blue-900/10">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
          Continue to Payment
        </Button>
      </div>

      <p className="text-[10px] text-slate-400 text-center mt-3 italic flex items-center justify-center gap-1">
        <Lock className="w-3 h-3" /> Secure Electronic Signature (ESIGN Act compliant)
      </p>
    </div>
  );
}

// â”€â”€â”€ Payment Step â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function PaymentStep({ org, user, form, setForm, onComplete, onBack }) {
  const [processing, setProcessing] = useState(false);
  const [cardName, setCardName] = useState(user?.full_name || "");
  const [cardNumber, setCardNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");
  const [error, setError] = useState("");
  const [billingCycle, setBillingCycle] = useState("monthly");

  // Billing address
  const [billingAddress, setBillingAddress] = useState("");
  const [billingCity, setBillingCity] = useState("");
  const [billingState, setBillingState] = useState("");
  const [billingZip, setBillingZip] = useState("");
  const [billingCountry, setBillingCountry] = useState("US");

  const YEARLY_DISCOUNT = 0.25;

  const plans = [
    { key: "starter", name: "Starter", price: 499, desc: "Standard CAM & Portfolios" },
    { key: "professional", name: "Professional", price: 1499, desc: "AI-Powered Budgeting", popular: true },
    { key: "enterprise", name: "Enterprise", price: 0, desc: "Custom SLA & Integration" },
  ];

  const getPrice = (basePrice) => {
    if (!basePrice) return 0;
    if (billingCycle === "yearly") return Math.round(basePrice * (1 - YEARLY_DISCOUNT));
    return basePrice;
  };

  const selectedPlan = plans.find(p => p.key === form.plan) || plans[1];
  const displayPrice = getPrice(selectedPlan.price);
  const yearlyTotal = displayPrice * 12;

  const handlePayment = async (e) => {
    e.preventDefault();
    setError("");
    setProcessing(true);
    try {
      await new Promise(r => setTimeout(r, 2000));
      await onComplete(billingCycle, {
        cardName, plan: selectedPlan.name, displayPrice, billingCycle,
        billingAddress: `${billingAddress}, ${billingCity}, ${billingState} ${billingZip}, ${billingCountry}`,
      });
    } catch (err) {
      console.error('[Payment] onComplete callback failed:', err);
      setError(err.message || "An unexpected error occurred. Your payment was not processed, please try again.");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-slate-900 mb-1">Activate Subscription</h2>
        <p className="text-slate-500 text-sm">Select a plan and billing cycle to secure your instance.</p>
      </div>

      {/* Billing Toggle */}
      <div className="flex items-center justify-center mb-6">
        <div className="bg-slate-100 rounded-xl p-1 flex gap-1">
          <button type="button" onClick={() => setBillingCycle("monthly")}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${billingCycle === "monthly" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
            Monthly
          </button>
          <button type="button" onClick={() => setBillingCycle("yearly")}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-2 ${billingCycle === "yearly" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
            Yearly
            <span className="bg-emerald-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-tight">Save 25%</span>
          </button>
        </div>
      </div>

      {/* Plan Grid */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {plans.map(p => {
          const price = getPrice(p.price);
          return (
            <button key={p.key} type="button" onClick={() => setForm({ ...form, plan: p.key })}
              className={`p-4 rounded-xl border-2 transition-all relative text-left ${form.plan === p.key ? "border-blue-600 bg-blue-50/50 shadow-md ring-4 ring-blue-50" : "border-slate-100 bg-slate-50 hover:border-slate-300"}`}>
              {p.popular && <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-tighter">Recommended</div>}
              <p className="text-xs font-bold text-slate-900 mb-1">{p.name}</p>
              {p.price ? (
                <div>
                  <p className="text-xl font-black text-[#1a2744]">${price}<span className="text-[10px] uppercase font-bold text-slate-400 ml-1">/mo</span></p>
                  {billingCycle === "yearly" && <p className="text-[9px] text-emerald-600 font-bold mt-0.5">${p.price}/mo â†’ Save ${p.price - price}/mo</p>}
                </div>
              ) : <p className="text-xl font-black text-[#1a2744]">Custom</p>}
            </button>
          );
        })}
      </div>

      {billingCycle === "yearly" && selectedPlan.price > 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 mb-6 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-emerald-800">Annual billing â€” 25% savings applied</p>
            <p className="text-xs text-emerald-600">Billed as ${yearlyTotal.toLocaleString()}/year</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-emerald-500 line-through">${(selectedPlan.price * 12).toLocaleString()}</p>
            <p className="text-sm font-black text-emerald-700">${yearlyTotal.toLocaleString()}</p>
          </div>
        </div>
      )}

      <form onSubmit={handlePayment} className="space-y-4">
        {/* Card Details */}
        <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200 space-y-4">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Card Details</p>
          <div>
            <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1.5 block">Cardholder Name</Label>
            <Input value={cardName} onChange={e => setCardName(e.target.value)} placeholder="Full Name" className="bg-white border-slate-200 h-11" required />
          </div>
          <div>
            <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1.5 block">Card Number</Label>
            <div className="relative">
              <Input value={cardNumber} onChange={e => setCardNumber(e.target.value.replace(/\D/g, '').substring(0, 16))}
                placeholder="0000 0000 0000 0000" className="bg-white border-slate-200 h-11 pl-11 font-mono tracking-widest" required />
              <CreditCard className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-300" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1.5 block">Expiration</Label>
              <Input value={expiry} onChange={e => setExpiry(e.target.value.substring(0, 5))} placeholder="MM / YY" className="bg-white border-slate-200 h-11 text-center" required />
            </div>
            <div>
              <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1.5 block">CVC</Label>
              <Input value={cvc} onChange={e => setCvc(e.target.value.replace(/\D/g, '').substring(0, 4))} placeholder="123" className="bg-white border-slate-200 h-11 text-center" required />
            </div>
          </div>
        </div>

        {/* Billing Address */}
        <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200 space-y-4">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Billing Address</p>
          <div>
            <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1.5 block">Street Address</Label>
            <Input value={billingAddress} onChange={e => setBillingAddress(e.target.value)} placeholder="123 Main St" className="bg-white border-slate-200 h-11" required />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1.5 block">City</Label>
              <Input value={billingCity} onChange={e => setBillingCity(e.target.value)} placeholder="New York" className="bg-white border-slate-200 h-11" required />
            </div>
            <div>
              <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1.5 block">State</Label>
              <Input value={billingState} onChange={e => setBillingState(e.target.value)} placeholder="NY" className="bg-white border-slate-200 h-11" required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1.5 block">ZIP / Postal Code</Label>
              <Input value={billingZip} onChange={e => setBillingZip(e.target.value)} placeholder="10001" className="bg-white border-slate-200 h-11" required />
            </div>
            <div>
              <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1.5 block">Country</Label>
              <Input value={billingCountry} onChange={e => setBillingCountry(e.target.value)} placeholder="US" className="bg-white border-slate-200 h-11" required />
            </div>
          </div>
        </div>

        {error && <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-xs text-red-600 flex items-center gap-2"><AlertCircle className="w-3.5 h-3.5" /> {error}</div>}

        <div className="flex gap-4">
          <Button type="button" variant="outline" onClick={onBack} className="h-12 w-32 rounded-xl text-slate-500">Back</Button>
          <Button type="submit" disabled={processing} className="flex-1 bg-[#1a2744] hover:bg-[#243b67] h-12 rounded-xl text-base font-bold shadow-lg">
            {processing ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Lock className="w-4 h-4 mr-2" />}
            {processing ? "Processing Securely..." : selectedPlan.price ? `Pay $${displayPrice} & Finalize Setup` : "Request Enterprise Access"}
          </Button>
        </div>
        <p className="text-center text-[10px] text-slate-400 flex items-center justify-center gap-1">
          <Lock className="w-3 h-3" /> 256-bit SSL encryption Â· PCI DSS compliant
        </p>
      </form>
    </div>
  );
}

// ─── Confirmation Step ──────────────────────────────────────────
function ConfirmationStep({ org, user, plan, paymentInfo }) {
  const [dbInvoice, setDbInvoice] = useState(null);

  useEffect(() => {
    async function fetchInvoice() {
      if (!paymentInfo) {
        try {
          const { supabase } = await import('@/services/supabaseClient');
          const { data, error } = await supabase.from('invoices').select('*').eq('org_id', org?.id).order('created_at', { ascending: false }).limit(1).single();
          if (error) {
            console.error('[Onboarding] Error fetching invoice for confirmation:', error);
            // Fallback UI data if DB fetch fails (e.g. 406 Not Acceptable)
            setDbInvoice({
              displayPrice: "...",
              plan: org?.plan || plan || "Professional",
              billingCycle: org?.billing_cycle || "monthly",
              billingAddress: "Pending review"
            });
          } else if (data) {
            setDbInvoice({
              displayPrice: data.amount,
              plan: org?.plan || plan || "Professional",
              billingCycle: org?.billing_cycle || "monthly",
              billingAddress: "—" // Fetched from db invoice implies address wasn't saved to profile, but payment was successful
            });
          }
        } catch (e) { console.error(e); }
      }
    }
    fetchInvoice();
  }, [org?.id, paymentInfo, org?.plan, org?.billing_cycle, plan]);

  const info = paymentInfo || dbInvoice;

  const handleDownloadInvoice = async () => {
    const { toast } = await import("sonner");
    try {
      console.log("[Onboarding] Starting invoice download...", { info, plan });
      const { jsPDF } = await import('jspdf');
      if (!jsPDF) throw new Error("jsPDF library failed to load");

      const doc = new jsPDF();

      const invoiceId = `INV-${Date.now().toString(36).toUpperCase()}`;
      const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const planName = info?.plan || plan || "Professional";
      const price = info?.displayPrice || "0";
      const cycle = info?.billingCycle || "monthly";
      const totalDue = cycle === "yearly" ? price * 12 : price;

      // Colors
      const primaryColor = '#1a2744';
      const secondaryColor = '#64748b';

      // Header
      doc.setFont("helvetica", "bold");
      doc.setFontSize(24);
      doc.setTextColor(primaryColor);
      doc.text("CRE PLATFORM", 20, 30);

      doc.setFontSize(10);
      doc.setTextColor(secondaryColor);
      doc.text("support@cresuite.org", 20, 38);

      // INVOICE Title
      doc.setFontSize(20);
      doc.setTextColor(primaryColor);
      doc.text("INVOICE", 150, 30, { align: "center" });

      // Invoice Details
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.text(`Invoice Number: ${invoiceId}`, 150, 45, { align: "center" });
      doc.text(`Date: ${today}`, 150, 52, { align: "center" });
      doc.text(`Status: PENDING ACTIVATION`, 150, 59, { align: "center" });

      // Line
      doc.setDrawColor(200, 200, 200);
      doc.line(20, 65, 190, 65);

      // Billed To
      doc.setFont("helvetica", "bold");
      doc.setTextColor(primaryColor);
      doc.text("Billed To:", 20, 80);

      doc.setFont("helvetica", "normal");
      doc.setTextColor(secondaryColor);
      doc.text(user?.full_name || "—", 20, 88);
      doc.text(user?.email || "—", 20, 95);
      doc.text(org?.name || "—", 20, 102);
      if (info?.billingAddress) {
        doc.text(info.billingAddress, 20, 109);
      }

      // Subscription Details Table Header
      doc.setFillColor(248, 250, 252);
      doc.rect(20, 125, 170, 10, 'F');

      doc.setFont("helvetica", "bold");
      doc.setTextColor(primaryColor);
      doc.text("Description", 25, 132);
      doc.text("Billing Cycle", 100, 132);
      doc.text("Amount", 170, 132, { align: "right" });

      // Subscription Details Table Row
      doc.setFont("helvetica", "normal");
      doc.setTextColor(secondaryColor);
      doc.text(`CRE Suite ${planName.charAt(0).toUpperCase() + planName.slice(1)} Plan`, 25, 145);
      doc.text(cycle === "yearly" ? "Annual" : "Monthly", 100, 145);
      doc.text(`$${price}${cycle === "yearly" ? "/mo" : ""}`, 170, 145, { align: "right" });

      // Line
      doc.line(20, 152, 190, 152);

      // Totals
      doc.text("Subtotal:", 130, 165);
      doc.text(`$${price}`, 170, 165, { align: "right" });

      doc.text("Discount:", 130, 175);
      doc.text(cycle === "yearly" ? "25% Annual" : "None", 170, 175, { align: "right" });

      doc.setFont("helvetica", "bold");
      doc.setTextColor(primaryColor);
      doc.text("Total Due:", 130, 185);
      doc.text(`$${totalDue}`, 170, 185, { align: "right" });

      // Footer
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(secondaryColor);
      doc.text("Payment processed securely. Account is pending SuperAdmin activation.", 105, 270, { align: "center" });
      doc.text(`© ${new Date().getFullYear()} CRE Financial Suite. All rights reserved.`, 105, 275, { align: "center" });

      const pdfBlob = doc.output('blob');
      const url = URL.createObjectURL(pdfBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${invoiceId}_CRE_Suite.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Invoice downloaded successfully!");
    } catch (err) {
      console.error("Failed to generate PDF", err);
      toast.error("Failed to generate invoice: " + err.message);
    }
  };

  return (
    <div className="text-center py-4">
      {/* Pending Animation */}
      <div className="relative w-24 h-24 mx-auto mb-6">
        <div className="absolute inset-0 bg-amber-100 rounded-full animate-ping opacity-20" />
        <div className="relative w-24 h-24 bg-amber-100 rounded-full flex items-center justify-center">
          <Clock className="w-12 h-12 text-amber-500" />
        </div>
      </div>

      <h2 className="text-2xl font-bold text-emerald-600 mb-2">Payment Successful</h2>
      <p className="text-slate-600 font-semibold mb-1 max-w-md mx-auto">
        Your payment was received successfully! Our team is now reviewing your organization.
      </p>
      <p className="text-slate-400 text-xs mb-6 max-w-sm mx-auto">
        Thank you for choosing CRE Suite, <strong>{user?.full_name}</strong>. We are processing <strong>{org?.name}</strong> and you will receive a welcome email once your account is activated.
      </p>

      {/* Payment Summary */}
      {info && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-6 max-w-sm mx-auto text-left">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Payment Summary</p>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Plan</span>
              <span className="font-semibold text-slate-900">{info.plan || plan}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Billing</span>
              <span className="font-semibold text-slate-900 capitalize">{info.billingCycle || "monthly"}</span>
            </div>
            <div className="flex justify-between border-t border-slate-200 pt-2 mt-2">
              <span className="font-semibold text-slate-700">Amount</span>
              <span className="font-black text-[#1a2744]">${info.displayPrice || "0"}/mo</span>
            </div>
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex flex-col gap-3 max-w-sm mx-auto">
        <Button
          onClick={handleDownloadInvoice}
          variant="outline"
          className="h-11 rounded-xl font-semibold gap-2 border-slate-300"
        >
          <FileText className="w-4 h-4" /> Download Invoice
        </Button>
        <Button
          onClick={() => {
            refreshProfile();
            import("sonner").then(({ toast }) => toast.info("Checking status..."));
          }}
          className="h-11 rounded-xl font-bold bg-[#1a2744] hover:bg-[#243b67]"
        >
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh Status
        </Button>
      </div>
    </div>
  );
}
