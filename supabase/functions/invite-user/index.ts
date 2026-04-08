import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": '*',
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authorization = req.headers.get("Authorization");

  try {
    if (!authorization) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Verify caller is org_admin or super_admin
    const token = authorization.replace("Bearer ", "");
    const { data: { user: caller }, error: callerErr } = await adminClient.auth.getUser(token);
    if (callerErr || !caller) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: callerMemberships } = await adminClient.from("memberships").select("role, org_id").eq("user_id", caller.id);
    const callerMembership = callerMemberships?.find((m: any) => ["super_admin", "org_admin"].includes(m.role));
    if (!callerMembership) {
      return new Response(JSON.stringify({ error: "Forbidden: insufficient role" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const {
      email, full_name, role, custom_role, org_id,
      phone, module_permissions, page_permissions, capabilities,
      access_scopes, access_role
    } = await req.json();

    // role is optional: null/omitted means user is imported with no role (no_access)
    if (!email || !org_id) {
      return new Response(JSON.stringify({ error: "Missing required fields: email, org_id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (callerMembership.role === "org_admin" && callerMembership.org_id !== org_id) {
      return new Response(JSON.stringify({ error: "Forbidden: cannot invite to a different org" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Check if user already exists ──────────────────────────────────────────
    const { data: existingUsers } = await adminClient.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find((u: any) => u.email === email);

    const frontendUrl = Deno.env.get("FRONTEND_URL") || Deno.env.get("SITE_URL") || "http://localhost:5173";
    let userId = existingUser?.id;
    let isNewUser = !userId;

    if (isNewUser) {
      // ── Use inviteUserByEmail for new users (magic link, time-limited, single-use) ──
      const { data: inviteData, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(email, {
        redirectTo: `${frontendUrl}/AcceptInvite`,
        data: {
          full_name: full_name || "",
          role,
          org_id,
          invited_by: caller.id,
        },
      });
      if (inviteErr) throw inviteErr;
      userId = inviteData.user.id;
    }

    // ── Upsert membership record (status: invited) ────────────────────────────
    if (userId) {
      const membershipRow: any = {
        user_id: userId,
        org_id,
        role,
        status: "invited",
      };
      if (custom_role) membershipRow.custom_role = custom_role;
      if (phone) membershipRow.phone = phone;
      if (module_permissions && Object.keys(module_permissions).length > 0) membershipRow.module_permissions = module_permissions;
      if (page_permissions && Object.keys(page_permissions).length > 0) membershipRow.page_permissions = page_permissions;
      if (capabilities && Object.keys(capabilities).length > 0) membershipRow.capabilities = capabilities;

      const { error: membershipErr } = await adminClient.from("memberships").upsert(membershipRow, { onConflict: "user_id,org_id" });
      if (membershipErr) console.error("[invite-user] membership error:", membershipErr);

      // ── Ensure profile row exists for invited user ────────────────────────
      await adminClient.from("profiles").upsert({
        id: userId,
        email,
        full_name: full_name || null,
        status: "active",
        onboarding_type: "invited",
        first_login: true,
      }, { onConflict: "id" }).catch((e: any) => console.error("[invite-user] profile upsert:", e));

      const normalizedScope = {
        portfolios: Array.isArray(access_scopes?.portfolios) ? [...new Set(access_scopes.portfolios.filter(Boolean))] : [],
        properties: Array.isArray(access_scopes?.properties) ? [...new Set(access_scopes.properties.filter(Boolean))] : [],
      };
      const normalizedAccessRole = ["viewer", "editor", "manager"].includes(access_role) ? access_role : "viewer";

      const { error: deleteAccessError } = await adminClient
        .from("user_access")
        .delete()
        .eq("user_id", userId)
        .eq("org_id", org_id);

      if (deleteAccessError) {
        console.error("[invite-user] user_access delete error:", deleteAccessError);
      }

      const accessRows = [
        ...normalizedScope.portfolios.map((scopeId: string) => ({
          user_id: userId,
          org_id,
          scope: "portfolio",
          scope_id: scopeId,
          role: normalizedAccessRole,
          granted_by: caller.id,
          is_active: true,
        })),
        ...normalizedScope.properties.map((scopeId: string) => ({
          user_id: userId,
          org_id,
          scope: "property",
          scope_id: scopeId,
          role: normalizedAccessRole,
          granted_by: caller.id,
          is_active: true,
        })),
      ];

      if (accessRows.length > 0) {
        const { error: accessInsertError } = await adminClient
          .from("user_access")
          .insert(accessRows);

        if (accessInsertError) {
          console.error("[invite-user] user_access insert error:", accessInsertError);
        }
      }
    }

    // ── Log invitation ────────────────────────────────────────────────────────
    await adminClient.from("invitations").insert({
      email, org_id, role,
      token: "magic-link",
      status: "accepted",
      expires_at: new Date(Date.now() + 86400000).toISOString(), // 24h
    }).catch((e: any) => console.error("[invite-user] invitation log err:", e));

    // ── If user already existed, send a notification email instead ────────────
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || Deno.env.get("VITE_RESEND_API_KEY");
    if (!isNewUser && RESEND_API_KEY) {
      try {
        const loginLink = `${frontendUrl}/Login`;
        const roleLabel = role ? role.replaceAll("_", " ") : "team member";
        const html = `<!DOCTYPE html>
          <html lang="en">
            <head>
              <meta charset="UTF-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1.0" />
              <title>CRE Platform</title>
            </head>
            <body style="margin:0;padding:40px 16px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
              <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
                <div style="padding:28px 36px;background:linear-gradient(135deg,#1a2744 0%,#2d4a8a 100%);">
                  <div style="display:flex;align-items:center;gap:10px;">
                    <div style="width:36px;height:36px;border-radius:10px;background:#ffffff;display:flex;align-items:center;justify-content:center;">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1a2744" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                        <polyline points="9 22 9 12 15 12 15 22"></polyline>
                      </svg>
                    </div>
                    <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">CRE Platform</span>
                  </div>
                </div>
                <div style="padding:32px 36px;color:#475569;font-size:15px;line-height:1.6;">
                  <h2 style="margin:0 0 12px;color:#0f172a;font-size:24px;">You've been added to a team</h2>
                  <p style="margin:0 0 16px;">Hi ${full_name || "there"},</p>
                  <p style="margin:0 0 20px;">Your existing CRE Platform account has been given access to a new organization as <strong>${roleLabel}</strong>.</p>
                  <a href="${loginLink}" style="display:inline-block;background:#1a2744;color:#ffffff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600;">Sign In</a>
                </div>
                <div style="border-top:1px solid #e2e8f0;background:#f8fafc;padding:18px 36px;text-align:center;color:#94a3b8;font-size:12px;">CRE Platform · support@cresuite.org</div>
              </div>
            </body>
          </html>`;
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: "CRE Platform <support@cresuite.org>", to: email, subject: "You've been added to a CRE Platform team", html }),
        });
      } catch (e: any) { console.error("[invite-user] existing user email err:", e.message); }
    }

    return new Response(JSON.stringify({ success: true, isNewUser }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[invite-user] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message || "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
