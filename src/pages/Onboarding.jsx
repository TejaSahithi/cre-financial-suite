import React, { useState, useEffect } from "react";
import { OrganizationService } from "@/services/api";
import { updateProfile, redirectToLogin } from "@/services/auth";
import { useAuth } from "@/lib/AuthContext";
import { logAudit } from "@/services/audit";
import { supabase } from "@/services/supabaseClient";
import { Building2, CheckCircle2, ArrowRight, ArrowLeft, Loader2, CreditCard, FileText, Lock, Sparkles, Clock } from "lucide-react";
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
  const [step, setStep] = useState(1);
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

        // Find existing org using the user's membership org_id (not email lookup)
        if (authUser.org_id) {
          const orgs = await OrganizationService.filter({ id: authUser.org_id });
          if (orgs.length > 0) {
            const existingOrg = orgs[0];
            setOrg(existingOrg);
            if (existingOrg.onboarding_step) {
              setStep(existingOrg.onboarding_step > 4 ? 4 : existingOrg.onboarding_step);
            }
            if (existingOrg.status === "active") {
              window.location.href = createPageUrl("Welcome");
              return;
            }
          }
        }
        // No org_id in membership → user is brand new, show step 1
      } catch (e) {
        console.error('[Onboarding] init error:', e);
      }
      setLoading(false);
    };
    init();
  }, [authUser]);


  const saveCompanyInfo = async () => {
    if (!form.name || !form.primary_contact_email) return;
    setSaving(true);
    try {
      let savedOrg;
      if (org) {
        savedOrg = await OrganizationService.update(org.id, { ...form, onboarding_step: 2 });
        console.log('[Onboarding] Updated org:', savedOrg?.id);
      } else {
        savedOrg = await OrganizationService.create({ ...form, status: "onboarding", onboarding_step: 2 });
        console.log('[Onboarding] Created org:', savedOrg?.id);

        // Create a membership for the org creator as org_admin
        if (savedOrg?.id && authUser?.id && supabase) {
          const { error: memErr } = await supabase.from('memberships').upsert({
            user_id: authUser.id,
            org_id: savedOrg.id,
            role: 'org_admin',
          }, { onConflict: 'user_id,org_id' });
          if (memErr) console.error('[Onboarding] membership create error:', memErr);
          else console.log('[Onboarding] Created org_admin membership for', authUser.email);
        }
      }
      setOrg(savedOrg);
      setStep(2);
      console.log('[Onboarding] Moving to step 2 (MSA)');
    } catch (e) {
      console.error('[Onboarding] save error:', e);
    } finally {
      setSaving(false);
    }
  };

  // Called when the final step (Confirmation) is reached
  const completeOnboarding = async () => {
    try {
      // Advance step visually
      if (org) {
        await OrganizationService.update(org.id, { onboarding_step: 5 });
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
      <div className="bg-white border-b border-slate-200">
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
      <div className="flex-1 flex items-start justify-center p-6 pt-10">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200/50 max-w-2xl w-full p-8">

          {/* Step 1: Company Info */}
          {step === 1 && (
            <div>
              <div className="mb-6">
                <h2 className="text-2xl font-bold text-slate-900 mb-1">Company Information</h2>
                <p className="text-slate-500 text-sm">Tell us about your organization to personalize your experience.</p>
              </div>
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2">
                    <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Organization Name <span className="text-red-400">*</span></Label>
                    <Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="e.g. Meridian Capital Group" className="mt-1.5 h-11" />
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
              <Button onClick={saveCompanyInfo} disabled={saving || !form.name} className="w-full mt-8 bg-[#1a2744] hover:bg-[#243b67] h-12 rounded-xl font-semibold gap-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Continue to Agreement <ArrowRight className="w-4 h-4" />
              </Button>
            </div>
          )}

          {/* Step 2: MSA */}
          {step === 2 && (
            <MSAStep org={org} onNext={async () => {
              console.log('[Onboarding] MSA signed, updating org', org?.id);
              await OrganizationService.update(org.id, {
                onboarding_step: 3,
                msa_signed: true,
                msa_signed_date: new Date().toISOString(),
                msa_signed_by: user?.email,
              });
              console.log('[Onboarding] Moving to step 3 (Payment)');
              setStep(3);
            }} onBack={() => setStep(1)} user={user} />
          )}

          {/* Step 3: Payment */}
          {step === 3 && (
            <PaymentStep org={org} user={user} form={form} setForm={setForm} onComplete={async () => {
              console.log('[Onboarding] Payment confirmed, setting org to pending_approval', org?.id);
              await OrganizationService.update(org.id, {
                status: "pending_approval",
                onboarding_step: 4,
                plan: form.plan,
              });
              
              console.log('[Onboarding] Marking onboarding step 4 in profile');
              await updateProfile({ onboarding_step: 4 });

              console.log('[Onboarding] Moving to step 4 (Review)');
              setStep(4);
            }} onBack={() => setStep(2)} />
          )}

          {/* Step 4: Confirmation */}
          {step === 4 && (
            <ConfirmationStep org={org} user={user} plan={form.plan} />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── MSA Step ──────────────────────────────────────────
function MSAStep({ org, onNext, onBack, user }) {
  const [accepted, setAccepted] = useState(false);
  const [signature, setSignature] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSign = async () => {
    setSaving(true);
    try {
      await onNext();
    } catch (e) {
      console.error('[Onboarding][MSA] handleSign error:', e);
    } finally {
      setSaving(false);
    }
  };

  const canProceed = accepted && signature.trim().length >= 2;

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-slate-900 mb-1">Master Service Agreement</h2>
        <p className="text-slate-500 text-sm">Review and sign the MSA to proceed with your account setup.</p>
      </div>

      {/* Document */}
      <div className="border border-slate-200 rounded-xl h-64 overflow-y-auto p-5 bg-slate-50 text-xs text-slate-600 leading-relaxed mb-5 space-y-3 scrollbar-thin">
        <p className="font-bold text-sm text-slate-900">MASTER SERVICE AGREEMENT</p>
        <p>This Master Service Agreement ("Agreement") is entered into between CRE Platform, Inc. ("Provider") and the subscribing organization ("Client").</p>
        <p><strong>1. Services.</strong> Provider will make the CRE Budgeting & CAM Automation Platform available to Client on a subscription basis, subject to the terms of this Agreement.</p>
        <p><strong>2. Payment.</strong> Client agrees to pay all fees according to the selected plan. Fees are billed in advance on a monthly or annual basis.</p>
        <p><strong>3. Data Security.</strong> Provider will use commercially reasonable measures to protect Client data. All data is isolated per organization and encrypted at rest and in transit.</p>
        <p><strong>4. Confidentiality.</strong> Each party agrees to maintain the confidentiality of the other party's proprietary information.</p>
        <p><strong>5. Intellectual Property.</strong> Client retains ownership of all data submitted to the platform. Provider retains ownership of the platform software.</p>
        <p><strong>6. Term and Termination.</strong> This Agreement commences on the date of signature and continues until terminated by either party with 30 days written notice.</p>
        <p><strong>7. Limitation of Liability.</strong> Provider's total liability shall not exceed the fees paid in the three months preceding the claim.</p>
        <p><strong>8. Governing Law.</strong> This Agreement is governed by the laws of the State of Delaware.</p>
        <p><strong>9. Entire Agreement.</strong> This Agreement constitutes the entire agreement between the parties and supersedes all prior negotiations.</p>
        <p className="text-slate-400">Last updated: January 1, 2026</p>
      </div>

      {/* Agreement Checkbox */}
      <div className="flex items-start gap-3 mb-5 p-4 bg-blue-50 border border-blue-100 rounded-xl">
        <input type="checkbox" id="accept" checked={accepted} onChange={e => setAccepted(e.target.checked)} className="mt-0.5 w-4 h-4 cursor-pointer rounded" />
        <label htmlFor="accept" className="text-sm text-slate-700 cursor-pointer leading-relaxed">
          I, <strong>{user?.full_name || "Authorized Representative"}</strong>, on behalf of <strong>{org?.name}</strong>, have read and agree to the Master Service Agreement. This constitutes a legally binding electronic signature.
        </label>
      </div>

      {/* Digital Signature */}
      <div className="mb-6">
        <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Digital Signature <span className="text-red-400">*</span></Label>
        <p className="text-[11px] text-slate-400 mb-2">Type your full legal name as your electronic signature.</p>
        <Input
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          placeholder={user?.full_name || "Full Legal Name"}
          className="mt-1 h-12 text-lg italic font-serif border-dashed border-2 border-slate-300 focus:border-blue-400 text-slate-800"
        />
        {signature && (
          <p className="text-[11px] text-emerald-600 mt-1.5 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Signed as: {signature}
          </p>
        )}
      </div>

      {/* Buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="gap-2 h-12 rounded-xl">
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <Button onClick={handleSign} disabled={!canProceed || saving} className="flex-1 bg-[#1a2744] hover:bg-[#243b67] h-12 rounded-xl font-semibold gap-2">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Sign & Continue to Payment <ArrowRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

// ─── Payment Step ──────────────────────────────────────
function PaymentStep({ org, user, form, setForm, onComplete, onBack }) {
  const [processing, setProcessing] = useState(false);

  const plans = [
    { key: "starter", name: "Starter", price: 499, desc: "For small teams managing up to 10 properties", features: ["5 Users", "10 Properties", "Basic CAM", "Email Support"] },
    { key: "professional", name: "Professional", price: 1499, desc: "For growing portfolios with advanced needs", features: ["25 Users", "100 Properties", "AI Budget Engine", "Priority Support"], popular: true },
    { key: "enterprise", name: "Enterprise", price: null, desc: "Custom solutions for large-scale operations", features: ["Unlimited Users", "Unlimited Properties", "Custom Integrations", "Dedicated CSM"] },
  ];

  const selectedPlan = plans.find(p => p.key === form.plan) || plans[1];
  const price = selectedPlan.price;

  const handlePayment = async () => {
    setProcessing(true);
    try {
      await new Promise(r => setTimeout(r, 2000));
      await onComplete();
    } catch (e) {
      console.error('[Onboarding][Payment] handlePayment error:', e);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-slate-900 mb-1">Select Plan & Payment</h2>
        <p className="text-slate-500 text-sm">Choose a plan and enter your billing details to activate.</p>
      </div>

      {/* Plan Selection */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {plans.map(plan => (
          <button
            key={plan.key}
            onClick={() => setForm({ ...form, plan: plan.key })}
            className={`relative p-4 rounded-xl border-2 text-left transition-all ${
              form.plan === plan.key
                ? "border-blue-500 bg-blue-50/50 shadow-sm"
                : "border-slate-200 hover:border-slate-300"
            }`}
          >
            {plan.popular && (
              <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[10px] font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> Popular
              </span>
            )}
            <p className="text-sm font-bold text-slate-900 mb-0.5">{plan.name}</p>
            <p className="text-lg font-bold text-[#1a2744]">
              {plan.price ? `$${plan.price}` : "Custom"}
              {plan.price && <span className="text-xs font-normal text-slate-400">/mo</span>}
            </p>
            <p className="text-[10px] text-slate-400 mt-1 leading-snug">{plan.desc}</p>
            <div className="mt-3 space-y-1">
              {plan.features.map((f, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                  <span className="text-[11px] text-slate-600">{f}</span>
                </div>
              ))}
            </div>
          </button>
        ))}
      </div>

      {/* Order Summary */}
      <div className="bg-slate-50 rounded-xl p-5 mb-6 border border-slate-100">
        <p className="text-xs font-semibold text-slate-500 uppercase mb-3">Order Summary</p>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-slate-700">{selectedPlan.name} Plan – Monthly</span>
          <span className="text-sm font-bold text-slate-900">{price ? `$${price}/mo` : "Contact Sales"}</span>
        </div>
        <div className="text-xs text-slate-400 mb-3">Billed monthly, cancel anytime</div>
        <div className="border-t border-slate-200 pt-3 flex items-center justify-between">
          <span className="text-sm font-bold text-slate-900">Due Today</span>
          <span className="text-xl font-bold text-[#1a2744]">{price ? `$${price}` : "—"}</span>
        </div>
      </div>

      {/* Payment Form */}
      {price && (
        <div className="space-y-4 mb-6">
          <div>
            <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Cardholder Name</Label>
            <Input placeholder="Jane Smith" className="mt-1.5 h-11" defaultValue={user?.full_name} />
          </div>
          <div>
            <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Card Number</Label>
            <div className="relative mt-1.5">
              <CreditCard className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input placeholder="4242 4242 4242 4242" className="h-11 pl-10" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Expiry</Label>
              <Input placeholder="MM / YY" className="mt-1.5 h-11" />
            </div>
            <div>
              <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">CVC</Label>
              <Input placeholder="123" className="mt-1.5 h-11" />
            </div>
          </div>
          <div>
            <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Billing Email</Label>
            <Input type="email" defaultValue={user?.email} className="mt-1.5 h-11" />
          </div>
        </div>
      )}

      {/* Security Note */}
      <div className="flex items-center gap-2 mb-6 text-xs text-slate-400 bg-slate-50 rounded-lg p-3 border border-slate-100">
        <Lock className="w-4 h-4 text-slate-300 flex-shrink-0" />
        <span>Your payment is secured with 256-bit SSL encryption. We never store card details.</span>
      </div>

      {/* Buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="gap-2 h-12 rounded-xl">
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <Button onClick={handlePayment} disabled={processing || !price} className="flex-1 bg-[#1a2744] hover:bg-[#243b67] h-12 rounded-xl text-base font-semibold gap-2">
          {processing ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
          {processing ? "Processing..." : `Pay $${price || 0} & Activate`}
        </Button>
      </div>
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