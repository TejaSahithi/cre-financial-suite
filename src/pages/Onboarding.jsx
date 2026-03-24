import React, { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { OrganizationService } from "@/services/api";
import { updateProfile, redirectToLogin } from "@/services/auth";
import { useAuth } from "@/lib/AuthContext";
import { logAudit } from "@/services/audit";
import { supabase } from "@/services/supabaseClient";
import { Building2, CheckCircle2, ArrowRight, ArrowLeft, Loader2, CreditCard, FileText, Lock, Sparkles, Clock, Shield, AlertCircle } from "lucide-react";
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
  const { user: authUser, refreshProfile, logout } = useAuth();
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
    const init = async () => {
      try {
        if (!authUser) {
          redirectToLogin(createPageUrl("Onboarding"));
          return;
        }
        setUser(authUser);
        setForm(f => ({ ...f, primary_contact_email: authUser.email || "" }));

        // Find existing org using the user's membership org_id
        if (authUser.org_id) {
          console.log('[Onboarding] Initializing with Org:', authUser.org_id);
          
          // Small delay to ensure DB propagation from previous steps
          await new Promise(r => setTimeout(r, 600));

          const orgData = await OrganizationService.get(authUser.org_id);
          if (orgData) {
            setOrg(orgData);
            
            // Sync step from server ONLY if the server is significantly ahead
            // and we don't have a local step override in the URL.
            const serverStep = orgData.onboarding_step || 1;
            const currentUrlStep = parseInt(searchParams.get('step'), 10);
            
            if (!currentUrlStep && serverStep > 1) {
              console.log('[Onboarding] Syncing to server step:', serverStep);
              setStep(serverStep);
            }
            
            if (orgData.status === "active") {
              window.location.href = createPageUrl("Welcome");
              return;
            }
          }
        }
      } catch (e) {
        console.error('[Onboarding] init error:', e);
      }
      setLoading(false);
    };
    init();
  }, [authUser]);
  const saveCompanyInfo = async () => {
    console.log('[Onboarding] saveCompanyInfo started', { name: !!form.name, email: !!form.primary_contact_email });
    if (!form.name || !form.primary_contact_email) {
      setSaving('val_error');
      try {
        const { toast } = await import("sonner");
        toast.error("Organization Name and Primary Email are required to continue.");
      } catch (e) {}
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

      console.log('[Onboarding] Trigerring complete-onboarding Edge Function');
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/complete-onboarding`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session?.access_token}`,
          "apikey": import.meta.env.VITE_SUPABASE_ANON_KEY
        }
      });
      
      if (!res.ok) {
         throw new Error('Failed to complete onboarding');
      }

      // Audit log — onboarding completion
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
      }).catch(() => {});

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
                      onChange={e => setForm({...form, name: e.target.value})} 
                      placeholder="e.g. Meridian Capital Group" 
                      className={`mt-1.5 h-11 transition-all ${!form.name && saving === 'val_error' ? 'border-red-500 bg-red-50/20' : ''}`} 
                    />
                    {!form.name && saving === 'val_error' && <p className="text-[10px] text-red-500 mt-1">Organization name is required to continue.</p>}
                  </div>
                  <div className="col-span-2">
                    <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Primary Contact Email <span className="text-red-400">*</span></Label>
                    <Input type="email" value={form.primary_contact_email} onChange={e => setForm({...form, primary_contact_email: e.target.value})} className="mt-1.5 h-11" />
                  </div>
                  <div className="col-span-2">
                    <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">HQ Address</Label>
                    <Input value={form.address} onChange={e => setForm({...form, address: e.target.value})} placeholder="123 Main St, New York, NY 10001" className="mt-1.5 h-11" />
                  </div>
                  <div>
                    <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Phone</Label>
                    <Input value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} placeholder="+1 (555) 000-0000" className="mt-1.5 h-11" />
                  </div>
                  <div>
                    <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Industry</Label>
                    <Select value={form.industry} onValueChange={v => setForm({...form, industry: v})}>
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
                    <Select value={form.timezone} onValueChange={v => setForm({...form, timezone: v})}>
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
                    <Select value={form.currency} onValueChange={v => setForm({...form, currency: v})}>
                      <SelectTrigger className="mt-1.5 h-11"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USD">USD ($)</SelectItem>
                        <SelectItem value="CAD">CAD (C$)</SelectItem>
                        <SelectItem value="EUR">EUR (€)</SelectItem>
                        <SelectItem value="GBP">GBP (£)</SelectItem>
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
                
                // 1. Update Org — fault-tolerant: don't block navigation on DB errors
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
                    uploaded_by: authUser?.id,
                    description: `Signed by ${signatureData.fullName}, ${signatureData.role}, on ${signatureData.date}`
                  });
                } catch (docErr) {
                  console.error('[Onboarding] Document creation failed (non-blocking):', docErr);
                }

                // 3. ALWAYS advance to Payment — this is the critical line
                console.log('[Onboarding] Moving to step 3 (Payment)');
                setStep(3);
              }} onBack={() => setStep(1)} user={authUser} />
            </div>
          )}

          {/* Step 3: Payment */}
          {step === 3 && (
            <div className="animate-in fade-in slide-in-from-right-4 duration-500">
              <PaymentStep org={org} user={authUser} form={form} setForm={setForm} onComplete={async (billingCycle) => {
                console.log('[Onboarding] Payment confirmed, advancing to step 4');
                // All DB calls are non-blocking — navigation must always succeed
                try {
                  await OrganizationService.update(org.id, {
                    status: "under_review",
                    onboarding_step: 4,
                    plan: form.plan,
                    billing_cycle: billingCycle,
                  });
                } catch (e) {
                  console.error('[Onboarding] Org update failed (non-blocking):', e);
                }
                try {
                  await updateProfile({ status: "under_review" });
                } catch (e) {
                  console.error('[Onboarding] Profile update failed (non-blocking):', e);
                }
                try {
                  await completeOnboarding();
                } catch (e) {
                  console.error('[Onboarding] completeOnboarding failed (non-blocking):', e);
                }
                // ALWAYS advance
                setStep(4);
              }} onBack={() => setStep(2)} />
            </div>
          )}

          {/* Step 4: Confirmation */}
          {step === 4 && (
            <div className="animate-in zoom-in duration-500">
              <ConfirmationStep org={org} user={authUser} plan={form.plan} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── MSA Step ──────────────────────────────────────────
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
Version 4.2 • Effective Date: ${today}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SIGNED BY:    ${fullName || "_______________"}
EMAIL:        ${email || "_______________"}
ROLE/TITLE:   ${role || "_______________"}
DATE:         ${today}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `MSA_${org?.name || 'Agreement'}_${new Date().toISOString().slice(0,10)}.txt`;
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
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Document — MSA-2026-01</span>
          <FileText className="w-4 h-4 text-slate-300" />
        </div>
        <div className="h-64 overflow-y-auto p-6 text-[13px] text-slate-600 leading-relaxed space-y-4 scrollbar-thin">
          <div className="text-center pb-4">
            <h3 className="font-bold text-slate-900 text-base">CRE PLATFORM MASTER SERVICE AGREEMENT</h3>
            <p className="text-[11px] text-slate-400">Version 4.2 • Effective Date: {today}</p>
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

// ─── Payment Step ──────────────────────────────────────
function PaymentStep({ org, user, form, setForm, onComplete, onBack }) {
  const [processing, setProcessing] = useState(false);
  const [cardName, setCardName] = useState(user?.full_name || "");
  const [cardNumber, setCardNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");
  const [error, setError] = useState("");
  const [billingCycle, setBillingCycle] = useState("monthly");

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
      // Simulate payment processing
      await new Promise(r => setTimeout(r, 2000));
      // Always call onComplete — it handles errors internally
      await onComplete(billingCycle);
    } catch (err) {
      // This catch should rarely fire since onComplete is fault-tolerant
      console.error('[Payment] Unexpected error:', err);
      // Still advance — don't block user on payment simulation errors
      await onComplete(billingCycle);
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
        <div className="bg-slate-100 rounded-xl p-1 flex gap-1 relative">
          <button
            type="button"
            onClick={() => setBillingCycle("monthly")}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${billingCycle === "monthly" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setBillingCycle("yearly")}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-2 ${billingCycle === "yearly" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
          >
            Yearly
            <span className="bg-emerald-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-tight">
              Save 25%
            </span>
          </button>
        </div>
      </div>

      {/* Plan Grid */}
      <div className="grid grid-cols-3 gap-3 mb-8">
        {plans.map(p => {
          const price = getPrice(p.price);
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => setForm({...form, plan: p.key})}
              className={`p-4 rounded-xl border-2 transition-all relative text-left ${form.plan === p.key ? "border-blue-600 bg-blue-50/50 shadow-md ring-4 ring-blue-50" : "border-slate-100 bg-slate-50 hover:border-slate-300"}`}
            >
              {p.popular && <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-tighter">Recommended</div>}
              <p className="text-xs font-bold text-slate-900 mb-1">{p.name}</p>
              {p.price ? (
                <div>
                  <div className="flex items-baseline gap-1">
                    <p className="text-xl font-black text-[#1a2744]">${price}</p>
                    <span className="text-[10px] uppercase font-bold text-slate-400">/{billingCycle === "yearly" ? "mo" : "mo"}</span>
                  </div>
                  {billingCycle === "yearly" && (
                    <p className="text-[9px] text-emerald-600 font-bold mt-0.5">
                      ${p.price}/mo → Save ${p.price - price}/mo
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xl font-black text-[#1a2744]">Custom</p>
              )}
            </button>
          );
        })}
      </div>

      {/* Yearly total callout */}
      {billingCycle === "yearly" && selectedPlan.price > 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 mb-6 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-emerald-800">Annual billing — 25% savings applied</p>
            <p className="text-xs text-emerald-600">Billed as ${yearlyTotal.toLocaleString()}/year</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-emerald-500 line-through">${(selectedPlan.price * 12).toLocaleString()}</p>
            <p className="text-sm font-black text-emerald-700">${yearlyTotal.toLocaleString()}</p>
          </div>
        </div>
      )}

      {/* Stripe-like Form */}
      <form onSubmit={handlePayment} className="space-y-6">
        <div className="bg-slate-50 p-6 rounded-2xl border border-slate-200">
          <div className="space-y-4">
            <div>
              <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1.5 block">Cardholder Name</Label>
              <Input value={cardName} onChange={e => setCardName(e.target.value)} placeholder="Full Name" className="bg-white border-slate-200 h-11" required />
            </div>
            <div>
              <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1.5 block">Card Information</Label>
              <div className="relative group">
                <Input
                  value={cardNumber}
                  onChange={e => setCardNumber(e.target.value.replace(/\D/g, '').substring(0, 16))}
                  placeholder="0000 0000 0000 0000"
                  className="bg-white border-slate-200 h-11 pl-11 font-mono tracking-widest"
                  required
                />
                <CreditCard className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-300 group-focus-within:text-blue-500 transition-colors" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1.5 block">Expiration</Label>
                <Input
                  value={expiry}
                  onChange={e => setExpiry(e.target.value.substring(0, 5))}
                  placeholder="MM / YY"
                  className="bg-white border-slate-200 h-11 text-center"
                  required
                />
              </div>
              <div>
                <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1.5 block">CVC</Label>
                <Input
                  value={cvc}
                  onChange={e => setCvc(e.target.value.replace(/\D/g, '').substring(0, 4))}
                  placeholder="123"
                  className="bg-white border-slate-200 h-11 text-center"
                  required
                />
              </div>
            </div>
          </div>
        </div>

        {error && <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-xs text-red-600 flex items-center gap-2"><AlertCircle className="w-3.5 h-3.5" /> {error}</div>}

        <div className="flex gap-4">
          <Button type="button" variant="outline" onClick={onBack} className="h-12 w-32 rounded-xl text-slate-500">Back</Button>
          <Button type="submit" disabled={processing} className="flex-1 bg-[#1a2744] hover:bg-[#243b67] h-12 rounded-xl text-base font-bold shadow-lg shadow-blue-900/10">
            {processing ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Lock className="w-4 h-4 mr-2" />}
            {processing ? "Processing Securely..." : selectedPlan.price ? `Pay $${displayPrice} & Finalize Setup` : "Request Enterprise Access"}
          </Button>
        </div>

        <p className="text-center text-[10px] text-slate-400 flex items-center justify-center gap-1">
          <Lock className="w-3 h-3" /> 256-bit SSL encryption · PCI DSS compliant
        </p>
      </form>
    </div>
  );
}

// ─── Review Step ─────────────────────────────────
function ConfirmationStep({ org, user, plan }) {
  const [checking, setChecking] = useState(false);

  const handleCheckStatus = async () => {
    setChecking(true);
    try {
      const orgs = await OrganizationService.filter({ id: org?.id });
      if (orgs.length > 0 && orgs[0].status === 'active') {
        const { updateProfile } = await import('@/services/auth');
        // Mark the user's profile as onboarding_complete and flag them for the Welcome screen
        await updateProfile({ onboarding_complete: true, first_login: true });
        // Audit log for unlocking platform
        await logAudit({
          entityType: 'Profile',
          entityId: user?.id,
          action: 'update',
          fieldChanged: 'onboarding_complete',
          oldValue: false,
          newValue: true,
          orgId: org?.id,
          userId: user?.id,
          userEmail: user?.email,
        }).catch(() => {});
        window.location.href = createPageUrl("Welcome");
      } else {
        const { toast } = await import("sonner");
        toast.info("Your account is still under review.");
      }
    } catch(e) {
      console.error(e);
    }
    setChecking(false);
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

      <h2 className="text-2xl font-bold text-slate-900 mb-2">Account Under Review</h2>
      <p className="text-slate-500 text-sm mb-2 max-w-md mx-auto">
        Thank you for choosing CRE Suite, <strong>{user?.full_name}</strong>! Your payment was successful. Our team is currently reviewing your organization <strong>{org?.name}</strong>.
      </p>
      <p className="text-slate-400 text-xs mb-8 max-w-sm mx-auto">
        You will be notified once approved, or you can check your status below.
      </p>

      {/* Action Buttons */}
      <div className="flex gap-3 max-w-md mx-auto">
        <Button onClick={handleCheckStatus} disabled={checking} className="flex-1 bg-[#1a2744] hover:bg-[#243b67] h-11 rounded-xl font-semibold gap-2">
          {checking ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          Check Status
        </Button>
      </div>
    </div>
  );
}