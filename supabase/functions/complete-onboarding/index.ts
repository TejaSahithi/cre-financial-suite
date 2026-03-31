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
    const orgUpdate: Record<string, unknown> = {
      status: 'under_review',
      onboarding_step: 4,
      plan: plan || 'professional',
      billing_cycle: billingCycle || 'monthly',
      primary_contact_email: user.email,
      updated_at: new Date().toISOString(),
    };
    if (orgName) orgUpdate.name = orgName;

    const { error: orgError } = await supabaseAdmin
      .from('organizations')
      .update(orgUpdate)
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

    // 4. Notify admin via Resend directly (best effort, don't fail if it fails)
    try {
      const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
      const frontendUrl = Deno.env.get('FRONTEND_URL') || 'https://cjwdwuqqdokblakheyjb.supabase.co';
      
      const { data: adminMembers } = await supabaseAdmin
        .from('memberships')
        .select('profiles(email)')
        .eq('role', 'super_admin');
        
      let toEmails = adminMembers?.map((m: any) => m.profiles?.email).filter(Boolean) || [];
      if (toEmails.length === 0) {
        toEmails = ['support@cresuite.org'];
      }

      if (RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'CRE Platform <support@cresuite.org>',
            to: toEmails,
            subject: `💰 New Payment: ${orgName || 'New Organization'} — Action Required`,
            html: `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f8fafc;margin:0;padding:0;">
              <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;">
                <div style="background:linear-gradient(135deg,#1a2744,#2d4a8a);padding:28px 36px;">
                  <span style="color:#fff;font-size:20px;font-weight:700;">CRE Platform</span>
                </div>
                <div style="padding:32px 36px;">
                  <h2 style="color:#0f172a;margin-top:0;">New Payment Received 💰</h2>
                  <p style="color:#475569;">A new organization has completed onboarding and is awaiting your review.</p>
                  <div style="background:#f8fafc;padding:16px;border-radius:8px;border:1px solid #e2e8f0;margin:20px 0;">
                    <p style="margin:0 0 6px;font-size:14px;color:#1e293b;"><strong>Organization:</strong> ${orgName || 'N/A'}</p>
                    <p style="margin:0 0 6px;font-size:14px;color:#1e293b;"><strong>Admin Email:</strong> ${user.email || 'N/A'}</p>
                    <p style="margin:0 0 6px;font-size:14px;color:#1e293b;"><strong>Plan:</strong> ${plan || 'N/A'} (${billingCycle || 'monthly'})</p>
                    <p style="margin:0;font-size:14px;color:#1e293b;"><strong>Amount:</strong> $${numericAmount}</p>
                  </div>
                  <a href="${frontendUrl}/SuperAdmin" style="display:inline-block;background:#10b981;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;">
                    Review in SuperAdmin Console →
                  </a>
                </div>
                <div style="border-top:1px solid #e2e8f0;background:#f8fafc;padding:18px 36px;text-align:center;color:#94a3b8;font-size:12px;">
                  CRE Platform · support@cresuite.org
                </div>
              </div>
            </body></html>`,
          }),
        });
        console.log('[complete-onboarding] Admin notification sent');
      }
    } catch (emailErr) {
      console.error('[complete-onboarding] Admin notification failed:', emailErr);
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
