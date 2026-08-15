// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": '*',
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BRAND_NAME = "ProForma OS";
const SUPPORT_EMAIL = "support@proformaos.ai";
const DEFAULT_FRONTEND_URL = "https://www.proformaos.ai";
const LOGO_URL = `${DEFAULT_FRONTEND_URL}/assets/proforma-os-logo.png`;

function resolveFrontendUrl(value?: string | null) {
  let url = String(value || "").trim().replace(/\/+$/, "");
  if (!url || /(vercel\.app|localhost)/i.test(url)) return DEFAULT_FRONTEND_URL;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    return new URL(url).origin;
  } catch {
    return DEFAULT_FRONTEND_URL;
  }
}

const SYSTEM_ROLE_ALIASES: Record<string, string> = {
  admin: "org_admin",
  custom: "custom_role",
};

const SYSTEM_ROLES = new Set([
  "super_admin",
  "org_owner",
  "org_admin",
  "portfolio_manager",
  "property_manager",
  "lease_admin",
  "leasing_agent",
  "finance",
  "property_owner",
  "auditor",
  "tenant",
  "custom_role",
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

  return null;
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

function buildAcceptInviteUrl(frontendUrl: string, params: Record<string, string>) {
  const url = new URL("/AcceptInvite", resolveFrontendUrl(frontendUrl));
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  return url.toString();
}

async function resolveEffectiveAccessScopes(adminClient: any, orgId: string, accessScopes: any) {
  const normalized = {
    portfolios: Array.isArray(accessScopes?.portfolios) ? [...new Set(accessScopes.portfolios.filter(Boolean))] : [],
    properties: Array.isArray(accessScopes?.properties) ? [...new Set(accessScopes.properties.filter(Boolean))] : [],
  };

  if (!orgId || normalized.portfolios.length === 0 || accessScopes?.allPortfolios || accessScopes?.allProperties) {
    return normalized;
  }

  const { data, error } = await adminClient
    .from("properties")
    .select("id, portfolio_id")
    .eq("org_id", orgId)
    .in("portfolio_id", normalized.portfolios);

  if (error) throw error;

  for (const property of data || []) {
    if (property?.id) normalized.properties.push(property.id);
  }
  normalized.properties = [...new Set(normalized.properties)];
  return normalized;
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
    const callerMembership = callerMemberships?.find((m: any) => ["super_admin", "org_owner", "org_admin"].includes(m.role));
    if (!callerMembership) {
      return new Response(JSON.stringify({ error: "Forbidden: insufficient role" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const {
      email, full_name, role, custom_role, org_id,
      phone, module_permissions, page_permissions, capabilities,
      approval_limits, notification_preferences,
      access_scopes, access_role
    } = await req.json();
    const normalizedEmail = String(email || "").trim().toLowerCase();

    const CANONICAL_ASSIGNABLE_ROLES = [
      "org_owner", "org_admin", "portfolio_manager", "property_manager",
      "lease_admin", "leasing_agent", "finance", "property_owner",
      "auditor", "tenant", "custom_role",
    ];
    const PLATFORM_ASSIGNABLE_ROLES = ["super_admin", ...CANONICAL_ASSIGNABLE_ROLES];
    const OWNER_ASSIGNABLE_ROLES = CANONICAL_ASSIGNABLE_ROLES;
    const ORG_ASSIGNABLE_ROLES = CANONICAL_ASSIGNABLE_ROLES.filter((value) => value !== "org_owner");

    const assignableRoles = callerMembership.role === "super_admin"
      ? PLATFORM_ASSIGNABLE_ROLES
      : callerMembership.role === "org_owner"
        ? OWNER_ASSIGNABLE_ROLES
        : ORG_ASSIGNABLE_ROLES;

    if (role && !assignableRoles.includes(role)) {
      if (role === "super_admin") {
        const { error: auditErr } = await adminClient.from("audit_logs").insert({
          org_id: org_id || null,
          actor_user_id: caller.id,
          action: "privilege_escalation_blocked",
          entity_type: "membership",
          entity_id: null,
          metadata: { requested_role: role, email: normalizedEmail },
          severity: "critical",
          source: "edge_function",
          error_message: "Forbidden: org_admin attempted to assign super_admin"
        });
        if (auditErr) throw new Error(`Audit log failed: ${auditErr.message}`);
      }
      return new Response(JSON.stringify({ error: "Forbidden: role not assignable by your current role" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (callerMembership.role === "super_admin" && role && !PLATFORM_ASSIGNABLE_ROLES.includes(role)) {
      return new Response(JSON.stringify({ error: "Forbidden: invalid role" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const incomingCapabilities = capabilities && typeof capabilities === "object" ? capabilities : {};
    const membershipRole = resolveMembershipRole(role, access_role);
    const displayRole = resolveDisplayRole({
      role,
      customRole: custom_role,
      capabilities: incomingCapabilities,
      accessRole: access_role,
    });

    if (!normalizedEmail || !org_id) {
      return new Response(JSON.stringify({ error: "Missing required fields: email, org_id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!membershipRole) {
      return new Response(JSON.stringify({ error: "A valid team role is required before sending an invite" }), {
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
    const existingUser = existingUsers?.users?.find((u: any) => String(u.email || "").toLowerCase() === normalizedEmail);

    const frontendUrl = resolveFrontendUrl(Deno.env.get("FRONTEND_URL") || Deno.env.get("SITE_URL"));
    let userId = existingUser?.id;
    let isNewUser = !userId;
    let inviteLink = buildAcceptInviteUrl(frontendUrl, {
      existing: "1",
      org_id,
      email: normalizedEmail,
    });

    if (isNewUser) {
      // Use generateLink to get a secure signup URL without sending the system email
      const { data: linkData, error: linkErr } = await adminClient.auth.admin.generateLink({
        type: "invite",
        email: normalizedEmail,
        options: {
          redirectTo: `${frontendUrl}/AcceptInvite`,
          data: {
            full_name: full_name || "",
            role: displayRole,
            app_role: membershipRole,
            onboarding_type: "invited",
            org_id,
            org_name: orgName,
            invited_by: caller.id,
          },
        },
      });
      if (linkErr) throw linkErr;
      userId = linkData.user.id;
      inviteLink = linkData.properties?.hashed_token
        ? buildAcceptInviteUrl(frontendUrl, {
          token_hash: linkData.properties.hashed_token,
          type: "invite",
          org_id,
        })
        : linkData.properties.action_link;
    }

    // ── Upsert membership record (status: invited) ────────────────────────────
    const { data: existingMembership } = userId
      ? await adminClient
        .from("memberships")
        .select("status")
        .eq("user_id", userId)
        .eq("org_id", org_id)
        .maybeSingle()
      : { data: null };

    const nextMembershipStatus = ["active", "owner"].includes(existingMembership?.status)
      ? existingMembership.status
      : "invited";
    const invitationStatus = nextMembershipStatus === "invited" ? "pending_approval" : "accepted";

    const warnings: string[] = [];
    if (userId) {
      const membershipCapabilities = {
        ...incomingCapabilities,
        invited_email: normalizedEmail,
        invited_full_name: full_name || null,
      };
      const normalizedIncomingRole = normalizeRoleValue(role);
      const normalizedCapabilityRoles = Array.isArray(membershipCapabilities.roles)
        ? membershipCapabilities.roles
          .map((value: unknown) => SYSTEM_ROLE_ALIASES[normalizeRoleValue(value)] || normalizeRoleValue(value))
          .filter((value: string) => SYSTEM_ROLES.has(value))
        : [];
      if (normalizedCapabilityRoles.length > 0) {
        membershipCapabilities.roles = [...new Set(normalizedCapabilityRoles)];
      } else if (membershipRole) {
        membershipCapabilities.roles = [membershipRole];
      }
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
        status: nextMembershipStatus,
      };
      if (custom_role) membershipRow.custom_role = custom_role;
      if (phone) membershipRow.phone = phone;
      if (module_permissions && Object.keys(module_permissions).length > 0) membershipRow.module_permissions = module_permissions;
      if (page_permissions && Object.keys(page_permissions).length > 0) membershipRow.page_permissions = page_permissions;
      if (approval_limits && typeof approval_limits === "object") membershipRow.approval_limits = approval_limits;
      if (notification_preferences && typeof notification_preferences === "object") membershipRow.notification_preferences = notification_preferences;
      if (Object.keys(membershipCapabilities).length > 0) membershipRow.capabilities = membershipCapabilities;

      const { error: membershipErr } = await adminClient
        .from("memberships")
        .upsert(membershipRow, { onConflict: "user_id,org_id" });
      if (membershipErr) {
        console.error("[invite-user] membership upsert error:", membershipErr);
        // Keep backward compatibility with older schemas that may be missing
        // optional metadata columns, but still require the core invite row.
        const { error: fallbackMembershipErr } = await adminClient
          .from("memberships")
          .upsert(
            {
              user_id: userId,
              org_id,
              role: membershipRole,
              status: nextMembershipStatus,
            },
            { onConflict: "user_id,org_id" },
          );

        if (fallbackMembershipErr) {
          console.error("[invite-user] fallback membership upsert error:", fallbackMembershipErr);
          return new Response(JSON.stringify({
            error: "Failed to create team membership. Invite email was not sent.",
            details: fallbackMembershipErr.message,
          }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } else {
          warnings.push(`membership metadata: ${membershipErr.message}`);
        }
      }

      // ── Ensure profile row exists for invited user ────────────────────────
      const { data: existingProfile } = await adminClient
        .from("profiles")
        .select("status, onboarding_complete, first_login")
        .eq("id", userId)
        .maybeSingle();

      const nextProfileStatus = ["active", "suspended"].includes(existingProfile?.status)
        ? existingProfile.status
        : "invited";

      const { error: profileErr } = await adminClient.from("profiles").upsert({
        id: userId,
        email: normalizedEmail,
        full_name: full_name || null,
        status: nextProfileStatus,
        onboarding_type: "invited",
        onboarding_complete: existingProfile?.onboarding_complete ?? false,
        first_login: existingProfile?.first_login ?? true,
      }, { onConflict: "id" });
      
      if (profileErr) {
        console.error("[invite-user] profile upsert:", profileErr);
        return new Response(JSON.stringify({
          error: "Failed to prepare invited member profile. Invite email was not sent.",
          details: profileErr.message,
        }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const normalizedScope = await resolveEffectiveAccessScopes(adminClient, org_id, access_scopes);
      const normalizedAccessRole = SYSTEM_ROLES.has(normalizeRoleValue(access_role))
        ? normalizeRoleValue(access_role)
        : (membershipRole || "auditor");

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
    const { error: revokeExistingInvitesError } = await adminClient
      .from("invitations")
      .update({ status: "revoked", updated_at: new Date().toISOString() })
      .eq("email", normalizedEmail)
      .eq("org_id", org_id)
      .in("status", ["pending", "pending_approval"]);

    if (revokeExistingInvitesError) {
      console.error("[invite-user] revoke existing invites error:", revokeExistingInvitesError);
      return new Response(JSON.stringify({
        error: "Failed to reset previous pending invites. Invite email was not sent.",
        details: revokeExistingInvitesError.message,
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: inviteLogErr } = await adminClient.from("invitations").insert({
      email: normalizedEmail,
      org_id,
      role: membershipRole,
      token: crypto.randomUUID(),
      status: invitationStatus,
      expires_at: new Date(Date.now() + 86400000).toISOString(), // 24h
    });

    if (inviteLogErr) {
      console.error("[invite-user] invitation log err:", inviteLogErr);
      return new Response(JSON.stringify({
        error: "Failed to log team invitation. Invite email was not sent.",
        details: inviteLogErr.message,
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Send Branded Email via Resend ──────────────────────────────────────────
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      return new Response(JSON.stringify({
        error: "Email service is not configured. Invite email was not sent.",
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const roleLabel = formatRoleLabel(displayRole);
    const title = isNewUser ? "Complete your account setup" : "You've been added to a new organization";
    const bodyText = isNewUser
      ? `You've been invited to join <strong>${orgName}</strong> as <strong>${roleLabel}</strong>. Please create your account to get started.`
      : `Your existing ${BRAND_NAME} account has been given access to <strong>${orgName}</strong> as <strong>${roleLabel}</strong>.`;
    const ctaText = isNewUser ? "Create Account" : "Sign In";

    const html = `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>${BRAND_NAME}</title>
        </head>
        <body style="margin:0;padding:40px 16px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
          <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
            <div style="padding:26px 36px;background:#071326;">
              <div style="display:flex;align-items:center;gap:10px;">
                <img src="${LOGO_URL}" alt="${BRAND_NAME}" style="width:196px;height:auto;display:block;background:#ffffff;border-radius:8px;padding:8px 10px;" />
              </div>
            </div>
            <div style="padding:32px 36px;color:#475569;font-size:15px;line-height:1.6;">
              <h2 style="margin:0 0 12px;color:#0f172a;font-size:24px;">${title}</h2>
              <p style="margin:0 0 16px;">Hi ${full_name || "there"},</p>
              <p style="margin:0 0 20px;">${bodyText}</p>
              <a href="${inviteLink}" style="display:inline-block;background:#1a2744;color:#ffffff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:16px;">${ctaText}</a>
            </div>
            <div style="border-top:1px solid #e2e8f0;background:#f8fafc;padding:18px 36px;text-align:center;color:#94a3b8;font-size:12px;">${BRAND_NAME} · ${SUPPORT_EMAIL}</div>
          </div>
        </body>
      </html>`;

    try {
      const emailResponse = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${BRAND_NAME} <${SUPPORT_EMAIL}>`,
          to: normalizedEmail,
          subject: title,
          html,
        }),
      });
      const emailPayload = await emailResponse.json().catch(() => ({}));
      if (!emailResponse.ok) {
        const providerMessage = emailPayload?.message || emailPayload?.error || "Resend rejected the invite email";
        console.error("[invite-user] Resend error:", providerMessage);
        return new Response(JSON.stringify({
          error: "Invite email failed to send.",
          details: providerMessage,
        }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } catch (e: any) {
      console.error("[invite-user] email send err:", e.message);
      return new Response(JSON.stringify({
        error: "Invite email failed to send.",
        details: e.message,
      }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
