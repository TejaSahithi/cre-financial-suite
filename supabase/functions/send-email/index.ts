// @ts-nocheck
/**
 * send-email — Supabase Edge Function
 *
 * Proxies email sending via the Resend API using strict template mapping.
 * The Resend API key stays server-side — never exposed to the browser.
 *
 * SECURITY: verify_jwt is temporarily false for public flows, but we enforce
 * strict template IDs and variables. No arbitrary HTML/Subject/From.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');

const getCorsHeaders = (origin: string | null) => {
  return {
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
          <span style="font-size: 13px; font-weight: 800; color: #1a2744; letter-spacing: -0.04em;">CP</span>
        </div>
        <span class="brand-name">CRE Platform</span>
      </div>
    </div>
    <div class="body">${content}</div>
    <div class="footer">CRE Platform · support@cresuite.org</div>
  </div>
</body>
</html>`;

const PUBLIC_TEMPLATES = [
  'request_access_autoreply',
  'request_access_admin_notification',
  'request_demo_autoreply',
  'request_demo_admin_notification',
  'contact_autoreply',
  'contact_admin_notification'
];

const AUTHENTICATED_TEMPLATES = [
  'budget_approval_notification',
  'lease_review_summary',
  'generic_internal_notification'
];

function getTemplateData(templateId: string, variables: any) {
  const adminEmail = 'support@cresuite.org';
  const fromDefault = 'CRE Platform <support@cresuite.org>';
  
  switch(templateId) {
    case 'request_access_autoreply':
      return {
        from: fromDefault,
        subject: "CRE Platform - We've received your access request",
        html: `
          <h1>Thanks for requesting access, ${variables.name || 'there'}!</h1>
          <p>We've received your access request and our team is currently reviewing it.</p>
          <p>We will be in touch shortly.</p>
        `
      };
    case 'request_access_admin_notification':
      return {
        from: fromDefault,
        to: adminEmail,
        subject: `[New Request] Access: ${variables.name} (${variables.company || 'N/A'})`,
        html: `
          <h2>New Access Request</h2>
          <p><strong>Name:</strong> ${variables.name}</p>
          <p><strong>Email:</strong> ${variables.email}</p>
          <p><strong>Company:</strong> ${variables.company || 'N/A'}</p>
          <p><strong>Role:</strong> ${variables.role || 'N/A'}</p>
        `
      };
    case 'request_demo_autoreply':
    case 'contact_autoreply':
      return {
        from: fromDefault,
        subject: "CRE Platform - Thanks for reaching out",
        html: `
          <h1>Thanks for reaching out, ${variables.name || 'there'}!</h1>
          <p>We've received your message and our team will get back to you shortly.</p>
        `
      };
    case 'request_demo_admin_notification':
    case 'contact_admin_notification':
      return {
        from: fromDefault,
        to: adminEmail,
        subject: `[New Request] Contact/Demo: ${variables.name} (${variables.company || 'N/A'})`,
        html: `
          <h2>New Contact/Demo Request</h2>
          <p><strong>Name:</strong> ${variables.name}</p>
          <p><strong>Email:</strong> ${variables.email}</p>
          <p><strong>Message:</strong> ${variables.message || ''}</p>
        `
      };
    case 'budget_approval_notification':
      return {
        from: fromDefault,
        subject: `Budget Ready for Review: ${variables.budgetName || 'New Budget'}`,
        html: `
          <h1 style="margin-bottom: 8px;">${variables.budgetName || 'Budget Review'}</h1>
          <p style="margin: 0 0 20px; color: #64748b;">
            ${variables.scopeLabel || ''} budget update for FY ${variables.budgetYear || ''}.
          </p>
          ${variables.message ? `<div style="margin-bottom: 20px; padding: 16px; border-radius: 12px; background: #eff6ff; color: #1e3a8a;"><strong>Message</strong><br/>${variables.message}</div>` : ''}
          <table style="width: 100%; border-collapse: collapse; margin: 0 0 24px;">
            <tr>
              <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; color: #64748b;">Total Revenue</td>
              <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700;">${variables.revenue || '$0'}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; color: #64748b;">Total Expenses</td>
              <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700; color: #dc2626;">${variables.expenses || '$0'}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; color: #64748b;">CAM</td>
              <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700; color: #2563eb;">${variables.cam || '$0'}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; color: #64748b;">NOI</td>
              <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700; color: #059669;">${variables.noi || '$0'}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #64748b;">Expense Ratio / CAM Share</td>
              <td style="padding: 12px 0; text-align: right; font-weight: 600;">${variables.expenseRatio || '0%'} / ${variables.camShare || '0%'}</td>
            </tr>
          </table>
          ${variables.downloadUrl ? `<p style="margin: 0 0 8px;">A detailed export with budget summary, expense detail, revenue detail, lease schedules, and CAM support is ready for download.</p>
                 <p style="margin: 0 0 24px;"><a href="${variables.downloadUrl}" style="display: inline-block; padding: 12px 18px; border-radius: 10px; background: #1d4ed8; color: #ffffff; text-decoration: none; font-weight: 600;">Open Detailed Export</a></p>` : ''}
          ${variables.aiInsights ? `<div style="padding: 16px; border-radius: 12px; background: #f8fafc; border: 1px solid #e2e8f0;"><strong>AI Insight</strong><br/>${variables.aiInsights}</div>` : ''}
        `
      };
    case 'lease_review_summary':
      return {
        from: fromDefault,
        subject: `Lease Review Completed: ${variables.tenantName || 'Tenant'}`,
        html: `
          <h1>Lease Review Summary</h1>
          <p>The lease review for <strong>${variables.tenantName || 'Tenant'}</strong> has been completed.</p>
          <p>You can view the summary in the lease review dashboard.</p>
        `
      };
    case 'generic_internal_notification':
      return {
        from: fromDefault,
        subject: `CRE Platform Notification: ${variables.subject || 'Update'}`,
        html: `
          <h1>${variables.subject || 'Platform Notification'}</h1>
          <p>${variables.message || 'You have a new notification.'}</p>
          ${variables.action_url ? `<p style="margin: 24px 0 0;"><a href="${variables.action_url}" style="display: inline-block; padding: 12px 18px; border-radius: 10px; background: #1d4ed8; color: #ffffff; text-decoration: none; font-weight: 600;">Open in CRE Platform</a></p>` : ''}
          ${variables.module || variables.notification_type ? `<p style="margin-top: 24px; color: #94a3b8; font-size: 12px;">${variables.module || 'notification'} · ${variables.notification_type || variables.event_type || 'update'}</p>` : ''}
        `
      };
    default:
      return null;
  }
}

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
    const authorization = req.headers.get("Authorization");
    
    // We expect token for authenticated templates. For public, anon token might be passed or none.
    const token = authorization ? authorization.replace(/^[Bb]earer\s+/, "") : null;
    let isAnon = true;
    let user = null;

    if (token) {
      try {
        const tokenData = JSON.parse(atob(token.split('.')[1] || ""));
        isAnon = tokenData.role === 'anon';
      } catch (e) {
        // ignore parsing error
      }

      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        { auth: { autoRefreshToken: false, persistSession: false } }
      );
      
      const { data: authData } = await supabaseAdmin.auth.getUser(token);
      if (authData?.user) {
        user = authData.user;
        isAnon = false; // Override anon if getUser succeeds
      }
    } else {
      isAnon = true;
    }

    if (!RESEND_API_KEY) {
      console.error('[send-email] RESEND_API_KEY is not configured');
      return new Response(JSON.stringify({ error: 'Email service not configured' }), {
        status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const { templateId, variables = {}, to, html, subject, from } = body;

    if (html || subject || from) {
       return new Response(JSON.stringify({ error: 'Arbitrary html, subject, and from are not allowed. Please use templateId and variables.' }), {
         status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
       });
    }

    if (!templateId) {
      return new Response(JSON.stringify({ error: 'Missing required field: templateId' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 1. Validate template access ──
    const isPublicTemplate = PUBLIC_TEMPLATES.includes(templateId);
    const isAuthTemplate = AUTHENTICATED_TEMPLATES.includes(templateId);

    if (!isPublicTemplate && !isAuthTemplate) {
      return new Response(JSON.stringify({ error: 'Invalid templateId' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (isAnon && !isPublicTemplate) {
      return new Response(JSON.stringify({ error: 'Unauthorized email template for anonymous access.' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    // For authenticated templates, user must be logged in (not anon)
    if (isAuthTemplate && (!authorization || isAnon || !user)) {
      return new Response(JSON.stringify({ error: 'Authorization required for this template.' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 2. Construct Template ──
    const templateData = getTemplateData(templateId, variables);
    if (!templateData) {
      return new Response(JSON.stringify({ error: 'Template construction failed' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // If template specifies a 'to' address (e.g., admin notifications), use it. Otherwise use the client's 'to'.
    const finalTo = templateData.to || to;
    if (!finalTo) {
      return new Response(JSON.stringify({ error: 'Missing required field: to' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 3. Send via Resend ──
    const brandedHtml = withCrePlatformBranding(templateData.html);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: templateData.from,
        to: Array.isArray(finalTo) ? finalTo : [finalTo],
        subject: templateData.subject,
        html: brandedHtml,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error(`[send-email] Resend API error:`, data);
      return new Response(JSON.stringify({ error: 'Failed to send email' }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[send-email] Template ${templateId} sent to ${finalTo} by ${user?.email || 'anon'}`);

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
