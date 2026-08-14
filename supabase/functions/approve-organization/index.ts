// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BRAND_NAME = 'ProForma OS';
const SUPPORT_EMAIL = 'support@proformaos.ai';
const DEFAULT_FRONTEND_URL = 'https://www.proformaos.ai';
const LOGO_URL = `${DEFAULT_FRONTEND_URL}/assets/proforma-os-logo.png`;

function resolveFrontendUrl(value?: string | null) {
  let url = String(value || '').trim().replace(/\/+$/, '');
  if (!url || /(vercel\.app|localhost)/i.test(url)) return DEFAULT_FRONTEND_URL;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

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

    // 4. Mark Organization Active — also fetch welcome_email_sent_at for dedup guard
    const { data: orgs, error: orgError } = await supabaseAdmin
      .from('organizations')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', orgId)
      .in('status', ['under_review', 'pending_approval', 'onboarding', 'pending_payment'])
      .select('*, welcome_email_sent_at');

    if (orgError) throw new Error(`DB Error updating org: ${orgError.message}`);
    if (!orgs || orgs.length === 0) {
      // Check current status to provide better error
      const { data: currentOrg } = await supabaseAdmin.from('organizations').select('status').eq('id', orgId).single();
      throw new Error(`Organization ${orgId} not found or not in a reviewable state (Current status: ${currentOrg?.status || 'unknown'})`);
    }
    const org = orgs[0];

    const { error: auditErr } = await supabaseAdmin.from('audit_logs').insert({
      org_id: orgId,
      actor_user_id: user.id,
      actor_email: user.email,
      actor_role: 'super_admin',
      entity_type: 'Organization',
      entity_id: orgId,
      action: 'approve',
      source: 'edge_function',
      severity: 'info',
      after: { status: 'active' }
    });
    if (auditErr) {
      // Revert org update on audit failure
      await supabaseAdmin.from('organizations').update({ status: 'under_review' }).eq('id', orgId);
      throw new Error(`Audit log failed: ${auditErr.message}`);
    }

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
    // Normalize to strip any trailing slash so CTA URLs never have double slashes
    const frontendUrl = resolveFrontendUrl(Deno.env.get('FRONTEND_URL') || Deno.env.get('SITE_URL'));
    const welcomeUrl = `${frontendUrl}/WelcomeAboard`;

    let emailWarning = null;

    // ── Duplicate-prevention guard ──────────────────────────────────────────────
    // welcome_email_sent_at is NULL until a welcome email is successfully sent.
    // If it is already set, the org admin has already been welcomed — skip silently.
    if (org.welcome_email_sent_at) {
      console.log(`[approve-org] Welcome email already sent at ${org.welcome_email_sent_at} — skipping duplicate.`);
    } else if (RESEND_API_KEY && org.primary_contact_email) {
      const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
        <title>Welcome to ${BRAND_NAME}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, sans-serif; margin:0; padding:0; background:#f8fafc; }
          .wrapper { max-width:600px; margin:40px auto; background:#fff; border-radius:16px; overflow:hidden; border:1px solid #e2e8f0; }
          .header { background:#071326; padding:26px 40px; text-align:left; }
          .logo-img { width:196px; height:auto; display:block; background:#fff; border-radius:8px; padding:8px 10px; }
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
            <img class="logo-img" src="${LOGO_URL}" alt="${BRAND_NAME}" />
          </div>
          <div class="body">
            <h1>Welcome Aboard! 🎉</h1>
            <p>Hi there,</p>
            <p>Great news! Your organization <strong>${org.name}</strong> has been approved and activated by our team.</p>
            <p>Your subscription is now active and you have full access to ${BRAND_NAME}. You can now invite your team, manage portfolios, and run advanced CAM reconciliations.</p>
            <div style="text-align: center;">
              <a href="${welcomeUrl}" class="cta">Go to Your Dashboard →</a>
            </div>
            <p style="margin-bottom:0;">Welcome to the future of Commercial Real Estate Management.</p>
          </div>
          <div class="footer"><p>${BRAND_NAME} &middot; ${SUPPORT_EMAIL} &middot; &copy; ${new Date().getFullYear()} All rights reserved</p></div>
        </div>
      </body>
      </html>
      `;

      try {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: `${BRAND_NAME} <${SUPPORT_EMAIL}>`,
            to: org.primary_contact_email,
            subject: `Welcome to ${BRAND_NAME}! Your account is now active`,
            html,
          }),
        });

        if (!emailRes.ok) {
          // Log warning — do NOT set sentinel so a retry is possible on next approval call
          const errorText = await emailRes.text();
          console.error(`[approve-org] Resend error (${emailRes.status}):`, errorText);
          emailWarning = `Activation succeeded, but welcome email failed to send: ${errorText}`;
        } else {
          // Only mark as sent after confirmed delivery
          const { error: sentinelErr } = await supabaseAdmin
            .from('organizations')
            .update({ welcome_email_sent_at: new Date().toISOString() })
            .eq('id', orgId);
          if (sentinelErr) {
            console.error('[approve-org] Failed to write welcome_email_sent_at sentinel:', sentinelErr.message);
          } else {
            console.log(`[approve-org] Welcome email sent and sentinel set for org ${orgId}`);
          }
        }
      } catch (err) {
        // Email failure must never block the DB activation — log and continue
        console.error('[approve-org] Welcome email send error (non-fatal):', err.message);
        emailWarning = `Activation succeeded, but welcome email threw an error: ${err.message}`;
      }
    } else {
      console.warn('[approve-org] Email skipped: RESEND_API_KEY or primary_contact_email missing');
      emailWarning = 'Activation succeeded, but welcome email was skipped (check RESEND_API_KEY and primary_contact_email).';
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
