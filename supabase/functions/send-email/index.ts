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
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const BRAND_NAME = 'ProForma OS';
const SUPPORT_EMAIL = 'support@proformaos.ai';
const DEFAULT_FRONTEND_URL = 'https://www.proformaos.ai';
function resolveFrontendUrl(value?: string | null) {
  const url = String(value || '').trim().replace(/\/$/, '');
  return url && !/(vercel\.app|localhost)/i.test(url) ? url : DEFAULT_FRONTEND_URL;
}
const APP_BASE_URL = resolveFrontendUrl(Deno.env.get('FRONTEND_URL') || Deno.env.get('SITE_URL'));
const FROM_DEFAULT = `${BRAND_NAME} <${SUPPORT_EMAIL}>`;
const LOGO_URL = `${APP_BASE_URL}/assets/proforma-os-logo.png`;

function absoluteAppUrl(value: unknown) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return `${APP_BASE_URL}${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch (_err) {
      return url;
    }
  }
  return `${APP_BASE_URL}${url.startsWith('/') ? url : `/${url}`}`;
}

const getCorsHeaders = (origin: string | null) => {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
};

const withProFormaBranding = (content: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${BRAND_NAME}</title>
  <style>
    body { margin: 0; padding: 0; background: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .wrapper { max-width: 600px; margin: 40px auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; }
    .header { padding: 26px 36px; background: #071326; }
    .brand { display: flex; align-items: center; gap: 10px; }
    .logo-img { width: 196px; height: auto; display: block; background: #ffffff; border-radius: 8px; padding: 8px 10px; }
    .body { padding: 32px 36px; color: #475569; line-height: 1.6; font-size: 15px; }
    .body h1, .body h2, .body h3 { color: #0f172a; margin-top: 0; }
    .footer { border-top: 1px solid #e2e8f0; background: #f8fafc; padding: 18px 36px; text-align: center; color: #94a3b8; font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="brand">
        <img class="logo-img" src="${LOGO_URL}" alt="${BRAND_NAME}" />
      </div>
    </div>
    <div class="body">${content}</div>
    <div class="footer">${BRAND_NAME} · ${SUPPORT_EMAIL}</div>
  </div>
</body>
</html>`;

const PUBLIC_TEMPLATES = [
  'request_access_autoreply',
  'request_access_admin_notification',
  'request_demo_autoreply',
  'request_demo_admin_notification',
  'demo_followup',
  'contact_autoreply',
  'contact_admin_notification'
];

const AUTHENTICATED_TEMPLATES = [
  'budget_approval_notification',
  'lease_review_summary',
  'generic_internal_notification'
];

function normalizeId(value: unknown) {
  const text = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text) ? text : '';
}

function isActiveMembershipStatus(value: unknown) {
  const status = String(value || 'active').toLowerCase();
  return ['active', 'owner', 'approved'].includes(status);
}

function createAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

async function resolveInternalRecipientEmail({ supabaseAdmin, user, orgId, recipientUserId }: any) {
  const normalizedOrgId = normalizeId(orgId);
  const normalizedRecipientUserId = normalizeId(recipientUserId);

  if (!supabaseAdmin || !user?.id || !normalizedOrgId || !normalizedRecipientUserId) {
    return { email: '', error: 'Missing notification recipient resolution context' };
  }

  const { data: callerMembership, error: callerError } = await supabaseAdmin
    .from('memberships')
    .select('user_id, org_id, role, status')
    .eq('org_id', normalizedOrgId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (callerError) {
    console.error('[send-email] caller membership lookup failed:', callerError.message);
    return { email: '', error: 'Could not verify notification sender access' };
  }

  if (!callerMembership || !isActiveMembershipStatus(callerMembership.status)) {
    return { email: '', error: 'Notification sender is not active in this organization' };
  }

  const { data: targetMembership, error: targetError } = await supabaseAdmin
    .from('memberships')
    .select('user_id, org_id, status')
    .eq('org_id', normalizedOrgId)
    .eq('user_id', normalizedRecipientUserId)
    .maybeSingle();

  if (targetError) {
    console.error('[send-email] recipient membership lookup failed:', targetError.message);
    return { email: '', error: 'Could not verify notification recipient access' };
  }

  if (!targetMembership || !isActiveMembershipStatus(targetMembership.status)) {
    return { email: '', error: 'Notification recipient is not active in this organization' };
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('email')
    .eq('id', normalizedRecipientUserId)
    .maybeSingle();

  if (profileError) {
    console.error('[send-email] recipient profile lookup failed:', profileError.message);
    return { email: '', error: 'Could not resolve notification recipient profile' };
  }

  if (profile?.email) return { email: profile.email, error: '' };

  const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.getUserById(normalizedRecipientUserId);
  if (authError) {
    console.error('[send-email] auth recipient lookup failed:', authError.message);
    return { email: '', error: 'Could not resolve notification recipient auth record' };
  }

  return {
    email: authUser?.user?.email || '',
    error: authUser?.user?.email ? '' : 'Notification recipient has no email address',
  };
}

function getTemplateData(templateId: string, variables: any) {
  const adminEmail = SUPPORT_EMAIL;
  const fromDefault = FROM_DEFAULT;
  const actionUrl = absoluteAppUrl(variables.actionUrl || variables.action_url);
  
  switch(templateId) {
    case 'request_access_autoreply':
      return {
        from: fromDefault,
        subject: `${BRAND_NAME} - We've received your access request`,
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
        subject: `${BRAND_NAME} - Thanks for reaching out`,
        html: `
          <h1>Thanks for reaching out, ${variables.name || 'there'}!</h1>
          <p>We've received your message and our team will get back to you shortly.</p>
        `
      };
    case 'demo_followup':
      return {
        from: fromDefault,
        subject: `Thanks for exploring ${BRAND_NAME}`,
        html: `
          <h1>Thanks for exploring ${BRAND_NAME}</h1>
          <p>Hi ${variables.name || 'there'},</p>
          <p>Thanks for taking the time to explore our platform.</p>
          <p>We hope the demo gave you a clear view of how you can automate budgeting and CAM, manage portfolios and properties efficiently, and replace spreadsheets with a unified operating system.</p>
          <p style="margin: 24px 0 0;"><a href="${actionUrl || `${APP_BASE_URL}/RequestAccess?tab=access`}" style="display: inline-block; padding: 12px 18px; border-radius: 10px; background: #071326; color: #ffffff; text-decoration: none; font-weight: 600;">Request Platform Access</a></p>
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
          ${actionUrl ? `<p style="margin: 0 0 18px;"><a href="${actionUrl}" style="display: inline-block; padding: 12px 18px; border-radius: 10px; background: #071326; color: #ffffff; text-decoration: none; font-weight: 600;">Open Budget Review</a></p>` : ''}
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
        subject: `${BRAND_NAME} Notification: ${variables.subject || 'Update'}`,
        html: `
          <h1>${variables.subject || 'Platform Notification'}</h1>
          <p>${variables.message || 'You have a new notification.'}</p>
          ${actionUrl ? `<p style="margin: 24px 0 0;"><a href="${actionUrl}" style="display: inline-block; padding: 12px 18px; border-radius: 10px; background: #071326; color: #ffffff; text-decoration: none; font-weight: 600;">Open in ${BRAND_NAME}</a></p>` : ''}
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

    const supabaseAdmin = createAdminClient();

    if (token) {
      try {
        const tokenData = JSON.parse(atob(token.split('.')[1] || ""));
        isAnon = tokenData.role === 'anon';
      } catch (e) {
        // ignore parsing error
      }
      
      if (supabaseAdmin) {
        const { data: authData } = await supabaseAdmin.auth.getUser(token);
        if (authData?.user) {
          user = authData.user;
          isAnon = false; // Override anon if getUser succeeds
        }
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
    let finalTo = templateData.to || to;
    if (!finalTo && templateId === 'generic_internal_notification') {
      const resolvedRecipient = await resolveInternalRecipientEmail({
        supabaseAdmin,
        user,
        orgId: body.orgId || variables.org_id,
        recipientUserId: body.recipientUserId || variables.recipient_user_id,
      });

      if (resolvedRecipient.error) {
        console.error('[send-email] recipient resolution failed:', resolvedRecipient.error);
      }

      finalTo = resolvedRecipient.email;
    }

    if (!finalTo) {
      return new Response(JSON.stringify({ error: 'Missing required field: to' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 3. Send via Resend ──
    const brandedHtml = withProFormaBranding(templateData.html);

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
