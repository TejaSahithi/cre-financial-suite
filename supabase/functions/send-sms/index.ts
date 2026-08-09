// @ts-nocheck
/**
 * send-sms — Supabase Edge Function
 *
 * Sends mandatory notification SMS messages through Twilio. Provider secrets
 * stay server-side as Supabase Edge Function secrets.
 */

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const TWILIO_FROM_NUMBER = Deno.env.get("TWILIO_FROM_NUMBER") || "";
const TWILIO_MESSAGING_SERVICE_SID = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePhone(value: unknown) {
  const phone = String(value || "").trim();
  if (!phone) return "";
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return "";
  return phone;
}

function normalizeMessage(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1600);
}

function normalizeId(value: unknown) {
  const text = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text) ? text : "";
}

function isActiveMembershipStatus(value: unknown) {
  const status = String(value || "active").toLowerCase();
  return ["active", "owner", "approved"].includes(status);
}

function createAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function getAuthenticatedUser(req: Request, supabaseAdmin: any) {
  const authorization = req.headers.get("Authorization") || "";
  const token = authorization.replace(/^[Bb]earer\s+/, "");
  if (!token || !supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error) {
    console.error("[send-sms] auth lookup failed:", error.message);
    return null;
  }
  return data?.user || null;
}

async function resolveInternalRecipientPhone({ supabaseAdmin, user, orgId, recipientUserId }: any) {
  const normalizedOrgId = normalizeId(orgId);
  const normalizedRecipientUserId = normalizeId(recipientUserId);

  if (!supabaseAdmin || !user?.id || !normalizedOrgId || !normalizedRecipientUserId) {
    return { phone: "", error: "Missing notification recipient resolution context" };
  }

  const { data: callerMembership, error: callerError } = await supabaseAdmin
    .from("memberships")
    .select("user_id, org_id, role, status")
    .eq("org_id", normalizedOrgId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (callerError) {
    console.error("[send-sms] caller membership lookup failed:", callerError.message);
    return { phone: "", error: "Could not verify notification sender access" };
  }

  if (!callerMembership || !isActiveMembershipStatus(callerMembership.status)) {
    return { phone: "", error: "Notification sender is not active in this organization" };
  }

  const { data: targetMembership, error: targetError } = await supabaseAdmin
    .from("memberships")
    .select("user_id, org_id, status, phone")
    .eq("org_id", normalizedOrgId)
    .eq("user_id", normalizedRecipientUserId)
    .maybeSingle();

  if (targetError) {
    console.error("[send-sms] recipient membership lookup failed:", targetError.message);
    return { phone: "", error: "Could not verify notification recipient access" };
  }

  if (!targetMembership || !isActiveMembershipStatus(targetMembership.status)) {
    return { phone: "", error: "Notification recipient is not active in this organization" };
  }

  const membershipPhone = normalizePhone(targetMembership.phone);
  if (membershipPhone) return { phone: membershipPhone, error: "" };

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("phone")
    .eq("id", normalizedRecipientUserId)
    .maybeSingle();

  if (profileError) {
    console.error("[send-sms] recipient profile lookup failed:", profileError.message);
    return { phone: "", error: "Could not resolve notification recipient profile" };
  }

  const profilePhone = normalizePhone(profile?.phone);
  return {
    phone: profilePhone,
    error: profilePhone ? "" : "Notification recipient has no valid E.164 phone number",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: true, message: "Method not allowed" }, 405);
  }

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || (!TWILIO_FROM_NUMBER && !TWILIO_MESSAGING_SERVICE_SID)) {
    console.error("[send-sms] Twilio provider is not configured");
    return jsonResponse({
      error: true,
      message: "SMS provider is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID.",
    }, 503);
  }

  try {
    const body = await req.json();
    const supabaseAdmin = createAdminClient();
    const user = await getAuthenticatedUser(req, supabaseAdmin);
    let to = normalizePhone(body?.to);
    const message = normalizeMessage(body?.message);

    if (!to) {
      const resolvedRecipient = await resolveInternalRecipientPhone({
        supabaseAdmin,
        user,
        orgId: body?.orgId || body?.metadata?.org_id,
        recipientUserId: body?.recipientUserId || body?.metadata?.recipient_user_id,
      });

      if (resolvedRecipient.error) {
        console.error("[send-sms] recipient resolution failed:", resolvedRecipient.error);
      }

      to = resolvedRecipient.phone;
    }

    if (!to) {
      return jsonResponse({ error: true, message: "Missing or invalid E.164 phone number in field: to" }, 400);
    }

    if (!message) {
      return jsonResponse({ error: true, message: "Missing required field: message" }, 400);
    }

    const form = new URLSearchParams();
    form.set("To", to);
    form.set("Body", message);

    if (TWILIO_MESSAGING_SERVICE_SID) {
      form.set("MessagingServiceSid", TWILIO_MESSAGING_SERVICE_SID);
    } else {
      form.set("From", TWILIO_FROM_NUMBER);
    }

    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("[send-sms] Twilio API error:", result);
      return jsonResponse({
        error: true,
        message: result?.message || "Failed to send SMS",
        provider_status: result?.status || response.status,
      }, 502);
    }

    console.log("[send-sms] SMS sent", {
      sid: result?.sid,
      status: result?.status,
      notification_id: body?.metadata?.notification_id || null,
      event_type: body?.metadata?.event_type || null,
    });

    return jsonResponse({
      success: true,
      id: result?.sid || null,
      message_id: result?.sid || null,
      status: result?.status || "queued",
    });
  } catch (error) {
    console.error("[send-sms] Error:", error?.message || error);
    return jsonResponse({ error: true, message: "Internal server error" }, 500);
  }
});
