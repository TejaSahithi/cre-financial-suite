// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const BRAND_NAME = 'ProForma OS';
const SUPPORT_EMAIL = 'support@proformaos.ai';
const DEFAULT_FRONTEND_URL = 'https://www.proformaos.ai';
const LOGO_URL = `${DEFAULT_FRONTEND_URL}/assets/proforma-os-logo.png`;
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
const TWILIO_FROM_NUMBER = Deno.env.get('TWILIO_FROM_NUMBER') || '';
const TWILIO_MESSAGING_SERVICE_SID = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID') || '';

function resolveFrontendUrl(value?: string | null) {
  const url = String(value || '').trim().replace(/\/$/, '');
  return url && !/(vercel\.app|localhost)/i.test(url) ? url : DEFAULT_FRONTEND_URL;
}

/** Wraps HTML content in the standard ProForma OS branded email shell. */
const emailWrapper = (content: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${BRAND_NAME}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, sans-serif; margin:0; padding:0; background:#f8fafc; }
    .wrapper { max-width:600px; margin:40px auto; background:#fff; border-radius:16px; overflow:hidden; border:1px solid #e2e8f0; }
    .header { background:#071326; padding:26px 40px; }
    .logo { display:flex; align-items:center; gap:10px; }
    .logo-img { width:196px;height:auto;display:block;background:#fff;border-radius:8px;padding:8px 10px; }
    .body { padding:36px 40px; color:#475569; font-size:15px; line-height:1.6; }
    h1 { font-size:24px; font-weight:700; color:#0f172a; margin:0 0 8px; }
    p { margin:0 0 16px; }
    .cta { display:inline-block; background:#1a2744; color:#fff !important; padding:14px 28px; border-radius:10px; text-decoration:none; font-weight:600; font-size:15px; margin:8px 0 24px; }
    .info-box { background:#f1f5f9; border-radius:10px; padding:16px 20px; margin:20px 0; border-left:4px solid #3b82f6; }
    .divider { border:none; border-top:1px solid #e2e8f0; margin:24px 0; }
    .footer { background:#f8fafc; padding:20px 40px; text-align:center; border-top:1px solid #e2e8f0; }
    .footer p { color:#94a3b8; font-size:12px; margin:0; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="logo">
        <img class="logo-img" src="${LOGO_URL}" alt="${BRAND_NAME}" />
      </div>
    </div>
    <div class="body">${content}</div>
    <div class="footer"><p>${BRAND_NAME} &middot; ${SUPPORT_EMAIL} &middot; &copy; ${new Date().getFullYear()} All rights reserved</p></div>
  </div>
</body>
</html>
`;

function normalizeSmsPhone(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  const normalized = raw.startsWith('+')
    ? `+${digits}`
    : digits.length === 10
      ? `+1${digits}`
      : digits.length === 11 && digits.startsWith('1')
        ? `+${digits}`
        : '';
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : '';
}

async function sendApprovalSms(toPhone: unknown, message: string) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || (!TWILIO_FROM_NUMBER && !TWILIO_MESSAGING_SERVICE_SID)) {
    return { status: 'skipped', warning: 'Twilio SMS provider is not configured.' };
  }

  const to = normalizeSmsPhone(toPhone);
  if (!to) return { status: 'skipped', warning: 'Requester has no valid SMS phone number.' };

  const form = new URLSearchParams();
  form.set('To', to);
  form.set('Body', message.replace(/\s+/g, ' ').trim().slice(0, 1600));
  if (TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', TWILIO_MESSAGING_SERVICE_SID);
  else form.set('From', TWILIO_FROM_NUMBER);

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { status: 'failed', warning: payload?.message || 'Twilio SMS send failed.' };
  }

  return { status: 'sent', id: payload?.sid || null };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authorization = req.headers.get("Authorization");
    if (!authorization) {
      return new Response(JSON.stringify({ error: 'No Authorization header' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(JSON.stringify({ error: 'Missing environment variables' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseAdmin = createClient(
      supabaseUrl,
      supabaseServiceKey,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Verify caller JWT manually to bypass gated 401s
    const token = authorization.replace(/^[Bb]earer\s+/, "");
    console.log('[approve-request] Token received, verifying user');
    
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      console.error('[approve-request] Auth verification failed:', authError?.message);
      return new Response(JSON.stringify({ 
        error: 'Unauthorized', 
        details: authError?.message || 'Invalid or expired token'
      }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log('[approve-request] Authenticated user:', user.email);

    // Verify caller is super_admin (admin in profiles/memberships)
    const { data: membership, error: memberError } = await supabaseAdmin
      .from('memberships')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'super_admin')
      .maybeSingle();

    if (memberError) {
      console.error('[approve-request] Membership check error:', memberError.message);
    }

    if (!membership) {
      console.error('[approve-request] Forbidden: not super_admin. Found memberships for user:', user.id);
      return new Response(JSON.stringify({ 
        error: 'Forbidden: requires super_admin role',
        userId: user.id
      }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json();
    const requestId = body.id || body.requestId;
    // If 'approved' key is explicitly false, reject; otherwise approve
    const approved = body.approved !== false;

    console.log(`[approve-request] requestId=${requestId} approved=${approved} caller=${user.email}`);

    if (!requestId) {
      return new Response(JSON.stringify({ error: 'id/requestId is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Fetch the access request — allow ANY current status (toggling supported)
    const { data: accessRequest, error: reqError } = await supabaseAdmin
      .from('access_requests')
      .select('*')
      .eq('id', requestId)
      .single();

    if (reqError || !accessRequest) {
      console.error('[approve-request] Request not found:', reqError?.message);
      return new Response(JSON.stringify({ error: 'Access request not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const newStatus = approved ? 'approved' : 'rejected';
    console.log(`[approve-request] ${accessRequest.email}: ${accessRequest.status} -> ${newStatus}`);

    // Update the status (allow toggling between any states)
    const { error: updateErr } = await supabaseAdmin
      .from('access_requests')
      .update({ 
        status: newStatus, 
        approved_by: user.id, 
        updated_at: new Date().toISOString() 
      })
      .eq('id', requestId);

    if (updateErr) throw updateErr;

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const frontendUrl = resolveFrontendUrl(Deno.env.get('FRONTEND_URL') || Deno.env.get('SITE_URL'));
    const warnings: string[] = [];

    if (approved) {
      if (accessRequest.request_type === 'demo') {
        console.log(`[approve-request] Handling DEMO request for ${accessRequest.email}`);
        
        if (RESEND_API_KEY) {
          const emailWrapper = (content: string) => `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
            <title>${BRAND_NAME}</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, sans-serif; margin:0; padding:0; background:#f8fafc; }
              .wrapper { max-width:600px; margin:40px auto; background:#fff; border-radius:16px; overflow:hidden; border:1px solid #e2e8f0; }
              .header { background:#071326; padding:26px 40px; }
              .logo { display:flex; align-items:center; gap:10px; }
              .logo-icon { width:36px;height:36px;background:#fff;border-radius:8px;display:flex;align-items:center;justify-content:center; }
              .logo-text { color:#fff; font-size:18px; font-weight:700; letter-spacing:-0.3px; }
              .body { padding:36px 40px; }
              h1 { font-size:24px; font-weight:700; color:#0f172a; margin:0 0 8px; }
              p { color:#475569; font-size:15px; line-height:1.6; margin:0 0 16px; }
              .cta { display:inline-block; background:#1a2744; color:#fff !important; padding:14px 28px; border-radius:10px; text-decoration:none; font-weight:600; font-size:15px; margin:8px 0 24px; }
              .info-box { background:#f1f5f9; border-radius:10px; padding:16px 20px; margin:20px 0; border-left:4px solid #3b82f6; }
              .divider { border:none; border-top:1px solid #e2e8f0; margin:24px 0; }
              .footer { background:#f8fafc; padding:20px 40px; text-align:center; border-top:1px solid #e2e8f0; }
              .footer p { color:#94a3b8; font-size:12px; margin:0; }
            </style>
          </head>
          <body>
            <div class="wrapper">
              <div class="header">
                <div class="logo">
                  <img src="${LOGO_URL}" alt="${BRAND_NAME}" style="width:196px;height:auto;display:block;background:#ffffff;border-radius:8px;padding:8px 10px;" />
                </div>
              </div>
              <div class="body">${content}</div>
              <div class="footer"><p>${BRAND_NAME} &middot; ${SUPPORT_EMAIL} &middot; &copy; ${new Date().getFullYear()} All rights reserved</p></div>
            </div>
          </body>
          </html>
          `;

          const accessLink = `${frontendUrl}/request-access`;
          const html = emailWrapper(`
            <h1>Did You Enjoy the Demo? 🎬</h1>
            <p>Hi ${accessRequest.full_name},</p>
            <p>Thank you for watching the <strong>${BRAND_NAME}</strong> demo! We hope it gave you a clear view of how our platform can transform your commercial real estate operations.</p>
            <div class="info-box">
              <p><strong>Here's what ${BRAND_NAME} can do for ${accessRequest.company_name}:</strong></p>
              <p>✅ Automate CAM reconciliations &amp; budgeting<br/>
              ✅ Real-time financial insights across your portfolio<br/>
              ✅ Role-based access for your entire team<br/>
              ✅ Enterprise-grade security &amp; data isolation</p>
            </div>
            <p>Ready to get started? Request full platform access below and our team will have you up and running in minutes.</p>
            <a href="${accessLink}" class="cta">Request Full Access →</a>
            <hr class="divider"/>
            <p style="color:#94a3b8;font-size:13px;">Have questions? Simply reply to this email and our team will get back to you within 4 business hours.</p>
          `);

          const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: `${BRAND_NAME} <${SUPPORT_EMAIL}>`,
              to: accessRequest.email,
              subject: `Did you enjoy the ${BRAND_NAME} demo? Here's your next step!`,
              html: html
            })
          });
          
          if (!emailRes.ok) {
            console.error(`[approve-request] Resend DEMO Error:`, await emailRes.text());
          }
        }
      } else {
        // ACCESS request
        console.log(`[approve-request] Handling ACCESS request for ${accessRequest.email}`);
        
        // 1. Send purely informational approval email (User creates their own account via OAuth/Magic Link)
        if (RESEND_API_KEY) {
          const emailWrapper = (content: string) => `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
            <title>${BRAND_NAME}</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, sans-serif; margin:0; padding:0; background:#f8fafc; }
              .wrapper { max-width:600px; margin:40px auto; background:#fff; border-radius:16px; overflow:hidden; border:1px solid #e2e8f0; }
              .header { background:#071326; padding:26px 40px; }
              .logo { display:flex; align-items:center; gap:10px; }
              .logo-icon { width:36px;height:36px;background:#fff;border-radius:8px;display:flex;align-items:center;justify-content:center; }
              .logo-text { color:#fff; font-size:18px; font-weight:700; letter-spacing:-0.3px; }
              .body { padding:36px 40px; }
              h1 { font-size:24px; font-weight:700; color:#0f172a; margin:0 0 8px; }
              p { color:#475569; font-size:15px; line-height:1.6; margin:0 0 16px; }
              .cta { display:inline-block; background:#1a2744; color:#fff !important; padding:14px 28px; border-radius:10px; text-decoration:none; font-weight:600; font-size:15px; margin:8px 0 24px; }
              .info-box { background:#f1f5f9; border-radius:10px; padding:16px 20px; margin:20px 0; border-left:4px solid #3b82f6; }
              .divider { border:none; border-top:1px solid #e2e8f0; margin:24px 0; }
              .footer { background:#f8fafc; padding:20px 40px; text-align:center; border-top:1px solid #e2e8f0; }
              .footer p { color:#94a3b8; font-size:12px; margin:0; }
            </style>
          </head>
          <body>
            <div class="wrapper">
              <div class="header">
                <div class="logo">
                  <img src="${LOGO_URL}" alt="${BRAND_NAME}" style="width:196px;height:auto;display:block;background:#ffffff;border-radius:8px;padding:8px 10px;" />
                </div>
              </div>
              <div class="body">${content}</div>
              <div class="footer"><p>${BRAND_NAME} &middot; ${SUPPORT_EMAIL} &middot; &copy; ${new Date().getFullYear()} All rights reserved</p></div>
            </div>
          </body>
          </html>
          `;

          const loginLink = `${frontendUrl}/Login`;
          const html = emailWrapper(`
            <p>Hi ${accessRequest.full_name},</p>
            <p>Your access request has been approved.</p>
            <p>You can now create your account and get started with the platform.</p>
            <p>Create your account:<br/>
            <a href="${loginLink}">${loginLink}</a></p>
            <p>Once signed in, you will:</p>
            <ul>
              <li>Set up your company profile</li>
              <li>Complete onboarding (MSA, payment)</li>
              <li>Access your dashboard and modules</li>
            </ul>
            <p>If you have any questions, feel free to reply to this email.</p>
            <br/>
            <p>Welcome aboard,<br/>${BRAND_NAME} Team</p>
          `);

          try {
            const emailRes = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: `${BRAND_NAME} <${SUPPORT_EMAIL}>`,
                to: accessRequest.email,
                subject: 'Your access request has been approved',
                html: html
              })
            });
            
            if (!emailRes.ok) {
              const emailErrorText = await emailRes.text();
              console.error(`[approve-request] Resend ACCESS Error:`, emailErrorText);
              warnings.push(`Approval saved, but approval email was not sent (${emailRes.status}).`);
            }
          } catch (emailErr) {
            console.error('[approve-request] Approval email error (non-fatal):', emailErr.message);
            warnings.push('Approval saved, but approval email could not be sent.');
          }
        } else {
          console.warn('[approve-request] RESEND_API_KEY not set — skipping branded email.');
          warnings.push('Approval saved, but approval email was skipped because RESEND_API_KEY is not configured.');
        }

        const smsResult = await sendApprovalSms(
          accessRequest.phone,
          `${BRAND_NAME}: your access request for ${accessRequest.company_name || 'your organization'} has been approved. Sign in here: ${frontendUrl}/Login`
        );

        if (smsResult.status !== 'sent') {
          console.warn('[approve-request] Approval SMS not sent:', smsResult.warning);
          warnings.push(`Approval SMS not sent: ${smsResult.warning}`);
        } else {
          console.log('[approve-request] Approval SMS sent:', smsResult.id);
        }
      }

      const { error: auditErr } = await supabaseAdmin.from('audit_logs').insert({
        entity_type: 'AccessRequest', entity_id: requestId,
        action: 'approve', actor_user_id: user.id, actor_email: user.email, 
        after: { status: newStatus }, severity: 'info', source: 'edge_function',
      });
      if (auditErr) {
        console.error('[approve-request] Audit log failed (non-fatal):', auditErr.message);
        warnings.push('Approval saved, but audit logging failed.');
      }

      return new Response(JSON.stringify({ 
        success: true, status: newStatus,
        message: `Approval completed for ${accessRequest.email}.`,
        warning: warnings.join(' '),
        warnings,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // REJECTED path
    // Read optional reason from request body (already parsed above)
    const rejectionReason = body.reason || null;

    if (RESEND_API_KEY) {
      try {
        const rejHtml = emailWrapper(`
          <h1 style="margin:0 0 12px;color:#0f172a;font-size:22px;">Update on Your Access Request</h1>
          <p>Hi ${accessRequest.full_name},</p>
          <p>Thank you for your interest in ${BRAND_NAME}. After reviewing your request for <strong>${accessRequest.company_name || 'your organization'}</strong>, we are unable to approve access at this time.</p>
          ${rejectionReason ? `<div class="info-box"><p><strong>Reason:</strong> ${rejectionReason}</p></div>` : ''}
          <p>If you believe this is an error or would like to discuss further, please reply to this email or contact us at <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
          <p style="margin-bottom:0;">Thank you for your understanding.<br/>The ${BRAND_NAME} Team</p>
        `);

        const rejRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: `${BRAND_NAME} <${SUPPORT_EMAIL}>`,
            to: accessRequest.email,
            subject: `Update on Your ${BRAND_NAME} Access Request`,
            html: rejHtml,
          }),
        });

        if (!rejRes.ok) {
          // Log but do not fail the rejection operation itself
          console.error(`[approve-request] Rejection email send failed (${rejRes.status}):`, await rejRes.text());
        } else {
          console.log(`[approve-request] Rejection email sent to ${accessRequest.email}`);
        }
      } catch (emailErr) {
        // Email failure must not block the DB rejection
        console.error('[approve-request] Rejection email error (non-fatal):', emailErr.message);
      }
    } else {
      console.warn('[approve-request] RESEND_API_KEY not set — rejection email skipped.');
    }

    const { error: auditErr } = await supabaseAdmin.from('audit_logs').insert({
      entity_type: 'AccessRequest', entity_id: requestId,
      action: 'reject', actor_user_id: user.id, actor_email: user.email, 
      after: { status: newStatus }, severity: 'info', source: 'edge_function',
    });
    if (auditErr) {
      console.error('[approve-request] Audit log failed (non-fatal):', auditErr.message);
      warnings.push('Rejection saved, but audit logging failed.');
    }

    return new Response(JSON.stringify({ 
      success: true, status: newStatus,
      message: `Request rejected. Email sent to ${accessRequest.email}.`,
      warning: warnings.join(' '),
      warnings,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err: any) {
    console.error('[approve-request] Unhandled error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
