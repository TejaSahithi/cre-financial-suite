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
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1a2744" stroke-width="2.5">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <polyline points="9 22 9 12 15 12 15 22"/>
          </svg>
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
    const FRONTEND_URL = Deno.env.get("FRONTEND_URL") || "http://localhost:5173";
    // After confirmation, land on a protected page so MFAGuard triggers enrollment
    const POST_CONFIRM_URL = `${FRONTEND_URL}/Onboarding`;
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

    if (!email) {
      return new Response(JSON.stringify({ error: "email is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── RESEND flow ──────────────────────────────────────────────────────────
    if (action === "resend") {
      if (RESEND_API_KEY) {
        const link = await getAnyAuthLink(admin, email, POST_CONFIRM_URL);
        if (link) {
          await sendConfirmEmail(RESEND_API_KEY, FROM, email, full_name || email.split("@")[0], link);
          console.log("[signup] Resend confirmation sent via Resend to:", email);
        } else {
          console.error("[signup] Could not generate any auth link for resend:", email);
        }
      }
      return new Response(JSON.stringify({ success: true, confirmationRequired: true }), {
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
    const { data: existingUsers } = await admin.auth.admin.listUsers();
    const existing = existingUsers?.users?.find((u: any) => u.email === email);
    if (existing) {
      if (!existing.email_confirmed_at) {
        // Exists but unconfirmed — resend confirmation
        if (RESEND_API_KEY) {
          const link = await getAnyAuthLink(admin, email, POST_CONFIRM_URL);
          if (link) {
            await sendConfirmEmail(RESEND_API_KEY, FROM, email, full_name || email.split("@")[0], link);
            console.log("[signup] Resent confirmation for existing unconfirmed user:", email);
          }
        }
        return new Response(JSON.stringify({ success: true, confirmationRequired: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "An account with this email already exists." }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create user — email_confirm: false suppresses Supabase's built-in email
    const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
      user_metadata: {
        full_name: full_name || "",
        onboarding_type: onboarding_type || "owner",
      },
    });

    if (createErr) {
      console.error("[signup] createUser error:", createErr.message);
      return new Response(JSON.stringify({ error: createErr.message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("[signup] Created user:", email, "id:", newUser?.user?.id);

    // Generate confirmation link and send via Resend
    if (RESEND_API_KEY) {
      const link = await getAnyAuthLink(admin, email, POST_CONFIRM_URL);
      if (link) {
        await sendConfirmEmail(RESEND_API_KEY, FROM, email, full_name || email.split("@")[0], link);
        console.log("[signup] Confirmation email sent via Resend to:", email);
      } else {
        console.error("[signup] Failed to generate auth link for new user:", email);
      }
    } else {
      console.warn("[signup] RESEND_API_KEY not set — no confirmation email sent");
    }

    return new Response(JSON.stringify({ success: true, confirmationRequired: true }), {
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

/**
 * Try to get a clickable auth link for email confirmation.
 * 1st: generateLink type=signup (standard confirmation)
 * 2nd: generateLink type=magiclink (direct login, also confirms email)
 */
async function getAnyAuthLink(admin: any, email: string, frontendUrl: string): Promise<string | null> {
  // Try signup confirmation link first
  try {
    const { data, error } = await admin.auth.admin.generateLink({
      type: "signup",
      email,
      options: { redirectTo: frontendUrl },
    });
    const link = data?.properties?.action_link;
    if (link) {
      console.log("[signup] Got signup confirmation link for:", email);
      return link;
    }
    console.warn("[signup] signup link failed:", error?.message, "— trying magic link");
  } catch (e: any) {
    console.warn("[signup] signup link threw:", e.message, "— trying magic link");
  }

  // Fallback: magic link (logs user in directly, also confirms email)
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
    console.error("[signup] magic link also failed:", error?.message);
  } catch (e: any) {
    console.error("[signup] magic link threw:", e.message);
  }

  return null;
}

async function sendConfirmEmail(
  resendKey: string,
  from: string,
  email: string,
  firstName: string,
  confirmLink: string,
) {
  const html = emailWrapper(`
    <h1>Confirm your email address</h1>
    <p>Hi ${firstName},</p>
    <p>Thanks for signing up for CRE Platform! Click the button below to confirm your email and activate your account.</p>
    <a href="${confirmLink}" class="cta">Confirm Email Address →</a>
    <p class="note">This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.</p>
  `);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Confirm your CRE Platform account",
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("[signup] Resend error:", body);
  }
}
