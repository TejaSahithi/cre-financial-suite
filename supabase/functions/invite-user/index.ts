// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": '*',
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_ROLE_ALIASES: Record<string, string> = {
  admin: "org_admin",
  user: "viewer",
};

const SYSTEM_ROLES = new Set([
  "super_admin",
  "org_admin",
  "manager",
  "editor",
  "viewer",
  "finance",
  "property_manager",
]);

function normalizeRoleValue(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function resolveMembershipRole(role: unknown, accessRole: unknown) {
  const normalizedAccessRole = normalizeRoleValue(accessRole);
  if (SYSTEM_ROLES.has(normalizedAccessRole)) return normalizedAccessRole;

  const normalizedRole = normalizeRoleValue(role);
  const aliasedRole = SYSTEM_ROLE_ALIASES[normalizedRole] || normalizedRole;
  if (SYSTEM_ROLES.has(aliasedRole)) return aliasedRole;

  return "viewer";
}

function resolveDisplayRole({
  role,
  customRole,
  capabilities,
  accessRole,
}: {
  role: unknown;
  customRole: unknown;
  capabilities: Record<string, unknown>;
  accessRole: unknown;
}) {
  const customLabel = typeof customRole === "string" ? customRole.trim() : "";
  if (customLabel) return customLabel;

  const capabilityCustomRole = typeof capabilities?.custom_role === "string"
    ? capabilities.custom_role.trim()
    : "";
  if (capabilityCustomRole) return capabilityCustomRole;

  const capabilityRoles = Array.isArray(capabilities?.roles)
    ? capabilities.roles.map((value) => normalizeRoleValue(value)).filter(Boolean)
    : [];

  const firstBusinessRole = capabilityRoles.find((value) => {
    return value !== "custom" && !SYSTEM_ROLES.has(value) && !SYSTEM_ROLE_ALIASES[value];
  });
  if (firstBusinessRole) return firstBusinessRole;

  const normalizedRole = normalizeRoleValue(role);
  if (normalizedRole && !SYSTEM_ROLES.has(normalizedRole) && !SYSTEM_ROLE_ALIASES[normalizedRole]) {
    return normalizedRole;
  }

  const normalizedAccessRole = normalizeRoleValue(accessRole);
  const fallbackRole = SYSTEM_ROLE_ALIASES[normalizedRole] || normalizedRole || normalizedAccessRole;
  return fallbackRole || "team member";
}

function formatRoleLabel(role: unknown) {
  return String(role || "team member").replaceAll("_", " ");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authorization = req.headers.get("Authorization");

  try {
    if (!authorization) {
      return new Response(JSON.stringify({ error: "Unauthorized: missing Authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      console.error("[invite-user] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
      return new Response(JSON.stringify({ error: "Server misconfigured: missing service credentials" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Verify caller is org_admin or super_admin
    const token = authorization.replace("Bearer ", "");
    const { data: { user: caller }, error: callerErr } = await adminClient.auth.getUser(token);
    if (callerErr || !caller) {
      console.error("[invite-user] getUser failed:", callerErr?.message);
      return new Response(JSON.stringify({ error: `Invalid token: ${callerErr?.message || "no user"}` }), {
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

    const incomingCapabilities = capabilities && typeof capabilities === "object" ? capabilities : {};
    const membershipRole = resolveMembershipRole(role, access_role);
    const displayRole = resolveDisplayRole({
      role,
      customRole: custom_role,
      capabilities: incomingCapabilities,
      accessRole: access_role,
    });

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

    // ── Fetch Organization Name ────────────────────────────────────────────────
    const { data: orgData } = await adminClient.from("organizations").select("name").eq("id", org_id).single();
    const orgName = orgData?.name || "Our Organization";

    // ── Check if user already exists ──────────────────────────────────────────
    const { data: existingUsers } = await adminClient.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find((u: any) => u.email === email);

    const frontendUrl = Deno.env.get("FRONTEND_URL") || Deno.env.get("SITE_URL") || "http://localhost:5173";
    let userId = existingUser?.id;
    let isNewUser = !userId;
    let inviteLink = `${frontendUrl}/Login`;

    if (isNewUser) {
      // Use generateLink to get a secure signup URL without sending the system email
      const { data: linkData, error: linkErr } = await adminClient.auth.admin.generateLink({
        type: "invite",
        email: email,
        options: {
          redirectTo: `${frontendUrl}/AcceptInvite`,
          data: {
            full_name: full_name || "",
            role: displayRole,
            app_role: membershipRole,
            org_id,
            org_name: orgName,
            invited_by: caller.id,
          },
        },
      });
      if (linkErr) throw linkErr;
      userId = linkData.user.id;
      inviteLink = linkData.properties.action_link;
    }

    // ── Upsert membership record (status: invited) ────────────────────────────
    const warnings: string[] = [];
    if (userId) {
      const membershipCapabilities = {
        ...incomingCapabilities,
        invited_email: email,
        invited_full_name: full_name || null,
      };
      const normalizedIncomingRole = normalizeRoleValue(role);
      if (
        !Array.isArray(membershipCapabilities.roles)
        && normalizedIncomingRole
        && !SYSTEM_ROLES.has(normalizedIncomingRole)
        && !SYSTEM_ROLE_ALIASES[normalizedIncomingRole]
      ) {
        membershipCapabilities.roles = [normalizedIncomingRole];
      }

      const membershipRow: any = {
        user_id: userId,
        org_id,
        role: membershipRole,
        status: "invited",
      };
      if (custom_role) membershipRow.custom_role = custom_role;
      if (phone) membershipRow.phone = phone;
      if (module_permissions && Object.keys(module_permissions).length > 0) membershipRow.module_permissions = module_permissions;
      if (page_permissions && Object.keys(page_permissions).length > 0) membershipRow.page_permissions = page_permissions;
      if (Object.keys(membershipCapabilities).length > 0) membershipRow.capabilities = membershipCapabilities;

      const { error: membershipErr } = await adminClient
        .from("memberships")
        .upsert(membershipRow, { onConflict: "user_id,org_id" });
      if (membershipErr) {
        console.error("[invite-user] membership upsert error:", membershipErr);
        // Auth user already exists at this point — don't 500 on a missing
        // optional column. Surface the warning so the client can show it.
        const { error: fallbackMembershipErr } = await adminClient
          .from("memberships")
          .upsert(
            {
              user_id: userId,
              org_id,
              role: membershipRole,
            },
            { onConflict: "user_id,org_id" },
          );

        if (fallbackMembershipErr) {
          console.error("[invite-user] fallback membership upsert error:", fallbackMembershipErr);
          warnings.push(`membership: ${fallbackMembershipErr.message}`);
        } else {
          warnings.push(`membership metadata: ${membershipErr.message}`);
        }
      }

      // ── Ensure profile row exists for invited user ────────────────────────
      const { error: profileErr } = await adminClient.from("profiles").upsert({
        id: userId,
        email,
        full_name: full_name || null,
        status: "active",
        onboarding_type: "invited",
        first_login: true,
      }, { onConflict: "id" });
      
      if (profileErr) console.error("[invite-user] profile upsert:", profileErr);

      const normalizedScope = {
        portfolios: Array.isArray(access_scopes?.portfolios) ? [...new Set(access_scopes.portfolios.filter(Boolean))] : [],
        properties: Array.isArray(access_scopes?.properties) ? [...new Set(access_scopes.properties.filter(Boolean))] : [],
      };
      const normalizedAccessRole = ["viewer", "editor", "manager"].includes(access_role)
        ? access_role
        : (["viewer", "editor", "manager"].includes(membershipRole) ? membershipRole : "viewer");

      const { error: deleteAccessError } = await adminClient
        .from("user_access")
        .delete()
        .eq("user_id", userId)
        .eq("org_id", org_id);

      if (deleteAccessError) {
        console.error("[invite-user] user_access delete error:", deleteAccessError);
        warnings.push(`user_access delete: ${deleteAccessError.message}`);
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
          warnings.push(`user_access insert: ${accessInsertError.message}`);
        }
      }
    }

    // ── Log invitation ────────────────────────────────────────────────────────
    const { error: inviteLogErr } = await adminClient.from("invitations").insert({
      email,
      org_id,
      role: displayRole,
      token: "magic-link",
      status: "pending_approval",
      expires_at: new Date(Date.now() + 86400000).toISOString(), // 24h
    });

    if (inviteLogErr) console.error("[invite-user] invitation log err:", inviteLogErr);

    // ── Send Branded Email via Resend ──────────────────────────────────────────
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || Deno.env.get("VITE_RESEND_API_KEY");
    if (RESEND_API_KEY) {
      try {
        const roleLabel = formatRoleLabel(displayRole);
        const title = isNewUser ? "Complete your account setup" : "You've been added to a new organization";
        const bodyText = isNewUser 
          ? `You've been invited to join <strong>${orgName}</strong> as <strong>${roleLabel}</strong>. Please create your account to get started.`
          : `Your existing CRE Platform account has been given access to <strong>${orgName}</strong> as <strong>${roleLabel}</strong>.`;
        const ctaText = isNewUser ? "Create Account" : "Sign In";

        const html = `<!DOCTYPE html>
          <html lang="en">
            <head>
              <meta charset="UTF-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1.0" />
              <title>CRE Platform</title>
            </head>
            <body style="margin:0;padding:40px 16px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
              <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
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
                  <h2 style="margin:0 0 12px;color:#0f172a;font-size:24px;">${title}</h2>
                  <p style="margin:0 0 16px;">Hi ${full_name || "there"},</p>
                  <p style="margin:0 0 20px;">${bodyText}</p>
                  <a href="${inviteLink}" style="display:inline-block;background:#1a2744;color:#ffffff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:16px;">${ctaText}</a>
                </div>
                <div style="border-top:1px solid #e2e8f0;background:#f8fafc;padding:18px 36px;text-align:center;color:#94a3b8;font-size:12px;">CRE Platform · support@cresuite.org</div>
              </div>
            </body>
          </html>`;

        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ 
            from: "CRE Platform <support@cresuite.org>", 
            to: email, 
            subject: title, 
            html 
          }),
        });
      } catch (e: any) { console.error("[invite-user] email send err:", e.message); }
    }

    return new Response(JSON.stringify({ success: true, isNewUser, warnings }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[invite-user] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message || "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
