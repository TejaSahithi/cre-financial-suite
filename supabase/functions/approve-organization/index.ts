// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
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
    const token = authHeader.replace('Bearer ', '');

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // 1. Verify caller manually to bypass verify_jwt issues
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      console.error('[approve-org] Auth verification failed:', authError?.message);
      return new Response(JSON.stringify({ error: 'Unauthorized', details: authError?.message }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. Verify caller is super_admin
    const { data: memberships, error: memError } = await supabaseAdmin
      .from('memberships')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'super_admin');
      
    if (memError || !memberships || memberships.length === 0) {
      console.error('[approve-org] Permission denied. user_id:', user.id, 'role check error:', memError?.message);
      return new Response(JSON.stringify({ error: 'Forbidden: Requires super_admin role' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 3. Parse request body
    const body = await req.json();
    const { orgId } = body;
    if (!orgId) throw new Error('orgId is required in request body');

    console.log(`[approve-org] Approving organization: ${orgId}`);

    // 4. Mark Organization Active
    const { data: orgs, error: orgError } = await supabaseAdmin
      .from('organizations')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', orgId)
      .in('status', ['under_review', 'pending_approval', 'onboarding'])
      .select();

    if (orgError) throw new Error(`DB Error updating org: ${orgError.message}`);
    if (!orgs || orgs.length === 0) {
      // Check current status to provide better error
      const { data: currentOrg } = await supabaseAdmin.from('organizations').select('status').eq('id', orgId).single();
      throw new Error(`Organization ${orgId} not found or not in a reviewable state (Current status: ${currentOrg?.status || 'unknown'})`);
    }
    const org = orgs[0];

    // 5. Find all users associated with this org to update their profiles
    const { data: orgUsers, error: usersError } = await supabaseAdmin
      .from('memberships')
      .select('user_id, profiles(email)')
      .eq('org_id', orgId);
      
    if (usersError) throw new Error(`DB Error fetching memberships: ${usersError.message}`);

    if (orgUsers && orgUsers.length > 0) {
      const userIds = orgUsers.map(m => m.user_id);
      // Get the email for the first admin to send the welcome email
      const targetEmail = orgUsers.find(m => m.profiles?.email)?.profiles?.email || org.primary_contact_email;
      
      // Update their profiles to active
      const { error: profileError } = await supabaseAdmin
        .from('profiles')
        .update({ status: 'active', onboarding_complete: true })
        .in('id', userIds)
        .in('status', ['under_review', 'pending_approval', 'onboarding', 'pending_verification']);
        
      if (profileError) throw new Error(`DB Error updating profiles: ${profileError.message}`);

      // Use the resolved email for the rest of the function
      if (targetEmail) org.primary_contact_email = targetEmail;
    }

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const frontendUrl = Deno.env.get('FRONTEND_URL') || Deno.env.get('SITE_URL') || 'https://cre-financial-suite-n9be.vercel.app';
    
    let emailWarning = null;
    if (RESEND_API_KEY && org.primary_contact_email) {
      const loginLink = `${frontendUrl}/signin`;
      const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
        <title>Welcome to CRE Platform</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, sans-serif; margin:0; padding:0; background:#f8fafc; }
          .wrapper { max-width:600px; margin:40px auto; background:#fff; border-radius:16px; overflow:hidden; border:1px solid #e2e8f0; }
          .header { background:linear-gradient(135deg,#1a2744 0%,#2d4a8a 100%); padding:32px 40px; text-align:center; }
          .logo-text { color:#fff; font-size:24px; font-weight:800; letter-spacing:-0.5px; }
          .body { padding:40px; }
          h1 { font-size:24px; font-weight:700; color:#0f172a; margin:0 0 16px; }
          p { color:#475569; font-size:16px; line-height:1.6; margin:0 0 20px; }
          .cta { display:inline-block; background:#10b981; color:#fff !important; padding:16px 32px; border-radius:12px; text-decoration:none; font-weight:600; font-size:16px; margin:16px 0 32px; box-shadow:0 4px 14px 0 rgba(16,185,129,0.39); }
          .footer { background:#f8fafc; padding:24px 40px; text-align:center; border-top:1px solid #e2e8f0; }
          .footer p { color:#94a3b8; font-size:13px; margin:0; }
        </style>
      </head>
      <body>
        <div class="wrapper">
          <div class="header">
            <span class="logo-text">CRE Platform</span>
          </div>
          <div class="body">
            <h1>Welcome Aboard! 🎉</h1>
            <p>Hi there,</p>
            <p>Great news! Your organization <strong>${org.name}</strong> has been approved and activated by our team.</p>
            <p>Your subscription is now active, and you have full access to the CRE Financial Suite platform. You can now invite your team, manage portfolios, and run advanced CAM reconciliations.</p>
            <div style="text-align: center;">
              <a href="${loginLink}" class="cta">Go to Your Dashboard →</a>
            </div>
            <p style="margin-bottom:0;">Welcome to the future of Commercial Real Estate Management.</p>
          </div>
          <div class="footer"><p>CRE Platform &middot; support@cresuite.org &middot; &copy; ${new Date().getFullYear()} All rights reserved</p></div>
        </div>
      </body>
      </html>
      `;

      try {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'CRE Platform <support@cresuite.org>',
            to: org.primary_contact_email,
            subject: 'Welcome to CRE Platform! Your account is active!',
            html: html
          })
        });
        
        if (!emailRes.ok) {
          const errorText = await emailRes.text();
          console.error(`[approve-org] Resend Error:`, errorText);
          emailWarning = `Activation succeeded, but welcome email failed to send: ${errorText}`;
        } else {
          console.log(`[approve-org] Welcome email sent to ${org.primary_contact_email}`);
        }
      } catch (err) {
        console.error('[approve-org] Failed to send welcome email:', err);
        emailWarning = `Activation succeeded, but welcome email failed: ${err.message}`;
      }
    } else {
      console.warn('[approve-org] Email skipped: RESEND_API_KEY or primary_contact_email missing');
      emailWarning = 'Activation succeeded, but welcome email was skipped (check config).';
    }

    return new Response(JSON.stringify({ success: true, message: 'Organization approved and activated', warning: emailWarning }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error("[approve-org] Catch Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
