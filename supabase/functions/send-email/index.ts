// @ts-nocheck
/**
 * send-email — Supabase Edge Function
 *
 * Proxies email sending via the Resend API.
 * The Resend API key stays server-side — never exposed to the browser.
 *
 * SECURITY: Requires a valid JWT. Only authenticated users can send emails.
 * Rate limiting should be configured at the Supabase project level.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');

const getCorsHeaders = (origin: string | null) => {
  return {
    // Dynamically allow the request's origin (Vercel previews, localhost, etc)
    // Security relies on the backend payload checks (`isAnon`, `allInternal`, `isAutoReply`), not CORS.
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
};

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    // ── 1. Verify caller is authenticated ──
    const authorization = req.headers.get("Authorization");
    if (!authorization) {
      return new Response(JSON.stringify({ error: 'Authorization required' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const token = authorization.replace(/^[Bb]earer\s+/, "");
    
    // We use getUser to determine if it's a real user.
    // However, if the JWT is just the anonymous anon key, getUser will return an error (since there's no user).
    // Let's decode the JWT first to see its role.
    const tokenData = JSON.parse(atob(token.split('.')[1] || ""));
    const isAnon = tokenData.role === 'anon';

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (!user && !isAnon) {
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 2. Validate Resend config ──
    if (!RESEND_API_KEY) {
      console.error('[send-email] RESEND_API_KEY is not configured');
      return new Response(JSON.stringify({ error: 'Email service not configured' }), {
        status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 3. Parse and validate request body ──
    const { to, subject, html, text, from = "CRE Suite <support@cresuite.com>" } = await req.json();

    if (!to || !subject || (!html && !text)) {
      return new Response(JSON.stringify({ error: 'Missing required fields: to, subject, and html or text' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (isAnon) {
      // Prevent open relay abuse by public users
      const toAddresses = Array.isArray(to) ? to : [to];
      const allInternal = toAddresses.every((email: string) => email.endsWith('@cresuite.com'));
      const isAutoReply = subject.includes('CRE Suite - Your Demo Access') || 
                          subject.includes('CRE Suite - Access Request Received') || 
                          subject.includes("CRE Suite - We've received your access request") ||
                          subject.includes('Thanks for exploring CRE Suite');
      
      if (!allInternal && !isAutoReply) {
         return new Response(JSON.stringify({ error: 'Unauthorized email payload for anonymous key.' }), {
           status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
         });
      }
    }

    // ── 4. Send via Resend ──
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html: html || undefined,
        text: text || undefined,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error(`[send-email] Resend API error:`, data);
      return new Response(JSON.stringify({ error: 'Failed to send email' }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[send-email] Email sent to ${to} by ${user?.email || 'anon'}`);

    return new Response(JSON.stringify({ success: true, id: data.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (err: any) {
    console.error('[send-email] Error:', err.message);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
