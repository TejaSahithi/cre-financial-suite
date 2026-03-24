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
    const SITE_URL = Deno.env.get('FRONTEND_URL') || 'http://localhost:5174';
    const inviteLink = `${SITE_URL}/AcceptInvite?token=${token}`;

    if (RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'CRE Platform <invites@creplatform.io>',
          to: email,
          subject: 'You have been invited to join an organization',
          html: `<p>You've been invited to join as a ${role}. Click below to accept your invitation:</p><p><a href="${inviteLink}">${inviteLink}</a></p>`
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
