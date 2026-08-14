import React, { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from 'react-router-dom';
import { OrganizationService } from "@/services/api";
import { redirectToLogin } from "@/services/auth";
import { ensureOnboardingOrganization } from "@/services/onboardingService";
import { useAuth } from "@/lib/AuthContext";
import { supabase } from "@/services/supabaseClient";
import { Building2, CheckCircle2, ArrowRight, ArrowLeft, Loader2, CreditCard, FileText, Lock, Shield, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createPageUrl } from "@/utils";
import ProFormaBrand from "@/components/ProFormaBrand";

const steps = [
  { id: 1, label: "Company Setup", icon: Building2 },
  { id: 2, label: "Agreement", icon: FileText },
  { id: 3, label: "Payment", icon: CreditCard },
  { id: 4, label: "Confirmation", icon: CheckCircle2 },
];

const COUNTRY_OPTIONS = [
  { value: "US", label: "United States" },
  { value: "CA", label: "Canada" },
];

const STATE_OPTIONS = [
  { value: "AL", label: "Alabama" },
  { value: "AK", label: "Alaska" },
  { value: "AZ", label: "Arizona" },
  { value: "AR", label: "Arkansas" },
  { value: "CA", label: "California" },
  { value: "CO", label: "Colorado" },
  { value: "CT", label: "Connecticut" },
  { value: "DE", label: "Delaware" },
  { value: "FL", label: "Florida" },
  { value: "GA", label: "Georgia" },
  { value: "HI", label: "Hawaii" },
  { value: "ID", label: "Idaho" },
  { value: "IL", label: "Illinois" },
  { value: "IN", label: "Indiana" },
  { value: "IA", label: "Iowa" },
  { value: "KS", label: "Kansas" },
  { value: "KY", label: "Kentucky" },
  { value: "LA", label: "Louisiana" },
  { value: "ME", label: "Maine" },
  { value: "MD", label: "Maryland" },
  { value: "MA", label: "Massachusetts" },
  { value: "MI", label: "Michigan" },
  { value: "MN", label: "Minnesota" },
  { value: "MS", label: "Mississippi" },
  { value: "MO", label: "Missouri" },
  { value: "MT", label: "Montana" },
  { value: "NE", label: "Nebraska" },
  { value: "NV", label: "Nevada" },
  { value: "NH", label: "New Hampshire" },
  { value: "NJ", label: "New Jersey" },
  { value: "NM", label: "New Mexico" },
  { value: "NY", label: "New York" },
  { value: "NC", label: "North Carolina" },
  { value: "ND", label: "North Dakota" },
  { value: "OH", label: "Ohio" },
  { value: "OK", label: "Oklahoma" },
  { value: "OR", label: "Oregon" },
  { value: "PA", label: "Pennsylvania" },
  { value: "RI", label: "Rhode Island" },
  { value: "SC", label: "South Carolina" },
  { value: "SD", label: "South Dakota" },
  { value: "TN", label: "Tennessee" },
  { value: "TX", label: "Texas" },
  { value: "UT", label: "Utah" },
  { value: "VT", label: "Vermont" },
  { value: "VA", label: "Virginia" },
  { value: "WA", label: "Washington" },
  { value: "WV", label: "West Virginia" },
  { value: "WI", label: "Wisconsin" },
  { value: "WY", label: "Wyoming" },
  { value: "DC", label: "District of Columbia" },
];

const US_ZIP_REGEX = /^\d{5}(?:-\d{4})?$/;
const CA_POSTAL_REGEX = /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/;
const OWNER_ONBOARDING_ROLES = new Set(["super_admin", "org_owner", "org_admin", "owner", "admin"]);

function formatBillingAddress({ addressLine1, city, state, postalCode, countryCode }) {
  return [
    addressLine1,
    [city, state].filter(Boolean).join(", "),
    [postalCode, countryCode].filter(Boolean).join(" "),
  ].filter(Boolean).join(", ");
}

function getOnboardingStepStorageKey(userId) {
  return userId ? `cre:onboarding-step:${userId}` : null;
}

export default function Onboarding() {
  const { user: authUser, refreshProfile, logout, isLoadingAuth } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const step = parseInt(searchParams.get('step') || '1', 10);
  const stepStorageKey = getOnboardingStepStorageKey(authUser?.id);
  const setStep = (newStep) => {
    if (stepStorageKey) {
      sessionStorage.setItem(stepStorageKey, newStep.toString());
    }
    setSearchParams({ step: newStep.toString() });
  };
  const [user, setUser] = useState(null);
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const userOnboardingType = authUser?.profile?.onboarding_type || authUser?.onboarding_type;
  const isInvitedMember = userOnboardingType === "invited" || authUser?.memberships?.some((membership) => {
    const role = membership?.role;
    return role && !OWNER_ONBOARDING_ROLES.has(role);
  });

  const [form, setForm] = useState({
    name: "", address: "", phone: "", timezone: "America/New_York",
    currency: "USD", primary_contact_email: "", plan: "professional",
    industry: "commercial_re"
  });

  useEffect(() => {
    // Only block if we have no user AND auth is still loading
    // If we already have authUser, proceed even if isLoadingAuth is true
    if (isLoadingAuth && !authUser) {
      return;
    }

    let cancelled = false;

    // Safety timeout — if init takes more than 8s, unblock the page anyway
    const safetyTimer = setTimeout(() => {
      if (!cancelled) {
        console.warn('[Onboarding] Init timeout — unblocking page');
        setLoading(false);
      }
    }, 8000);

    const init = async () => {
      try {
        if (!authUser) {
          console.log('[Onboarding] No authenticated user, redirecting to login');
          redirectToLogin(createPageUrl("Onboarding"));
          setLoading(false);
          return;
        }

        if (isInvitedMember) {
          console.log("[Onboarding] Invited team member detected; redirecting to member onboarding.");
          navigate("/WelcomeAboard", { replace: true });
          setLoading(false);
          return;
        }

        setUser(authUser);
        setForm(f => ({ ...f, primary_contact_email: authUser.email || "" }));

        const findMembershipOrgId = async () => {
          const { data, error } = await supabase
            .from("memberships")
            .select("org_id, role, created_at")
            .eq("user_id", authUser.id)
            .order("created_at", { ascending: true });

          if (error) {
            console.error("[Onboarding] membership lookup failed:", error);
            return null;
          }

          const memberships = data || [];
          const primaryMembership = memberships.find((membership) => membership.role === "org_admin") || memberships[0];
          return primaryMembership?.org_id || null;
        };

        let resolvedUser = authUser;
        let resolvedOrgId = authUser.org_id || await findMembershipOrgId();

        // Note: first-login org initialization is handled by App.jsx.
        // Onboarding just waits for the org to be available.
        // If no org yet, render step 1 and let the user fill in company info.
        if (!resolvedOrgId) {
          console.log("[Onboarding] No org found yet — rendering step 1 for user to fill in");
        }

        if (resolvedOrgId) {
          console.log("[Onboarding] Initializing with Org:", resolvedOrgId);
          let orgData = await OrganizationService.get(resolvedOrgId);
          console.log("[Onboarding] Org data fetched:", { found: !!orgData, status: orgData?.status, step: orgData?.onboarding_step });

          if (!orgData && resolvedOrgId && authUser?.id) {
            console.warn("[Onboarding] Org record missing in DB, self-healing with ID:", resolvedOrgId);
            try {
              const { data: newOrg } = await supabase
                .from("organizations")
                .upsert({
                  id: resolvedOrgId,
                  name: authUser?.user_metadata?.company_name || "My Organization",
                  status: "onboarding",
                  onboarding_step: 1,
                  primary_contact_email: authUser?.email,
                  created_by: authUser?.id,
                  updated_at: new Date().toISOString(),
                })
                .select()
                .single();
              if (newOrg) {
                orgData = newOrg;
              }
            } catch (err) {
              console.error("[Onboarding] Auto-provisioning org failed:", err);
            }
          }

          if (orgData) {
            setOrg(orgData);
            setForm((prev) => ({
              ...prev,
              name: orgData.name || prev.name,
              address: orgData.address || prev.address,
              phone: orgData.phone || prev.phone,
              timezone: orgData.timezone || prev.timezone,
              currency: orgData.currency || prev.currency,
              primary_contact_email: orgData.primary_contact_email || resolvedUser.email || prev.primary_contact_email,
              plan: orgData.plan || prev.plan,
              industry: orgData.industry || prev.industry,
            }));

            if (orgData.status === "under_review") {
              console.log("[Onboarding] Org is under review, redirecting to success page");
              if (stepStorageKey) {
                sessionStorage.setItem(stepStorageKey, "4");
              }
              navigate("/PaymentSuccess", { replace: true });
              return;
            }

            const serverStep = orgData.onboarding_step || 1;
            const hasExplicitStepInUrl = !!new URLSearchParams(window.location.search).get("step");
            const storedStep = stepStorageKey
              ? parseInt(sessionStorage.getItem(stepStorageKey) || "1", 10)
              : 1;
            const desiredStep = Math.max(serverStep, storedStep || 1);

            if (!hasExplicitStepInUrl && desiredStep > 1) {
              console.log("[Onboarding] Syncing to onboarding step:", desiredStep);
              setStep(desiredStep);
            }
          }
        } else if (step > 1 && !org?.id) {
          console.warn("[Onboarding] No organization resolved yet for a later onboarding step; preserving current step while auth state settles");
        }
      } catch (e) {
        console.error('[Onboarding] init error:', e);
      } finally {
        if (!cancelled) setLoading(false);
        clearTimeout(safetyTimer);
      }
    };
    init();

    return () => { cancelled = true; clearTimeout(safetyTimer); };

  }, [authUser, isInvitedMember, isLoadingAuth, navigate, refreshProfile]);

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
      let targetOrg = org;

      if (!targetOrg) {
        console.warn("[Onboarding] No org attached yet. Initializing onboarding org via server.");
        await ensureOnboardingOrganization();
        const refreshedUser = await refreshProfile(false).catch(() => null);
        targetOrg = refreshedUser?.activeOrg || null;

        if (!targetOrg?.id && authUser?.id) {
          const { data: memberships, error: membershipError } = await supabase
            .from("memberships")
            .select("org_id, role, created_at")
            .eq("user_id", authUser.id)
            .order("created_at", { ascending: true });

          if (membershipError) {
            throw membershipError;
          }

          const primaryMembership = (memberships || []).find((membership) => membership.role === "org_admin") || memberships?.[0];
          if (primaryMembership?.org_id) {
            targetOrg = await OrganizationService.get(primaryMembership.org_id);
          }
        }
      }

      if (!targetOrg?.id) {
        throw new Error("Unable to initialize your organization. Please refresh and try again.");
      }

      if (targetOrg?.id) {
        console.log('[Onboarding] Persisting company info for org:', targetOrg.id);
        const orgPayload = {
          id: targetOrg.id,
          name: form.name,
          address: form.address || null,
          phone: form.phone || null,
          timezone: form.timezone || 'America/New_York',
          currency: form.currency || 'USD',
          primary_contact_email: form.primary_contact_email,
          industry: form.industry || 'commercial_re',
          plan: form.plan || 'professional',
          onboarding_step: 2,
          updated_at: new Date().toISOString(),
        };

        // Upsert directly into Supabase organizations table to ensure row physically exists
        const { data: upsertedOrg, error: upsertErr } = await supabase
          .from('organizations')
          .upsert(orgPayload)
          .select()
          .single();

        if (upsertErr || !upsertedOrg) {
          console.warn('[Onboarding] Supabase direct upsert error, using fallback:', upsertErr);
          savedOrg = await OrganizationService.update(targetOrg.id, { ...form, onboarding_step: 2 });
        } else {
          savedOrg = upsertedOrg;
        }
      }

      if (savedOrg?.id) {
        const confirmedOrg = await OrganizationService.get(savedOrg.id);
        savedOrg = confirmedOrg || savedOrg;
      }

      await refreshProfile(false).catch(() => null);

      console.log('[Onboarding] Save success, moving to step 2');
      setOrg((prevOrg) => ({
        ...prevOrg,
        ...savedOrg,
        ...form,
        onboarding_step: 2,
      }));
      setStep(2);
      toast.success("Company information saved!", { id: loadingToast });
    } catch (e) {
      console.error('[Onboarding] save error:', e);
      toast.error(e.message || "Failed to save company information", { id: loadingToast });
    } finally {
      setSaving(false);
    }
  };


  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--muted)] mx-auto mb-3" />
          <p className="text-sm text-[var(--muted)]">Loading your account...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] flex flex-col">
      {/* Header */}
      <div className="bg-[var(--ink)] px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <ProFormaBrand tone="light" className="pf-page-brand" />
          <div className="ml-auto flex items-center gap-4">
            <span className="text-[color-mix(in_srgb,var(--surface)_60%,transparent)] text-sm">Account Setup</span>
            <Button variant="ghost" size="sm" className="text-white/70 hover:text-white hover:bg-[color-mix(in_srgb,var(--surface)_18%,transparent)]" onClick={() => logout(true)}>
              Sign Out
            </Button>
          </div>
        </div>
      </div>

      {/* Progress Steps */}
      <div className="bg-[var(--surface)] border-b border-[var(--border-cre)] shadow-[var(--shadow-soft)] sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-6 py-5">
          <div className="flex items-center gap-0">
            {steps.map((s, i) => (
              <React.Fragment key={s.id}>
                <div className="flex items-center gap-2.5">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300
                    ${step > s.id ? 'bg-[var(--success)] text-white shadow-[var(--shadow-soft)] shadow-[var(--shadow-soft)]' : step === s.id ? 'bg-[var(--ink)] text-white shadow-[var(--shadow-soft)]' : 'bg-[var(--surface-2)] text-[var(--muted)] border border-[var(--border-cre)]'}`}>
                    {step > s.id ? <CheckCircle2 className="w-4 h-4" /> : s.id}
                  </div>
                  <span className={`text-sm font-medium hidden sm:inline ${step === s.id ? 'text-[var(--ink)] font-semibold' : step > s.id ? 'text-[var(--success)]' : 'text-[var(--muted)]'}`}>
                    {s.label}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <div className="flex-1 mx-4 h-px relative">
                    <div className="absolute inset-0 bg-[var(--border-cre)]" />
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
        <div className="bg-[var(--surface)] rounded-[8px] shadow-[var(--shadow)] border border-[var(--border-cre)] max-w-2xl w-full p-8 mb-10">

          {/* Step 1: Company Info */}
          {step === 1 && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="mb-6">
                <h2 className="text-2xl font-bold text-[var(--ink)] mb-1">Company Information</h2>
                <p className="text-[var(--muted)] text-sm">Tell us about your organization to personalize your experience.</p>
              </div>
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2">
                    <Label className={`text-xs font-semibold uppercase tracking-wider ${!form.name ? 'text-[var(--muted)]' : 'text-[var(--muted)]'}`}>
                      Organization Name <span className="text-red-400">*</span>
                    </Label>
                    <Input
                      value={form.name}
                      onChange={e => setForm({ ...form, name: e.target.value })}
                      placeholder="e.g. Meridian Capital Group"
                      className={`mt-1.5 h-11 transition-all ${!form.name && saving === 'val_error' ? 'border-[var(--danger)] bg-[var(--danger-soft)]' : ''}`}
                    />
                    {!form.name && saving === 'val_error' && <p className="text-[10px] text-[var(--danger)] mt-1">Organization name is required to continue.</p>}
                  </div>
                  <div className="col-span-2">
                    <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">Primary Contact Email <span className="text-red-400">*</span></Label>
                    <Input type="email" value={form.primary_contact_email} onChange={e => setForm({ ...form, primary_contact_email: e.target.value })} className="mt-1.5 h-11" />
                  </div>
                  <div className="col-span-2">
                    <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">HQ Address</Label>
                    <Input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="123 Main St, New York, NY 10001" className="mt-1.5 h-11" />
                  </div>
                  <div>
                    <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">Phone</Label>
                    <Input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="+1 (555) 000-0000" className="mt-1.5 h-11" />
                  </div>
                  <div>
                    <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">Industry</Label>
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
                    <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">Timezone</Label>
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
                    <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">Currency</Label>
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
                className="w-full mt-8 bg-[var(--ink)] hover:bg-[var(--ink)] h-12 rounded-[8px] font-semibold gap-2 transition-all shadow-[var(--shadow-soft)] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
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
              <PaymentStep org={org} user={authUser} form={form} setForm={setForm} onBack={() => setStep(2)} />
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
function ConfirmationStep({ org, user, plan }) {
  const navigate = useNavigate();
  const orgStatus = String(org?.status || user?.profile?.status || user?.status || "").toLowerCase();
  const isActive = orgStatus === "active";
  const isUnderReview = orgStatus === "under_review" || orgStatus === "approved" || orgStatus === "pending_approval";
  const planLabel = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "Professional";

  return (
    <div className="text-center">
      <div className={`mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-[8px] ${isActive ? "bg-[var(--success-soft)] text-[var(--success)]" : "bg-[var(--accent-soft)] text-[var(--accent)]"}`}>
        <CheckCircle2 className="h-9 w-9" />
      </div>

      <h2 className="mb-2 text-2xl font-bold text-[var(--ink)]">
        {isActive ? "Your workspace is active" : "Application submitted"}
      </h2>
      <p className="mx-auto mb-6 max-w-xl text-sm leading-relaxed text-[var(--muted)]">
        {isActive
          ? "Your organization has been approved and your ProForma OS workspace is ready."
          : "Your onboarding package has been received. We are reviewing your organization and subscription details."}
      </p>

      <div className="mb-6 grid grid-cols-1 gap-3 text-left md:grid-cols-3">
        <div className="rounded-[8px] border border-[var(--border-cre)] bg-[var(--bg)] p-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--muted)]">Organization</p>
          <p className="mt-1 truncate text-sm font-semibold text-[var(--ink)]">{org?.name || "Your organization"}</p>
        </div>
        <div className="rounded-[8px] border border-[var(--border-cre)] bg-[var(--bg)] p-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--muted)]">Plan</p>
          <p className="mt-1 text-sm font-semibold text-[var(--ink)]">{planLabel}</p>
        </div>
        <div className="rounded-[8px] border border-[var(--border-cre)] bg-[var(--bg)] p-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--muted)]">Status</p>
          <p className="mt-1 text-sm font-semibold text-[var(--ink)]">
            {isActive ? "Active" : isUnderReview ? "Under review" : "Pending"}
          </p>
        </div>
      </div>

      <div className="flex flex-col justify-center gap-3 sm:flex-row">
        {isActive ? (
          <Button onClick={() => navigate(createPageUrl("Dashboard"))} className="h-12 rounded-[8px] bg-[var(--ink)] px-8 font-semibold hover:bg-[var(--ink)]">
            Open Dashboard
          </Button>
        ) : (
          <Button onClick={() => navigate(createPageUrl("PaymentSuccess"))} className="h-12 rounded-[8px] bg-[var(--ink)] px-8 font-semibold hover:bg-[var(--ink)]">
            View Approval Status
          </Button>
        )}
        <Button variant="outline" onClick={() => window.location.reload()} className="h-12 rounded-[8px] px-8">
          Refresh Status
        </Button>
      </div>
    </div>
  );
}
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
PROFORMA OS MASTER SERVICE AGREEMENT
Version 4.2 â€¢ Effective Date: ${today}
â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”

This Master Service Agreement ("Agreement") is entered into between
ProForma OS, Inc. ("Provider") and the organization
${org?.name || "The Client"} ("Client").

1. SCOPE OF SERVICE
Provider shall provide Client with access to the ProForma OS cloud-based
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
        <h2 className="text-2xl font-bold text-[var(--ink)] mb-1">Master Service Agreement</h2>
        <p className="text-[var(--muted)] text-sm">Review, sign, and download to complete your enterprise activation.</p>
      </div>

      {/* Document Viewer */}
      <div className="border border-[var(--border-cre)] rounded-[8px] bg-[var(--bg)] mb-6 flex flex-col overflow-hidden">
        <div className="bg-[var(--surface-2)] px-4 py-2 border-b border-[var(--border-cre)] flex items-center justify-between">
          <span className="text-[10px] font-bold text-[var(--muted)] uppercase tracking-widest">Document â€” MSA-2026-01</span>
          <FileText className="w-4 h-4 text-[var(--muted)]" />
        </div>
        <div className="h-64 overflow-y-auto p-6 text-[13px] text-[var(--muted)] leading-relaxed space-y-4 scrollbar-thin">
          <div className="text-center pb-4">
            <h3 className="font-bold text-[var(--ink)] text-base">PROFORMA OS MASTER SERVICE AGREEMENT</h3>
            <p className="text-[11px] text-[var(--muted)]">Version 4.2 â€¢ Effective Date: {today}</p>
          </div>
          <p>This Master Service Agreement ("Agreement") is entered into between <strong>ProForma OS, Inc.</strong> ("Provider") and the organization <strong>{org?.name || "The Client"}</strong> ("Client").</p>
          <p><strong>1. Scope of Service.</strong> Provider shall provide Client with access to the ProForma OS cloud-based platform for commercial real estate portfolio management and automation.</p>
          <p><strong>2. Subscription Term.</strong> The term of this Agreement shall begin on the date of execution and continue for the duration of the selected subscription plan, renewing automatically unless cancelled.</p>
          <p><strong>3. Payment Terms.</strong> Client agrees to pay all applicable fees via the authorized payment method. All fees are non-refundable except as expressly stated herein.</p>
          <p><strong>4. Confidentiality & Data.</strong> Client retains all rights to its data. Provider implements bank-grade security and isolation to protect Client information.</p>
          <p><strong>5. Acceptance of Terms.</strong> By signing below, Client acknowledges they have read, understood, and agree to be bound by the terms and conditions set forth in this document.</p>

          {/* Signature block inside document */}
          <div className="pt-8 border-t border-[var(--border-cre)]">
            <div className="grid grid-cols-2 gap-6">
              <div>
                <p className="text-[10px] text-[var(--muted)] mb-1">Signed By:</p>
                <p className="text-lg italic font-sans text-[var(--ink)] border-b border-[var(--border-cre)] min-h-[28px]">{fullName}</p>
              </div>
              <div>
                <p className="text-[10px] text-[var(--muted)] mb-1">Date:</p>
                <p className="text-sm font-medium text-[var(--ink)]">{today}</p>
              </div>
              <div>
                <p className="text-[10px] text-[var(--muted)] mb-1">Role/Title:</p>
                <p className="text-sm text-[var(--ink)] border-b border-[var(--border-cre)] min-h-[20px]">{role}</p>
              </div>
              <div>
                <p className="text-[10px] text-[var(--muted)] mb-1">Email:</p>
                <p className="text-sm text-[var(--ink)] border-b border-[var(--border-cre)] min-h-[20px]">{email}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Signatory Details */}
      <div className="bg-[var(--bg)] border border-[var(--border-cre)] rounded-[8px] p-5 mb-6 space-y-4">
        <h3 className="text-xs font-bold text-[var(--muted)] uppercase tracking-widest">Signatory Details</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">Full Name <span className="text-red-400">*</span></Label>
            <Input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Full Legal Name" className="mt-1.5 h-11" />
          </div>
          <div>
            <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">Email <span className="text-red-400">*</span></Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" className="mt-1.5 h-11" />
          </div>
          <div>
            <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">Role / Title <span className="text-red-400">*</span></Label>
            <Input value={role} onChange={e => setRole(e.target.value)} placeholder="e.g. CEO, Director of Finance" className="mt-1.5 h-11" />
          </div>
          <div>
            <Label className="text-[var(--muted)] text-xs font-semibold uppercase tracking-wider">Date</Label>
            <Input value={today} readOnly className="mt-1.5 h-11 bg-[var(--surface-2)] text-[var(--muted)] cursor-not-allowed" />
          </div>
        </div>
      </div>

      {/* Consent Checkbox */}
      <div className={`flex items-start gap-3 mb-6 p-4 rounded-[8px] border transition-all ${accepted ? 'bg-[var(--accent-soft)] border-[var(--border-cre)]' : 'bg-[var(--bg)] border-[var(--border-cre)]'}`}>
        <input type="checkbox" id="accept" checked={accepted} onChange={e => setAccepted(e.target.checked)} className="mt-1 w-4 h-4 cursor-pointer accent-[var(--ink)]" />
        <label htmlFor="accept" className="text-sm text-[var(--muted)] cursor-pointer leading-relaxed">
          I, <strong>{fullName || '___'}</strong>, confirm that I am an authorized representative of <strong>{org?.name}</strong> and I agree to the terms of the Master Service Agreement.
        </label>
      </div>

      {/* Download + Nav Buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="h-12 w-28 rounded-[8px] text-[var(--muted)]">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back
        </Button>
        <Button variant="outline" onClick={handleDownload} className="h-12 rounded-[8px] text-[var(--muted)] gap-2">
          <FileText className="w-4 h-4" /> Download MSA
        </Button>
        <Button onClick={handleSign} disabled={!canProceed || saving} className="flex-1 bg-[var(--ink)] hover:bg-[var(--ink)] h-12 rounded-[8px] font-semibold gap-2 shadow-[var(--shadow-soft)] shadow-blue-900/10">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
          Continue to Payment
        </Button>
      </div>

      <p className="text-[10px] text-[var(--muted)] text-center mt-3 italic flex items-center justify-center gap-1">
        <Lock className="w-3 h-3" /> Secure Electronic Signature (ESIGN Act compliant)
      </p>
    </div>
  );
}

// ─── Payment Step ──────────────────────────────────────────────
function PaymentStep({ user, form, setForm, org, onBack }) {
  const [processing, setProcessing] = useState(false);
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

  const getFunctionErrorMessage = async (fnError, data) => {
    if (data?.error) return data.error;
    const response = fnError?.context;
    if (response && typeof response.json === "function") {
      try {
        const payload = await response.json();
        if (payload?.error) return payload.error;
      } catch {
        /* fall back to the Supabase error message */
      }
    }
    return fnError?.message || "Failed to create checkout session";
  };

  const handlePayment = async (e) => {
    e.preventDefault();
    setError("");
    setProcessing(true);

    try {
      const planKey = selectedPlan.key;
      let orgId = org?.id;

      if (!orgId && authUser?.id) {
        const { data: mems } = await supabase
          .from('memberships')
          .select('org_id')
          .eq('user_id', authUser.id)
          .limit(1);
        orgId = mems?.[0]?.org_id;
      }

      if (!orgId) {
        throw new Error('Organization ID could not be resolved. Please go back to Step 1 to verify your company information.');
      }

      // Pre-flight check & sync: guarantee the org row exists in Supabase DB before calling edge function
      try {
        await supabase.from('organizations').upsert({
          id: orgId,
          name: form?.name || org?.name || 'My Organization',
          status: org?.status || 'onboarding',
          onboarding_step: 3,
          primary_contact_email: form?.primary_contact_email || user?.email || authUser?.email,
          created_by: user?.id || authUser?.id,
          updated_at: new Date().toISOString(),
        });
      } catch (syncErr) {
        console.warn('[Payment] Pre-checkout org sync notice:', syncErr);
      }

      const { data: { session } } = await supabase.auth.getSession();
      const { data, error: fnError } = await supabase.functions.invoke('create-checkout-session', {
        body: { planKey, billingCycle, orgId },
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      });
      
      if (fnError || data?.error) {
        throw new Error(await getFunctionErrorMessage(fnError, data));
      }

      if (data?.url) {
        window.location.href = data.url;
      } else {
        throw new Error('No checkout URL returned from server.');
      }
    } catch (err) {
      console.error('[Payment] create-checkout-session failed:', err);
      setError(err.message || "An unexpected error occurred. Please try again.");
      setProcessing(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-[var(--ink)] mb-1">Activate Subscription</h2>
        <p className="text-[var(--muted)] text-sm">Select a plan and billing cycle to proceed to secure checkout.</p>
      </div>

      {/* Billing Toggle */}
      <div className="flex items-center justify-center mb-6">
        <div className="bg-[var(--surface-2)] rounded-[8px] p-1 flex gap-1">
          <button type="button" onClick={() => setBillingCycle("monthly")}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${billingCycle === "monthly" ? "bg-[var(--surface)] text-[var(--ink)] shadow-[var(--shadow-soft)]" : "text-[var(--muted)] hover:text-[var(--muted)]"}`}>
            Monthly
          </button>
          <button type="button" onClick={() => setBillingCycle("yearly")}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-2 ${billingCycle === "yearly" ? "bg-[var(--surface)] text-[var(--ink)] shadow-[var(--shadow-soft)]" : "text-[var(--muted)] hover:text-[var(--muted)]"}`}>
            Yearly
            <span className="bg-[var(--success)] text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-tight">Save 25%</span>
          </button>
        </div>
      </div>

      {/* Plan Grid */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {plans.map(p => {
          const price = getPrice(p.price);
          return (
            <button key={p.key} type="button" onClick={() => setForm((prev) => ({ ...prev, plan: p.key }))}
              className={`p-4 rounded-[8px] border-2 transition-all relative text-left ${form.plan === p.key ? "border-[var(--accent)] bg-[var(--accent-soft)] shadow-[var(--shadow-soft)] ring-4 ring-blue-50" : "border-[var(--border-cre)] bg-[var(--bg)] hover:border-[var(--border-cre)]"}`}>
              {p.popular && <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[var(--accent)] text-white text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-tighter">Recommended</div>}
              <p className="text-xs font-bold text-[var(--ink)] mb-1">{p.name}</p>
              {p.price ? (
                <div>
                  <p className="text-xl font-black text-[var(--ink)]">${price}<span className="text-[10px] uppercase font-bold text-[var(--muted)] ml-1">/mo</span></p>
                  {billingCycle === "yearly" && <p className="text-[9px] text-[var(--success)] font-bold mt-0.5">${p.price}/mo → Save ${p.price - price}/mo</p>}
                </div>
              ) : <p className="text-xl font-black text-[var(--ink)]">Custom</p>}
            </button>
          );
        })}
      </div>

      {billingCycle === "yearly" && selectedPlan.price > 0 && (
        <div className="bg-[var(--success-soft)] border border-[var(--border-cre)] rounded-[8px] px-4 py-3 mb-6 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-emerald-800">Annual billing: 25% savings applied</p>
            <p className="text-xs text-[var(--success)]">Billed as ${yearlyTotal.toLocaleString()}/year</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-[var(--success)] line-through">${(selectedPlan.price * 12).toLocaleString()}</p>
            <p className="text-sm font-black text-[var(--success)]">${yearlyTotal.toLocaleString()}</p>
          </div>
        </div>
      )}

      <form onSubmit={handlePayment} className="space-y-4">
        {error && <div className="p-3 bg-[var(--danger-soft)] border border-[var(--border-cre)] rounded-lg text-xs text-[var(--danger)] flex items-center gap-2"><AlertCircle className="w-3.5 h-3.5" /> {error}</div>}

        <div className="flex gap-4">
          <Button type="button" variant="outline" onClick={onBack} className="h-12 w-32 rounded-[8px] text-[var(--muted)]">Back</Button>
          <Button type="submit" disabled={processing} className="flex-1 bg-[var(--ink)] hover:bg-[var(--ink)] h-12 rounded-[8px] text-base font-bold shadow-[var(--shadow-soft)]">
            {processing ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Lock className="w-4 h-4 mr-2" />}
            {processing ? "Preparing Secure Checkout..." : selectedPlan.price ? `Proceed to Checkout` : "Request Enterprise Access"}
          </Button>
        </div>
        <p className="text-center text-[10px] text-[var(--muted)] flex items-center justify-center gap-1">
          <Lock className="w-3 h-3" /> Secure payment via Stripe
        </p>
      </form>
    </div>
  );
}
