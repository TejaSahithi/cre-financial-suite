// @ts-nocheck
/**
 * signup — Supabase Edge Function
 *
 * Replaces the direct supabase.auth.signUp() call in the frontend so that
 * confirmation emails are sent via Resend instead of Supabase's rate-limited
 * built-in email service (free tier: 2 emails / hour).
 *
 * POST body (new account):
 *   { email, password, full_name, onboarding_type? }
 *
 * POST body (resend confirmation):
 *   { email, action: "resend" }
 *
 * Response: { success: true, confirmationRequired: boolean }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

const getCorsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});

const emailWrapper = (content: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;background:#f8fafc}
    .wrap{max-width:600px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0}
    .hdr{background:linear-gradient(135deg,#1a2744 0%,#2d4a8a 100%);padding:28px 36px}
    .logo{display:flex;align-items:center;gap:10px}
    .logo-icon{width:34px;height:34px;background:#fff;border-radius:8px;display:flex;align-items:center;justify-content:center}
    .logo-text{color:#fff;font-size:17px;font-weight:700;letter-spacing:-.3px}
    .body{padding:32px 36px}
    h1{font-size:22px;font-weight:700;color:#0f172a;margin:0 0 8px}
    p{color:#475569;font-size:15px;line-height:1.6;margin:0 0 14px}
    .cta{display:inline-block;background:#1a2744;color:#fff!important;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;margin:8px 0 20px}
    .note{background:#f1f5f9;border-radius:10px;padding:14px 18px;font-size:13px;color:#64748b}
    .ftr{background:#f8fafc;padding:18px 36px;text-align:center;border-top:1px solid #e2e8f0}
    .ftr p{color:#94a3b8;font-size:11px;margin:0}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr">
      <div class="logo">
        <div class="logo-icon">
          <span style="font-size:13px;font-weight:800;color:#1a2744;letter-spacing:-0.04em;">CP</span>
        </div>
        <span class="logo-text">CRE Platform</span>
      </div>
    </div>
    <div class="body">${content}</div>
    <div class="ftr"><p>CRE Platform &middot; support@cresuite.org &middot; &copy; 2025 All rights reserved</p></div>
  </div>
</body>
</html>`;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const FRONTEND_URL = Deno.env.get("FRONTEND_URL") || Deno.env.get("SITE_URL") || "https://cre-financial-suite-main.vercel.app";
    // After confirmation, land on a protected page so MFAGuard triggers enrollment
    const POST_CONFIRM_URL = `${FRONTEND_URL}/Onboarding`;
    const INVITE_ACCEPT_URL = `${FRONTEND_URL}/AcceptInvite`;
    const FROM = "CRE Platform <support@cresuite.org>";

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return new Response(JSON.stringify({ error: "Server misconfigured" }), {
        status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = await req.json();
    const { email, password, full_name, onboarding_type, action } = body;
    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (!normalizedEmail) {
      return new Response(JSON.stringify({ error: "email is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── FORGOT PASSWORD flow ─────────────────────────────────────────────────
    if (action === "forgot_password") {
      const resetUrl = `${FRONTEND_URL}/ResetPassword`;
      try {
        const { data, error } = await admin.auth.admin.generateLink({
          type: "recovery",
          email: normalizedEmail,
          options: { redirectTo: resetUrl },
        });
        const link = data?.properties?.action_link;
        if (!link) {
          console.error("[signup] recovery link generation failed:", error?.message);
          return new Response(JSON.stringify({ error: "Could not generate reset link. Make sure this email has an account." }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        if (RESEND_API_KEY) {
          const firstName = (full_name || normalizedEmail.split("@")[0]);
          const html = emailWrapper(`
            <h1>Reset your password</h1>
            <p>Hi ${firstName},</p>
            <p>We received a request to reset your CRE Platform password. Click the button below to choose a new password.</p>
            <a href="${link}" class="cta">Reset Password →</a>
            <p class="note">This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email — your password won't change.</p>
          `);
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: FROM, to: [normalizedEmail], subject: "Reset your CRE Platform password", html }),
          });
          if (!res.ok) console.error("[signup] Resend error (recovery):", await res.text());
          else console.log("[signup] Password reset email sent to:", normalizedEmail);
        }
      } catch (e: any) {
        console.error("[signup] forgot_password error:", e.message);
        return new Response(JSON.stringify({ error: e.message }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── RESEND flow ──────────────────────────────────────────────────────────
    if (action === "resend") {
      const flow = await detectRegistrationFlow(admin, normalizedEmail);
      if (RESEND_API_KEY) {
        const redirectUrl = flow === "invite" ? INVITE_ACCEPT_URL : POST_CONFIRM_URL;
        const link = await getAnyAuthLink(admin, normalizedEmail, redirectUrl);
        if (link) {
          await sendFlowEmail({
            resendKey: RESEND_API_KEY,
            from: FROM,
            email: normalizedEmail,
            firstName: full_name || normalizedEmail.split("@")[0],
            link,
            flow,
          });
          console.log("[signup] Resend auth email sent via Resend to:", normalizedEmail, "flow:", flow);
        } else {
          console.error("[signup] Could not generate any auth link for resend:", normalizedEmail);
        }
      }
      return new Response(JSON.stringify({ success: true, confirmationRequired: true, flow }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── SIGNUP flow ──────────────────────────────────────────────────────────
    if (!password) {
      return new Response(JSON.stringify({ error: "password is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if user already exists
    const existing = await findAuthUserByEmail(admin, normalizedEmail);
    if (existing) {
      const flow = await detectRegistrationFlow(admin, normalizedEmail, existing.id);

      if (flow === "invite") {
        if (RESEND_API_KEY) {
          const link = await getAnyAuthLink(admin, normalizedEmail, INVITE_ACCEPT_URL);
          if (link) {
            await sendFlowEmail({
              resendKey: RESEND_API_KEY,
              from: FROM,
              email: normalizedEmail,
              firstName: full_name || normalizedEmail.split("@")[0],
              link,
              flow,
            });
            console.log("[signup] Invite completion email sent for existing invited user:", normalizedEmail);
          }
        }
        return new Response(JSON.stringify({ success: true, confirmationRequired: true, flow }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!existing.email_confirmed_at) {
        // Exists but unconfirmed — resend confirmation
        if (RESEND_API_KEY) {
          const link = await getAnyAuthLink(admin, normalizedEmail, POST_CONFIRM_URL);
          if (link) {
            await sendFlowEmail({
              resendKey: RESEND_API_KEY,
              from: FROM,
              email: normalizedEmail,
              firstName: full_name || normalizedEmail.split("@")[0],
              link,
              flow: "signup",
            });
            console.log("[signup] Resent confirmation for existing unconfirmed user:", normalizedEmail);
          }
        }
        return new Response(JSON.stringify({ success: true, confirmationRequired: true, flow: "signup" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "An account with this email already exists." }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Pre-flight cleanup ───────────────────────────────────────────────
    // The handle_new_user trigger on auth.users tries to INSERT into profiles.
    // If an orphan profile row exists from a previous failed attempt, the trigger
    // crashes with "Database error checking email" and the whole signup rolls back.
    // Proactively remove any orphan profile row BEFORE creating the auth user.
    try {
      const { data: orphan } = await admin
        .from("profiles")
        .select("id, email")
        .eq("email", normalizedEmail)
        .maybeSingle();

      if (orphan) {
        console.warn("[signup] Found orphan profile for:", normalizedEmail, "id:", orphan.id);
        // Check if the auth user for this profile still exists
        const orphanAuthUser = await findAuthUserByEmail(admin, normalizedEmail);
        if (!orphanAuthUser) {
          // Profile exists but auth user doesn't — orphan. Delete it.
          await admin.from("profiles").delete().eq("email", normalizedEmail);
          console.log("[signup] Deleted orphan profile for:", normalizedEmail);
        }
      }
    } catch (cleanupErr: any) {
      console.warn("[signup] Pre-flight cleanup failed (non-fatal):", cleanupErr?.message);
    }

    // ── Create user ─────────────────────────────────────────────────────────
    // email_confirm: false suppresses Supabase's built-in email
    const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: false,
      user_metadata: {
        full_name: full_name || "",
        onboarding_type: onboarding_type || "owner",
      },
    });

    // "Database error checking email" means handle_new_user trigger still crashed.
    // Fallback: check if auth user was partially created, and manually create profile.
    if (createErr && /Database error/i.test(createErr.message || "")) {
      console.error("[signup] Trigger crashed for:", normalizedEmail, "—", createErr.message);

      // The auth user MAY have been created before the trigger rolled it back,
      // or Postgres may have fully rolled back. Check both paths.
      const partialUser = await findAuthUserByEmail(admin, normalizedEmail);

      if (partialUser) {
        // Auth user exists — trigger failed but user was created.
        // Manually ensure profile exists.
        console.log("[signup] Found partial auth user:", partialUser.id, "— creating profile manually");
        try {
          await ensureProfile(admin, partialUser.id, normalizedEmail, full_name, onboarding_type);
          const flow = await detectRegistrationFlow(admin, normalizedEmail, partialUser.id);

          // Send confirmation email
          if (RESEND_API_KEY) {
            const link = await getAnyAuthLink(admin, normalizedEmail, POST_CONFIRM_URL);
            if (link) {
              await sendFlowEmail({
                resendKey: RESEND_API_KEY, from: FROM, email: normalizedEmail,
                firstName: full_name || normalizedEmail.split("@")[0], link, flow,
              });
            }
          }

          return new Response(JSON.stringify({ success: true, confirmationRequired: !partialUser.email_confirmed_at, flow }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (profileErr: any) {
          console.error("[signup] Manual profile creation also failed:", profileErr?.message);
        }
      }

      // Full rollback — no auth user exists. Try once more: delete any remaining
      // orphan profile and re-create with email_confirm: true (sometimes avoids trigger issues).
      try {
        await admin.from("profiles").delete().eq("email", normalizedEmail);
      } catch { /* ignore */ }

      const { data: retryUser, error: retryErr } = await admin.auth.admin.createUser({
        email: normalizedEmail,
        password,
        email_confirm: true, // auto-confirm — avoids some trigger issues
        user_metadata: {
          full_name: full_name || "",
          onboarding_type: onboarding_type || "owner",
        },
      });

      if (retryErr) {
        console.error("[signup] Retry with email_confirm:true also failed:", retryErr.message);

        // Last resort: use the native signUp (not admin API) which may handle triggers differently
        try {
          const { data: nativeData, error: nativeErr } = await admin.auth.signUp({
            email: normalizedEmail,
            password,
            options: {
              emailRedirectTo: POST_CONFIRM_URL,
              data: {
                full_name: full_name || "",
                onboarding_type: onboarding_type || "owner",
              },
            },
          });

          if (nativeErr) {
            console.error("[signup] Native signUp also failed:", nativeErr.message);
            return new Response(JSON.stringify({
              error: "Account creation failed due to a database configuration issue. Please ask your admin to run the latest SQL migrations, or try again later.",
            }), {
              status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          console.log("[signup] Native signUp succeeded for:", normalizedEmail);
          return new Response(JSON.stringify({ success: true, confirmationRequired: !nativeData?.session, flow: "signup" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (nativeCrash: any) {
          console.error("[signup] Native signUp crash:", nativeCrash?.message);
          return new Response(JSON.stringify({
            error: "Account creation failed. Please ask your admin to run the latest SQL migrations (20260410_fix_handle_new_user.sql).",
          }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // Retry succeeded — ensure profile
      if (retryUser?.user?.id) {
        try {
          await ensureProfile(admin, retryUser.user.id, normalizedEmail, full_name, onboarding_type);
        } catch { /* trigger may have handled it */ }
      }

      if (RESEND_API_KEY) {
        const link = await getAnyAuthLink(admin, normalizedEmail, POST_CONFIRM_URL);
        if (link) {
          await sendFlowEmail({
            resendKey: RESEND_API_KEY, from: FROM, email: normalizedEmail,
            firstName: full_name || normalizedEmail.split("@")[0], link, flow: "signup",
          });
        }
      }

      return new Response(JSON.stringify({ success: true, confirmationRequired: true, flow: "signup" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (createErr) {
      console.error("[signup] createUser error:", createErr.message);
      return new Response(JSON.stringify({ error: createErr.message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("[signup] Created user:", normalizedEmail, "id:", newUser?.user?.id);

    // Ensure profile exists (safety net in case trigger didn't fire)
    if (newUser?.user?.id) {
      try {
        await ensureProfile(admin, newUser.user.id, normalizedEmail, full_name, onboarding_type);
      } catch (profileErr: any) {
        console.warn("[signup] ensureProfile after create:", profileErr?.message);
      }
    }

    // Generate confirmation link and send via Resend
    if (RESEND_API_KEY) {
      const link = await getAnyAuthLink(admin, normalizedEmail, POST_CONFIRM_URL);
      if (link) {
        await sendFlowEmail({
          resendKey: RESEND_API_KEY,
          from: FROM,
          email: normalizedEmail,
          firstName: full_name || normalizedEmail.split("@")[0],
          link,
          flow: "signup",
        });
        console.log("[signup] Confirmation email sent via Resend to:", normalizedEmail);
      } else {
        console.error("[signup] Failed to generate auth link for new user:", normalizedEmail);
      }
    } else {
      console.warn("[signup] RESEND_API_KEY not set — no confirmation email sent");
    }

    return new Response(JSON.stringify({ success: true, confirmationRequired: true, flow: "signup" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("[signup] Unhandled error:", err.message);
    return new Response(JSON.stringify({ error: err.message || "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getAnyAuthLink(admin: any, email: string, frontendUrl: string): Promise<string | null> {
  // Generate a magiclink because it logs the user in directly AND confirms their email
  try {
    const { data, error } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo: frontendUrl },
    });
    const link = data?.properties?.action_link;
    if (link) {
      console.log("[signup] Got magic link for:", email);
      return link;
    }
    console.error("[signup] magic link failed:", error?.message);
  } catch (e: any) {
    console.error("[signup] magic link threw:", e.message);
  }

  return null;
}

async function findAuthUserByEmail(admin: any, email: string) {
  const targetEmail = String(email || "").trim().toLowerCase();
  if (!targetEmail) return null;

  let page = 1;
  const perPage = 200;

  while (page <= 20) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) {
      console.error("[signup] listUsers error:", error.message);
      break;
    }

    const users = data?.users || [];
    const match = users.find((user: any) => String(user.email || "").trim().toLowerCase() === targetEmail);
    if (match) return match;
    if (users.length < perPage) break;
    page += 1;
  }

  return null;
}

async function detectRegistrationFlow(admin: any, email: string, userId?: string): Promise<"signup" | "invite"> {
  try {
    const queries = [
      admin
        .from("profiles")
        .select("onboarding_type")
        .ilike("email", email)
        .maybeSingle(),
      admin
        .from("invitations")
        .select("id, status")
        .ilike("email", email)
        .in("status", ["pending", "pending_approval"]),
    ];

    if (userId) {
      queries.push(
        admin
          .from("memberships")
          .select("status")
          .eq("user_id", userId)
          .eq("status", "invited")
      );
    }

    const [profileRes, inviteRes, membershipRes] = await Promise.all(queries as any);
    const profile = profileRes?.data;
    const invitations = inviteRes?.data || [];
    const memberships = membershipRes?.data || [];

    if (profile?.onboarding_type === "invited") return "invite";
    if (memberships.length > 0) return "invite";
    if (invitations.length > 0 && !userId) return "invite";
  } catch (error: any) {
    console.error("[signup] detectRegistrationFlow error:", error?.message || error);
  }

  return "signup";
}

async function sendFlowEmail({
  resendKey,
  from,
  email,
  firstName,
  link,
  flow,
}: {
  resendKey: string,
  from: string,
  email: string,
  firstName: string,
  link: string,
  flow: "signup" | "invite",
}) {
  const html = flow === "invite"
    ? emailWrapper(`
        <h1>Complete your invited account</h1>
        <p>Hi ${firstName},</p>
        <p>Your organization has already assigned your access in CRE Platform. Use the secure link below to set your password and activate your member workspace.</p>
        <a href="${link}" class="cta">Complete Account Setup →</a>
        <p class="note">This link signs you in securely so you can finish setup and review your assigned modules and pages.</p>
      `)
    : emailWrapper(`
        <h1>Confirm your email address</h1>
        <p>Hi ${firstName},</p>
        <p>Thanks for signing up for CRE Platform! Click the button below to confirm your email and activate your account.</p>
        <a href="${link}" class="cta">Confirm Email Address →</a>
        <p class="note">This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.</p>
      `);

  const subject = flow === "invite"
    ? "Complete your CRE Platform account setup"
    : "Confirm your CRE Platform account";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [email],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("[signup] Resend error:", body);
  }
}

/**
 * Ensures a profile row exists for the given auth user.
 * This is a safety net for when the handle_new_user trigger
 * fails or doesn't fire. Uses upsert to be idempotent.
 */
async function ensureProfile(
  admin: any,
  userId: string,
  email: string,
  fullName?: string,
  onboardingType?: string,
) {
  // Check authorization status
  let isAuthorized = false;
  try {
    const { data: ar } = await admin
      .from("access_requests")
      .select("id")
      .eq("email", email.toLowerCase())
      .eq("status", "approved")
      .limit(1)
      .maybeSingle();
    if (ar) isAuthorized = true;
  } catch { /* table may not exist */ }

  if (!isAuthorized) {
    try {
      const { data: inv } = await admin
        .from("invitations")
        .select("id")
        .eq("email", email.toLowerCase())
        .limit(1)
        .maybeSingle();
      if (inv) isAuthorized = true;
    } catch { /* table may not exist */ }
  }

  const resolvedType = onboardingType || "owner";
  // Owner-type signups (new org creators) are self-approving — they don't need
  // to be in access_requests. Only invited/member types need pre-approval.
  const profileStatus = (isAuthorized || resolvedType === "owner") ? "approved" : "pending_approval";

  const { error } = await admin.from("profiles").upsert(
    {
      id: userId,
      email: email.toLowerCase(),
      full_name: fullName || email.split("@")[0],
      onboarding_type: resolvedType,
      onboarding_complete: resolvedType === "invited",
      first_login: true,
      status: profileStatus,
    },
    { onConflict: "id" }
  );

  if (error) {
    // If id conflict is fine but email conflict exists, update by email
    if (error.message?.includes("unique") || error.code === "23505") {
      const { error: updateErr } = await admin
        .from("profiles")
        .update({
          id: userId,
          full_name: fullName || email.split("@")[0],
          onboarding_type: resolvedType,
          status: profileStatus,
        })
        .eq("email", email.toLowerCase());

      if (updateErr) {
        console.error("[signup] ensureProfile update fallback failed:", updateErr.message);
        throw updateErr;
      }
      return;
    }
    throw error;
  }
}
