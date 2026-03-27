// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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
    const frontendUrl = Deno.env.get('FRONTEND_URL') || Deno.env.get('SITE_URL') || 'http://localhost:5173';

    if (approved) {
      if (accessRequest.request_type === 'demo') {
        console.log(`[approve-request] Handling DEMO request for ${accessRequest.email}`);
        
        if (RESEND_API_KEY) {
          const emailWrapper = (content: string) => `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
            <title>CRE Platform</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, sans-serif; margin:0; padding:0; background:#f8fafc; }
              .wrapper { max-width:600px; margin:40px auto; background:#fff; border-radius:16px; overflow:hidden; border:1px solid #e2e8f0; }
              .header { background:linear-gradient(135deg,#1a2744 0%,#2d4a8a 100%); padding:32px 40px; }
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
                  <div class="logo-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1a2744" stroke-width="2.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
                  </div>
                  <span class="logo-text">CRE Platform</span>
                </div>
              </div>
              <div class="body">${content}</div>
              <div class="footer"><p>CRE Platform &middot; support@cresuite.org &middot; &copy; 2025 All rights reserved</p></div>
            </div>
          </body>
          </html>
          `;

          const accessLink = `${frontendUrl}/request-access`;
          const html = emailWrapper(`
            <h1>Did You Enjoy the Demo? 🎬</h1>
            <p>Hi ${accessRequest.full_name},</p>
            <p>Thank you for watching the <strong>CRE Platform</strong> demo! We hope it gave you a clear view of how our platform can transform your commercial real estate operations.</p>
            <div class="info-box">
              <p><strong>Here's what CRE Platform can do for ${accessRequest.company_name}:</strong></p>
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
              from: 'CRE Platform <support@cresuite.org>',
              to: accessRequest.email,
              subject: 'Did you enjoy the CRE Platform demo? Here\'s your next step!',
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
            <title>CRE Platform</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, sans-serif; margin:0; padding:0; background:#f8fafc; }
              .wrapper { max-width:600px; margin:40px auto; background:#fff; border-radius:16px; overflow:hidden; border:1px solid #e2e8f0; }
              .header { background:linear-gradient(135deg,#1a2744 0%,#2d4a8a 100%); padding:32px 40px; }
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
                  <div class="logo-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1a2744" stroke-width="2.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
                  </div>
                  <span class="logo-text">CRE Platform</span>
                </div>
              </div>
              <div class="body">${content}</div>
              <div class="footer"><p>CRE Platform &middot; support@cresuite.org &middot; &copy; 2025 All rights reserved</p></div>
            </div>
          </body>
          </html>
          `;

          const loginLink = `${frontendUrl}/signin`;
          const html = emailWrapper(`
            <p>Hi ${accessRequest.full_name},</p>
            <p>Your access request has been approved.</p>
            <p>You can now create your account and get started with the platform.</p>
            <p>👉 Create your account:<br/>
            <a href="${loginLink}">${loginLink}</a></p>
            <p>Once signed in, you will:</p>
            <ul>
              <li>Set up your company profile</li>
              <li>Complete onboarding (MSA, payment)</li>
              <li>Access your dashboard and modules</li>
            </ul>
            <p>If you have any questions, feel free to reply to this email.</p>
            <br/>
            <p>Welcome aboard,<br/>CRE Financial Suite Team</p>
          `);

            const emailRes = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'CRE Platform <support@cresuite.org>',
                to: accessRequest.email,
                subject: 'Your access request has been approved',
                html: html
              })
            });
            
            if (!emailRes.ok) {
              console.error(`[approve-request] Resend ACCESS Error:`, await emailRes.text());
              throw new Error("Failed to send approval email via Resend.");
            }
        } else {
          console.warn('[approve-request] RESEND_API_KEY not set — skipping branded email.');
        }
      }

      await supabaseAdmin.from('audit_logs').insert({
        entity_type: 'AccessRequest', entity_id: requestId,
        action: 'approve', user_id: user.id, user_email: user.email, new_value: newStatus,
      }).catch((e: any) => console.warn('[approve-request] audit log failed:', e.message));

      return new Response(JSON.stringify({ 
        success: true, status: newStatus,
        message: `Approval completed for ${accessRequest.email}.`
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // REJECTED path
    if (RESEND_API_KEY) {
      const rejRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'CRE Platform <support@cresuite.org>',
          to: accessRequest.email,
          subject: 'Update on your CRE Platform Access Request',
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
              <h1 style="color: #1e293b;">Hi ${accessRequest.full_name},</h1>
              <p>Sorry, your access to CRE Platform has been revoked due to security reasons.</p>
              <p>Please contact support if you have any questions or believe this is a mistake.</p>
              <hr style="border-color: #e2e8f0; margin: 24px 0;" />
              <p style="color: #94a3b8; font-size: 12px;">CRE Platform · onboarding@cresuite.com</p>
            </div>
          `
        })
      });
      if (!rejRes.ok) {
        console.error(`[approve-request] Resend REJECT Error:`, await rejRes.text());
        throw new Error("Failed to send rejection email via Resend.");
      }
      console.log(`[approve-request] Rejection email status=${rejRes.status}`);
    }

    await supabaseAdmin.from('audit_logs').insert({
      entity_type: 'AccessRequest', entity_id: requestId,
      action: 'reject', user_id: user.id, user_email: user.email, new_value: newStatus,
    }).catch((e: any) => console.warn('[approve-request] audit log failed:', e.message));

    return new Response(JSON.stringify({ 
      success: true, status: newStatus,
      message: `Request rejected. Email sent to ${accessRequest.email}.`
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err: any) {
    console.error('[approve-request] Unhandled error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
