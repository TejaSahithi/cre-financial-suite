// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('FRONTEND_URL') || 'http://localhost:5173',
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

    // 1. Fetch user's primary active org_admin membership
    const { data: memberships } = await supabaseAdmin
      .from('memberships')
      .select('org_id')
      .eq('user_id', user.id)
      .eq('role', 'org_admin');
    
    if (!memberships || memberships.length === 0) {
      return new Response(JSON.stringify({ error: 'Caller must be an org_admin' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const orgId = memberships[0].org_id;

    // 2. Transact: update org and profile to 'under_review'
    const { error: orgError } = await supabaseAdmin
      .from('organizations')
      .update({ status: 'under_review' })
      .eq('id', orgId);
    if (orgError) throw orgError;

    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .update({ status: 'under_review' })
      .eq('id', user.id);
    if (profileError) throw profileError;

    return new Response(JSON.stringify({ success: true, message: 'Onboarding marked for review' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
