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

    let bodyData = {};
    try {
      bodyData = await req.json();
    } catch(e) {}
    
    const { plan, billingCycle, amount, orgName } = bodyData;
    const numericAmount = amount ? parseFloat(amount) : 0;

    // 2. Transact: update org and profile to 'under_review'
    const { error: orgError } = await supabaseAdmin
      .from('organizations')
      .update({ 
        status: 'under_review',
        onboarding_step: 4,
        plan: plan || 'professional',
        billing_cycle: billingCycle || 'monthly',
        updated_at: new Date().toISOString()
      })
      .eq('id', orgId);
    if (orgError) throw orgError;

    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .update({ status: 'under_review', updated_at: new Date().toISOString() })
      .eq('id', user.id);
    if (profileError) throw profileError;

    // 3. Create invoice record
    const { error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .insert({
        org_id: orgId,
        amount: numericAmount,
        status: 'paid',
        issued_date: new Date().toISOString().split('T')[0]
      });
    if (invoiceError) throw invoiceError;

    // 4. Notify admin (best effort, don't fail if it fails)
    try {
      const frontendUrl = Deno.env.get('FRONTEND_URL') || 'http://localhost:5173';
      await supabaseAdmin.functions.invoke('send-email', {
        body: {
          to: "support@cresuite.org",
          subject: `💰 Payment Received: ${orgName || 'New Organization'}`,
          html: `
            <div style="font-family: sans-serif; padding: 20px; color: #1e293b;">
              <h2 style="color: #0f172a;">New Payment Received 💰</h2>
              <p>A new organization has completed their onboarding payment and is awaiting review.</p>
              <div style="background: #f8fafc; padding: 16px; border-radius: 8px; border: 1px solid #e2e8f0; margin: 20px 0;">
                <p style="margin: 0; font-size: 14px;"><strong>Organization:</strong> ${orgName || 'N/A'}</p>
                <p style="margin: 4px 0; font-size: 14px;"><strong>Administrator:</strong> ${user.email || 'N/A'}</p>
                <p style="margin: 4px 0; font-size: 14px;"><strong>Plan:</strong> ${plan || 'N/A'}</p>
                <p style="margin: 4px 0; font-size: 14px;"><strong>Amount:</strong> $${numericAmount}</p>
              </div>
              <p>Please log in to the <a href="${frontendUrl}/SuperAdmin" style="color: #2563eb; text-decoration: none; font-weight: 600;">SuperAdmin Console</a> to approve this organization.</p>
            </div>
          `
        }
      });
    } catch (emailErr) {
      console.error('[Onboarding] Admin notification failed:', emailErr);
    }

    return new Response(JSON.stringify({ success: true, message: 'Onboarding marked for review' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error("[complete-onboarding] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
