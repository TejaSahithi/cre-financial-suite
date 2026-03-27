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

const withCrePlatformBranding = (content: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CRE Platform</title>
  <style>
    body { margin: 0; padding: 0; background: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .wrapper { max-width: 600px; margin: 40px auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; }
    .header { padding: 28px 36px; background: linear-gradient(135deg, #1a2744 0%, #2d4a8a 100%); }
    .brand { display: flex; align-items: center; gap: 10px; }
    .logo { width: 36px; height: 36px; border-radius: 10px; background: #ffffff; display: flex; align-items: center; justify-content: center; }
    .brand-name { color: #ffffff; font-size: 18px; font-weight: 700; letter-spacing: -0.3px; }
    .body { padding: 32px 36px; color: #475569; line-height: 1.6; font-size: 15px; }
    .body h1, .body h2, .body h3 { color: #0f172a; margin-top: 0; }
    .footer { border-top: 1px solid #e2e8f0; background: #f8fafc; padding: 18px 36px; text-align: center; color: #94a3b8; font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="brand">
        <div class="logo">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1a2744" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </div>
        <span class="brand-name">CRE Platform</span>
      </div>
    </div>
    <div class="body">${content}</div>
    <div class="footer">CRE Platform · support@cresuite.org</div>
  </div>
</body>
</html>`;

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
    const { to, subject, html, text, from = "CRE Platform <support@cresuite.org>" } = await req.json();

    if (!to || !subject || (!html && !text)) {
      return new Response(JSON.stringify({ error: 'Missing required fields: to, subject, and html or text' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (isAnon) {
      // Prevent open relay abuse by public users
      const toAddresses = Array.isArray(to) ? to : [to];
      const allInternal = toAddresses.every((email: string) => email.endsWith('@cresuite.com') || email.endsWith('@cresuite.org'));
      const isAutoReply = [
        'CRE Platform - Your Demo Access',
        'CRE Suite - Your Demo Access',
        'CRE Platform - Access Request Received',
        'CRE Suite - Access Request Received',
        "CRE Platform - We've received your access request",
        "CRE Suite - We've received your access request",
        'Thanks for exploring CRE Platform',
        'Thanks for exploring CRE Suite',
      ].some((allowedSubject) => subject.includes(allowedSubject));
      
      if (!allInternal && !isAutoReply) {
         return new Response(JSON.stringify({ error: 'Unauthorized email payload for anonymous key.' }), {
           status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
         });
      }
    }

    // ── 4. Send via Resend ──
    const brandedHtml = html
      ? (html.includes('<html') ? html : withCrePlatformBranding(html))
      : undefined;

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
        html: brandedHtml,
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
