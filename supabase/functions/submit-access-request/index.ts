// @ts-nocheck
/**
 * submit-access-request — public access-request intake
 *
 * Saves the request with the service role, then sends:
 *  - notification email to current super admins
 *  - confirmation email to the requester
 *
 * Email delivery is non-fatal: the request is still saved, and warnings are
 * returned for the UI/logs.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

const BRAND_NAME = "ProForma OS";
const SUPPORT_EMAIL = "support@proformaos.ai";
const SALES_EMAIL = "sales@proformaos.ai";
const DEFAULT_FRONTEND_URL = "https://www.proformaos.ai";

const getCorsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});

function resolveFrontendUrl(value?: string | null) {
  let url = String(value || "").trim().replace(/\/+$/, "");
  if (!url || /(vercel\.app|localhost)/i.test(url)) return DEFAULT_FRONTEND_URL;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

function escapeHtml(value: unknown) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value: unknown, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function emailWrapper(content: string, appBaseUrl: string) {
  const logoUrl = `${appBaseUrl}/assets/proforma-os-logo.png`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;background:#f8fafc}
    .wrap{max-width:600px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0}
    .hdr{background:#071326;padding:26px 36px}
    .logo-img{width:196px;height:auto;display:block;background:#fff;border-radius:8px;padding:8px 10px}
    .body{padding:32px 36px;color:#475569;font-size:15px;line-height:1.6}
    h1{font-size:22px;font-weight:700;color:#0f172a;margin:0 0 12px}
    p{margin:0 0 14px}
    .box{background:#f1f5f9;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #2563eb}
    .box p{margin:4px 0;color:#334155}
    .cta{display:inline-block;background:#1a2744;color:#fff!important;padding:13px 22px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;margin:10px 0 18px}
    .ftr{background:#f8fafc;padding:18px 36px;text-align:center;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr"><img class="logo-img" src="${logoUrl}" alt="${BRAND_NAME}" /></div>
    <div class="body">${content}</div>
    <div class="ftr">${BRAND_NAME} &middot; ${SUPPORT_EMAIL}</div>
  </div>
</body>
</html>`;
}

function jsonResponse(payload: Record<string, unknown>, headers: Record<string, string>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function createAdminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return null;
  return createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function resolveSuperAdminEmails(admin: any) {
  const fallback = [SALES_EMAIL, SUPPORT_EMAIL];
  if (!admin) return fallback;

  const { data: memberships, error: membershipError } = await admin
    .from("memberships")
    .select("user_id,status")
    .eq("role", "super_admin");

  if (membershipError) {
    console.error("[submit-access-request] super admin membership lookup failed:", membershipError.message);
    return fallback;
  }

  const userIds = [...new Set((memberships || [])
    .filter((row: any) => ["active", "owner", "approved"].includes(String(row.status || "active").toLowerCase()))
    .map((row: any) => row.user_id)
    .filter(Boolean))];

  if (userIds.length === 0) return fallback;

  const { data: profiles, error: profileError } = await admin
    .from("profiles")
    .select("email")
    .in("id", userIds);

  if (profileError) {
    console.error("[submit-access-request] super admin profile lookup failed:", profileError.message);
    return fallback;
  }

  const emails = [...new Set((profiles || []).map((profile: any) => normalizeEmail(profile.email)).filter(Boolean))];
  return emails.length > 0 ? emails : fallback;
}

async function sendEmail({ resendKey, from, to, subject, html }: any) {
  if (!resendKey) {
    return { ok: false, warning: "RESEND_API_KEY is not configured." };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    return { ok: false, warning: `Email send failed (${response.status}): ${errorText || response.statusText}` };
  }

  const payload = await response.json().catch(() => ({}));
  return { ok: true, id: payload?.id || null };
}

function extractMissingColumn(error: any) {
  const message = String(error?.message || error?.details || "");
  const match = message.match(/Could not find the '([^']+)' column/i);
  return match?.[1] || "";
}

async function insertAccessRequest(admin: any, payload: Record<string, unknown>, warnings: string[]) {
  const optionalColumns = new Set([
    "phone",
    "role",
    "portfolios",
    "properties_count",
    "plan",
    "billing_cycle",
    "request_type",
    "updated_at",
  ]);
  const workingPayload = { ...payload };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, error } = await admin
      .from("access_requests")
      .insert(workingPayload)
      .select()
      .single();

    if (!error) return { data, error: null };

    const missingColumn = extractMissingColumn(error);
    if (missingColumn && optionalColumns.has(missingColumn) && missingColumn in workingPayload) {
      delete workingPayload[missingColumn];
      warnings.push(`Skipped optional access_requests.${missingColumn}; column is missing in the deployed schema cache.`);
      continue;
    }

    return { data: null, error };
  }

  return {
    data: null,
    error: new Error("Could not submit access request after reconciling optional schema columns."),
  };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, corsHeaders, 405);

  const warnings: string[] = [];

  try {
    const body = await req.json();
    const email = normalizeEmail(body.email);
    const fullName = normalizeText(body.full_name, 160);
    const companyName = normalizeText(body.company_name, 200);
    const phone = normalizeText(body.phone, 40);
    const role = normalizeText(body.role, 120);
    const portfolios = normalizeText(body.portfolios, 80);
    const propertiesCount = normalizeText(body.properties_count || body.property_count, 80);
    const plan = normalizeText(body.plan, 80);
    const billingCycle = normalizeText(body.billing_cycle, 40) || "monthly";
    const notes = normalizeText(body.notes, 1000);

    if (!fullName || !email || !companyName) {
      return jsonResponse({ error: "Missing required fields: full_name, email, company_name" }, corsHeaders, 400);
    }

    const admin = createAdminClient();
    if (!admin) {
      return jsonResponse({ error: "Server is missing Supabase service configuration" }, corsHeaders, 500);
    }

    const requestPayload = {
      full_name: fullName,
      email,
      phone: phone || null,
      company_name: companyName,
      role: role || null,
      portfolios: portfolios || null,
      properties_count: propertiesCount || null,
      plan: plan || null,
      billing_cycle: billingCycle,
      request_type: "access",
      status: "pending_approval",
      updated_at: new Date().toISOString(),
    };

    let accessRequest: any = null;
    let duplicate = false;
    const { data: inserted, error: insertError } = await insertAccessRequest(admin, requestPayload, warnings);

    if (insertError) {
      if (insertError.code === "23505") {
        duplicate = true;
        const { data: existing, error: existingError } = await admin
          .from("access_requests")
          .select("*")
          .eq("email", email)
          .maybeSingle();

        if (existingError) {
          console.error("[submit-access-request] duplicate lookup failed:", existingError.message);
          warnings.push("Request already existed, but existing request lookup failed.");
        }
        accessRequest = existing || requestPayload;
      } else {
        console.error("[submit-access-request] DB insert failed:", insertError.message);
        return jsonResponse({ error: insertError.message || "Failed to submit access request" }, corsHeaders, 500);
      }
    } else {
      accessRequest = inserted;
    }

    const resendKey = Deno.env.get("RESEND_API_KEY") || "";
    const frontendUrl = resolveFrontendUrl(Deno.env.get("FRONTEND_URL") || Deno.env.get("SITE_URL"));
    const from = `${BRAND_NAME} <${SUPPORT_EMAIL}>`;
    const adminEmails = await resolveSuperAdminEmails(admin);
    const firstName = escapeHtml(fullName.split(/\s+/)[0] || fullName);
    const safeCompany = escapeHtml(companyName);
    const safeFullName = escapeHtml(fullName);
    const safeEmail = escapeHtml(email);
    const safeRole = escapeHtml(role || "N/A");
    const safePhone = escapeHtml(phone || "N/A");
    const safePlan = escapeHtml(plan || "N/A");
    const safePortfolios = escapeHtml(portfolios || "N/A");
    const safeProperties = escapeHtml(propertiesCount || "N/A");
    const safeNotes = escapeHtml(notes || "");

    const adminHtml = emailWrapper(`
      <h1>New Platform Access Request</h1>
      <p>${safeFullName} submitted a request for platform access.</p>
      <div class="box">
        <p><strong>Name:</strong> ${safeFullName}</p>
        <p><strong>Email:</strong> <a href="mailto:${safeEmail}">${safeEmail}</a></p>
        <p><strong>Phone:</strong> ${safePhone}</p>
        <p><strong>Company:</strong> ${safeCompany}</p>
        <p><strong>Role:</strong> ${safeRole}</p>
        <p><strong>Portfolios:</strong> ${safePortfolios}</p>
        <p><strong>Properties:</strong> ${safeProperties}</p>
        <p><strong>Plan:</strong> ${safePlan}</p>
        ${safeNotes ? `<p><strong>Notes:</strong> ${safeNotes}</p>` : ""}
      </div>
      <a class="cta" href="${frontendUrl}/SuperAdmin">Review in SuperAdmin</a>
    `, frontendUrl);

    const adminEmailResult = await sendEmail({
      resendKey,
      from,
      to: adminEmails,
      subject: `[Access Request] ${fullName} @ ${companyName}`,
      html: adminHtml,
    });
    if (!adminEmailResult.ok) {
      console.error("[submit-access-request] admin email failed:", adminEmailResult.warning);
      warnings.push(`Admin email not sent: ${adminEmailResult.warning}`);
    }

    const userHtml = emailWrapper(`
      <h1>Access Request Submitted</h1>
      <p>Hi ${firstName},</p>
      <p>We received your request for access to ${BRAND_NAME}.</p>
      <div class="box">
        <p><strong>Company:</strong> ${safeCompany}</p>
        <p><strong>Status:</strong> Pending review</p>
        <p><strong>What happens next:</strong> A super admin will review the request and send you an approval email when access is ready.</p>
      </div>
      <p>You do not need to submit another request. If anything changes, reply to this email and our team can help.</p>
    `, frontendUrl);

    const userEmailResult = await sendEmail({
      resendKey,
      from,
      to: email,
      subject: `We received your ${BRAND_NAME} access request`,
      html: userHtml,
    });
    if (!userEmailResult.ok) {
      console.error("[submit-access-request] user email failed:", userEmailResult.warning);
      warnings.push(`Requester email not sent: ${userEmailResult.warning}`);
    }

    return jsonResponse({
      success: true,
      request: accessRequest,
      duplicate,
      warnings,
      warning: warnings.join(" "),
      email_status: {
        admin: adminEmailResult.ok ? "sent" : "failed",
        requester: userEmailResult.ok ? "sent" : "failed",
      },
    }, corsHeaders);
  } catch (error) {
    console.error("[submit-access-request] Unhandled error:", error?.message || error);
    return jsonResponse({ error: error?.message || "Internal server error" }, corsHeaders, 500);
  }
});
