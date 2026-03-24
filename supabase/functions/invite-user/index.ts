// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  const authorization = req.headers.get("Authorization");
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── 1. Verify caller JWT ──────────────────────────────────────
    if (!authorization) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Admin client — has service role key, used for admin operations
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Verify caller JWT using admin client for reliability (Gateway Bypass)
    const token = authorization.replace('Bearer ', '');
    const { data: { user: caller }, error: callerErr } = await adminClient.auth.getUser(token);
    
    if (callerErr || !caller) {
      console.error("[invite-user] Auth Error:", callerErr?.message || "No user found");
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 2. Verify caller is org_admin or super_admin ──────────────
    const { data: callerMemberships } = await adminClient
      .from("memberships")
      .select("role, org_id")
      .eq("user_id", caller.id);

    const ALLOWED_ROLES = ["super_admin", "org_admin"];
    const callerMembership = callerMemberships?.find((m: any) => ALLOWED_ROLES.includes(m.role));

    if (!callerMembership) {
      return new Response(JSON.stringify({ error: "Forbidden: insufficient role" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 3. Parse request body ─────────────────────────────────────
    const { email, full_name, role, org_id, onboarding_type } = await req.json();

    if (!email || !role) {
      return new Response(JSON.stringify({ error: "Missing required fields: email, role" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Default to 'invited' for staff roles, 'owner' for new client admins
    const targetOnboardingType = onboarding_type || "invited";

    if (role !== "super_admin" && targetOnboardingType === "invited" && !org_id) {
      return new Response(JSON.stringify({ error: "org_id is required for invited staff" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Super admin can invite to any org; org_admin only to their own org
    if (callerMembership.role === "org_admin" && org_id && callerMembership.org_id !== org_id) {
      return new Response(JSON.stringify({ error: "Forbidden: cannot invite to a different org" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 4. Generate user, membership, and send temp password ─────────
    // Check if user already exists
    const { data: existingUsers, error: listUserErr } = await adminClient.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(u => u.email === email);

    let tempPassword = "";
    let userId = existingUser?.id;
    let isNewUser = false;

    if (!userId) {
      tempPassword = crypto.randomUUID().slice(0, 8) + 'X1!';
      const { data: newUserData, error: createError } = await adminClient.auth.admin.createUser({
        email: email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: {
          full_name: full_name || '',
          role: role,
          onboarding_type: targetOnboardingType
        }
      });

      if (createError) throw createError;
      userId = newUserData.user.id;
      isNewUser = true;
    }

    // ── 5. Setup Membership ───────────────────────────────────────
    if (org_id && userId) {
      // Upsert membership
      const { error: membershipErr } = await adminClient
        .from('memberships')
        .upsert({
          user_id: userId,
          org_id: org_id,
          role: role
        }, { onConflict: 'user_id,org_id' });
        
      if (membershipErr) console.error('[invite-user] membership error:', membershipErr);
    }

    // ── 6. Log in invitations table ────────────────────────────────
    await adminClient.from("invitations").insert({
      email: email,
      org_id: targetOnboardingType === 'invited' ? org_id : null,
      role: role,
      token: "direct-invite",
      status: "accepted",
      expires_at: new Date(Date.now() + 86400000).toISOString()
    }).catch(e => console.error('[invite-user] invitation log err:', e));

    // ── 7. Send Email ─────────────────────────────────────────────
    const frontendUrl = Deno.env.get("FRONTEND_URL") || Deno.env.get("SITE_URL") || "http://localhost:5173";
    const loginLink = `${frontendUrl}/signin`;
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || Deno.env.get('VITE_RESEND_API_KEY');

    if (RESEND_API_KEY) {
      try {
        const emailWrapper = (content: string) => `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
          <title>CRE Suite</title>
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
            .code-block { background:#1e293b; color:#10b981; font-family:monospace; font-size:18px; padding:12px 16px; border-radius:8px; letter-spacing:1px; display:inline-block; margin-top:8px;}
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
                <span class="logo-text">CRE Suite</span>
              </div>
            </div>
            <div class="body">${content}</div>
            <div class="footer"><p>CRE Suite &middot; onboarding@cresuite.com &middot; &copy; 2025 All rights reserved</p></div>
          </div>
        </body>
        </html>
        `;

        const htmlContent = isNewUser ? emailWrapper(`
          <h1>You've Been Invited to CRE Suite 🎉</h1>
          <p>Hi ${full_name || 'there'},</p>
          <p>You have been invited to join your team on the <strong>CRE Suite</strong> platform as a ${role.replace('_', ' ')}.</p>
          <div class="info-box">
            <p><strong>Your Temporary Credentials:</strong></p>
            <p>Email: <strong>${email}</strong></p>
            <p>Temporary Password:<br/><span class="code-block">${tempPassword}</span></p>
          </div>
          <a href="${loginLink}" class="cta">Sign In to Your Account</a>
          <p>You will be required to change your password upon your first login.</p>
        `) : emailWrapper(`
          <h1>You've Been Added to a Team 🎉</h1>
          <p>Hi ${full_name || 'there'},</p>
          <p>Your existing <strong>CRE Suite</strong> account has been added to a new team as a ${role.replace('_', ' ')}.</p>
          <a href="${loginLink}" class="cta">Sign In to Your Account</a>
          <p>Use your existing credentials to log in and access your new workspace.</p>
        `);

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'CRE Suite <onboarding@cresuite.com>',
            to: email,
            subject: 'You have been invited to join your team on CRE Suite',
            html: htmlContent
          })
        });
        
        if (emailRes.ok) {
          console.log(`[invite-user] Resend email sent successfully to ${email}`);
        } else {
          console.error(`[invite-user] Resend Error:`, await emailRes.text());
        }
      } catch (emailErr: any) {
        console.error('[invite-user] Resend Fetch Error:', emailErr.message);
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[invite-user] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message || "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
