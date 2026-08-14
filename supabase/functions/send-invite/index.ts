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

    const { email, role, org_id } = await req.json();
    if (!email || !role || !org_id) throw new Error('Missing email, role, or org_id');

    // Verify caller is org_admin of the target org
    const { data: callerMemberships } = await supabaseAdmin
      .from('memberships')
      .select('role')
      .eq('user_id', user.id)
      .eq('org_id', org_id)
      .eq('role', 'org_admin');

    if (!callerMemberships || callerMemberships.length === 0) {
      // Check if super_admin
      const { data: superAdmin } = await supabaseAdmin.from('memberships').select('role').eq('user_id', user.id).eq('role', 'super_admin');
      if (!superAdmin || superAdmin.length === 0) {
        return new Response(JSON.stringify({ error: 'Forbidden: Requires org_admin for this org' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // Generate secure invite token
    const token = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 day expiry

    // Delete any existing pending invites for this exact email+org to satisfy UNIQUE constraint
    await supabaseAdmin.from('invitations')
      .delete()
      .eq('email', email)
      .eq('org_id', org_id)
      .eq('status', 'pending_approval');

    // Insert invitation
    const { error: insertError } = await supabaseAdmin
      .from('invitations')
      .insert({
        email,
        org_id,
        role,
        token,
        status: 'pending_approval',
        expires_at: expiresAt.toISOString()
      });

    if (insertError) throw insertError;

    // Send the email (mocked or actual Resend logic)
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const SITE_URL = resolveFrontendUrl(Deno.env.get('FRONTEND_URL') || Deno.env.get('SITE_URL'));
    const inviteLink = `${SITE_URL}/AcceptInvite?token=${token}`;

    if (RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${BRAND_NAME} <${SUPPORT_EMAIL}>`,
          to: email,
          subject: 'You have been invited to join an organization',
          html: `<!DOCTYPE html><html lang="en"><body style="margin:0;padding:40px 16px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"><div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;"><div style="padding:26px 36px;background:#071326;"><img src="${LOGO_URL}" alt="${BRAND_NAME}" style="width:196px;height:auto;display:block;background:#fff;border-radius:8px;padding:8px 10px;" /></div><div style="padding:32px 36px;color:#475569;font-size:15px;line-height:1.6;"><h1 style="margin:0 0 12px;color:#0f172a;font-size:24px;">You have been invited</h1><p>You've been invited to join as a <strong>${role}</strong>.</p><p><a href="${inviteLink}" style="display:inline-block;background:#071326;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600;">Accept Invitation</a></p></div><div style="border-top:1px solid #e2e8f0;background:#f8fafc;padding:18px 36px;text-align:center;color:#94a3b8;font-size:12px;">${BRAND_NAME} · ${SUPPORT_EMAIL}</div></div></body></html>`
        })
      });
    }

    // Always log in dev/edge for visibility
    console.log('--- INVITE GENERATED ---');
    console.log(`To: ${email}`);
    console.log(`Role: ${role}`);
    console.log(`Link: ${inviteLink}`);
    console.log('-------------------------');

    return new Response(JSON.stringify({ success: true, message: 'Invitation sent' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
