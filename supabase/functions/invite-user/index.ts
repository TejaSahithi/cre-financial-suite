import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
      phone, module_permissions, page_permissions, capabilities
    } = await req.json();

    if (!email || !role || !org_id) {
      return new Response(JSON.stringify({ error: "Missing required fields: email, role, org_id" }), {
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
        const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f8fafc;padding:40px">
          <div style="max-width:560px;margin:auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e2e8f0">
            <h2 style="color:#0f172a">You've been added to a team</h2>
            <p style="color:#475569">Hi ${full_name || "there"},<br/>Your existing CRE Suite account has been given access to a new organization as <strong>${role.replace("_"," ")}</strong>.</p>
            <a href="${loginLink}" style="display:inline-block;background:#1a2744;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:16px">Sign In</a>
          </div></body></html>`;
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: "CRE Suite <onboarding@cresuite.com>", to: email, subject: "You've been added to a CRE Suite team", html }),
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
