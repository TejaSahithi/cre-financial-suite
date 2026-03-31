// @ts-nocheck
/**
 * submit-contact — Supabase Edge Function
 *
 * Handles Contact Us form submissions from the public page:
 *  1. Inserts into contact_requests using service role (bypasses RLS — no auth required)
 *  2. Sends admin notification email via Resend
 *  3. Sends auto-reply confirmation to the user
 *
 * This is intentionally unauthenticated (public form) — the service role key
 * lives server-side and is never exposed to the browser.
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
    .box{background:#f1f5f9;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #3b82f6}
    .box p{margin:4px 0;color:#334155}
    .cta{display:inline-block;background:#1a2744;color:#fff!important;padding:13px 26px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;margin:8px 0 20px}
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
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const FRONTEND_URL = Deno.env.get("FRONTEND_URL") || "http://localhost:5173";
    const ADMIN_EMAIL = "support@cresuite.org";
    const FROM = "CRE Platform <support@cresuite.org>";

    const { full_name, email, phone, company_name, department, message } = await req.json();

    // Basic validation
    if (!full_name || !email || !message) {
      return new Response(JSON.stringify({ error: "Missing required fields: full_name, email, message" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 1. Save to contact_requests using service role (bypasses RLS) ──────────
    if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error: dbErr } = await admin.from("contact_requests").insert({
        full_name,
        email,
        phone: phone || null,
        company_name: company_name || null,
        department: department || null,
        message,
        status: "pending_approval",
        created_at: new Date().toISOString(),
      });
      if (dbErr) {
        console.error("[submit-contact] DB insert error:", dbErr.message);
        // Continue — still send email even if DB write fails (don't fail the user)
      } else {
        console.log("[submit-contact] Saved contact request for:", email);
      }
    } else {
      console.warn("[submit-contact] Supabase env vars missing — skipping DB insert");
    }

    if (!RESEND_API_KEY) {
      console.warn("[submit-contact] RESEND_API_KEY not set — skipping emails");
      return new Response(JSON.stringify({ success: true, warning: "Emails not sent — RESEND_API_KEY missing" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const deptLabel = department === "sales" ? "Sales" : department === "support" ? "Technical Support" : department || "General";

    // ── 2. Admin notification email ───────────────────────────────────────────
    const adminHtml = emailWrapper(`
      <h1>📬 New Contact Form Submission</h1>
      <p>A new message was received via the CRE Platform contact form.</p>
      <div class="box">
        <p><strong>Name:</strong> ${full_name}</p>
        <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
        ${phone ? `<p><strong>Phone:</strong> ${phone}</p>` : ""}
        ${company_name ? `<p><strong>Company:</strong> ${company_name}</p>` : ""}
        <p><strong>Department:</strong> ${deptLabel}</p>
      </div>
      <p><strong>Message:</strong></p>
      <div class="box" style="border-left-color:#10b981">
        <p style="white-space:pre-wrap">${message.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
      </div>
      <a href="${FRONTEND_URL}/SuperAdmin" class="cta">View in SuperAdmin →</a>
    `);

    let toEmails = [ADMIN_EMAIL];
    if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: adminMembers } = await admin.from("memberships").select("profiles(email)").eq("role", "super_admin");
      const fetchedEmails = adminMembers?.map((m: any) => m.profiles?.email).filter(Boolean) || [];
      if (fetchedEmails.length > 0) toEmails = fetchedEmails;
    }

    const adminRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: toEmails,
        subject: `[${deptLabel}] Contact from ${full_name}${company_name ? ` @ ${company_name}` : ""}`,
        html: adminHtml,
      }),
    });
    if (!adminRes.ok) console.error("[submit-contact] Admin email failed:", await adminRes.text());
    else console.log("[submit-contact] Admin notification sent");

    // ── 3. Auto-reply to user ────────────────────────────────────────────────
    const userHtml = emailWrapper(`
      <h1>Thanks for reaching out, ${full_name.split(" ")[0]}!</h1>
      <p>We've received your message and our team will get back to you shortly.</p>
      <div class="box">
        <p><strong>Request Type:</strong> ${deptLabel}</p>
        <p><strong>Reference:</strong> ${Date.now().toString(36).toUpperCase()}</p>
        <p><strong>Response time:</strong> Within 4 business hours</p>
      </div>
      <p>In the meantime, you can explore our platform capabilities or learn more about CRE Platform.</p>
      <a href="${FRONTEND_URL}/RequestAccess" class="cta">Request Platform Access →</a>
      <p style="color:#94a3b8;font-size:13px;margin-top:24px">If your inquiry is urgent, reply directly to this email or call us at +1 (800) 555-0199.</p>
    `);

    const userRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        subject: "We received your message — CRE Platform",
        html: userHtml,
      }),
    });
    if (!userRes.ok) console.error("[submit-contact] User auto-reply failed:", await userRes.text());
    else console.log("[submit-contact] Auto-reply sent to:", email);

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("[submit-contact] Unhandled error:", err.message);
    return new Response(JSON.stringify({ error: err.message || "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
