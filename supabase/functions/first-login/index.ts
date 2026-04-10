// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

const OWNER_ROLE_ALIASES = new Set([
  "admin",
  "org_admin",
  "super_admin",
  "owner",
  "organization_owner",
  "admin_(landlord)",
  "landlord_admin",
  "admin_landlord",
]);

function normalizeRole(role) {
  return String(role || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isOwnerLikeRole(role) {
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) return false;
  if (OWNER_ROLE_ALIASES.has(normalizedRole)) return true;
  if (normalizedRole.startsWith("admin_") || normalizedRole.endsWith("_admin")) return true;
  return normalizedRole.includes("owner");
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) throw new Error('Unauthorized');

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // 1. Verify user profile status
    let { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('status, onboarding_type, full_name, email')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError) throw profileError;

    if (!profile) {
      let isAuthorized = false;

      const [{ data: approvedRequest }, { data: invitation }] = await Promise.all([
        supabaseAdmin
          .from('access_requests')
          .select('id, role')
          .ilike('email', user.email)
          .eq('status', 'approved')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabaseAdmin
          .from('invitations')
          .select('id')
          .ilike('email', user.email)
          .in('status', ['pending', 'pending_approval'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      isAuthorized = !!approvedRequest || !!invitation;

      const fallbackOnboardingType =
        invitation ? 'invited' :
        (isOwnerLikeRole(approvedRequest?.role) ? 'owner' : null) ||
        (user.user_metadata?.onboarding_type as string | undefined) ||
        (user.app_metadata?.onboarding_type as string | undefined) ||
        'owner';

      const insertedProfile = {
        id: user.id,
        email: user.email,
        full_name:
          (user.user_metadata?.full_name as string | undefined) ||
          (user.user_metadata?.name as string | undefined) ||
          user.email?.split('@')[0] ||
          'User',
        onboarding_type: fallbackOnboardingType,
        onboarding_complete: fallbackOnboardingType === 'invited',
        first_login: true,
        status: (isAuthorized || fallbackOnboardingType === 'owner') ? 'approved' : 'pending_approval',
      };

      const { data: createdProfile, error: createProfileError } = await supabaseAdmin
        .from('profiles')
        .upsert(insertedProfile, { onConflict: 'id' })
        .select('status, onboarding_type, full_name, email')
        .single();

      if (createProfileError) throw createProfileError;
      profile = createdProfile;
    }

    const [{ data: approvedRequest }, { data: invitation }] = await Promise.all([
      supabaseAdmin
        .from('access_requests')
        .select('id, role')
        .ilike('email', user.email)
        .eq('status', 'approved')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from('invitations')
        .select('id')
        .ilike('email', user.email)
        .in('status', ['pending', 'pending_approval'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const onboardingType =
      invitation ? 'invited' :
      (isOwnerLikeRole(approvedRequest?.role) ? 'owner' : null) ||
      profile.onboarding_type ||
      (user.user_metadata?.onboarding_type as string | undefined) ||
      'owner';

    if (profile.onboarding_type !== onboardingType) {
      await supabaseAdmin
        .from('profiles')
        .update({ onboarding_type: onboardingType })
        .eq('id', user.id);
      profile.onboarding_type = onboardingType;
    }

    // Owner-type signups (new org creators) should be auto-approved.
    // They arrive with 'pending_approval' because they aren't in access_requests.
    if (onboardingType === 'owner' && profile.status === 'pending_approval') {
      await supabaseAdmin.from('profiles').update({ status: 'approved' }).eq('id', user.id);
      profile.status = 'approved';
    }

    if (!['approved', 'onboarding'].includes(profile.status)) {
      return new Response(JSON.stringify({ error: 'User is not in an onboarding-ready state', status: profile.status }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (onboardingType !== 'owner') {
      return new Response(JSON.stringify({ error: 'Only owners trigger standard first-login' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 2. Prevent duplicate orgs: Check if membership already exists
    const { data: existingMemberships } = await supabaseAdmin
      .from('memberships')
      .select('id')
      .eq('user_id', user.id);

    if (existingMemberships && existingMemberships.length > 0) {
      // If membership exists, normalize the profile state and reuse the existing org.
      await supabaseAdmin.from('profiles').update({ status: 'onboarding' }).eq('id', user.id);
      return new Response(JSON.stringify({ success: true, message: 'Corrected dirty state. Resuming.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3. Create the placeholder Organization
    const { data: org, error: orgError } = await supabaseAdmin
      .from('organizations')
      .insert({
        name: 'My Organization', // Default name until they fill it in onboarding
        status: 'onboarding',
        onboarding_step: 1,
        primary_contact_email: profile.email || user.email,
      })
      .select('id')
      .single();

    if (orgError) throw orgError;

    // 4. Create the Membership (org_admin)
    const { error: memError } = await supabaseAdmin
      .from('memberships')
      .insert({
        user_id: user.id,
        org_id: org.id,
        role: 'org_admin'
      });

    if (memError) throw memError;

    // 5. Upgrade profile status to 'onboarding'
    const { error: upgradeError } = await supabaseAdmin
      .from('profiles')
      .update({ status: 'onboarding' })
      .eq('id', user.id);

    if (upgradeError) throw upgradeError;

    return new Response(JSON.stringify({ success: true, org_id: org.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
