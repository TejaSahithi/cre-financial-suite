// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) throw new Error('Unauthorized');

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Verify caller is super_admin
    const { data: memberships } = await supabaseAdmin
      .from('memberships')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'super_admin');
      
    if (!memberships || memberships.length === 0) {
      return new Response(JSON.stringify({ error: 'Forbidden: Requires super_admin' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { orgId } = await req.json();
    if (!orgId) throw new Error('orgId is required');

    // 1. Mark Organization Active
    const { error: orgError } = await supabaseAdmin
      .from('organizations')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', orgId)
      .eq('status', 'under_review'); // Ensure it was actually under review

    if (orgError) throw orgError;

    // 2. Find all org_admins (the founders/owners) for this org who are under_review
    const { data: orgAdmins } = await supabaseAdmin
      .from('memberships')
      .select('user_id')
      .eq('org_id', orgId);

    if (orgAdmins && orgAdmins.length > 0) {
      const userIds = orgAdmins.map(m => m.user_id);
      
      // Update their profiles to active
      const { error: profileError } = await supabaseAdmin
        .from('profiles')
        .update({ status: 'active', onboarding_complete: true })
        .in('id', userIds)
        .eq('status', 'under_review');
        
      if (profileError) throw profileError;
    }

    return new Response(JSON.stringify({ success: true, message: 'Organization approved and activated' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
