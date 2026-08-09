// @ts-nocheck
/**
 * send-sms — Supabase Edge Function
 *
 * Sends mandatory notification SMS messages through Twilio. Provider secrets
 * stay server-side as Supabase Edge Function secrets.
 */

import { corsHeaders } from "../_shared/cors.ts";

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const TWILIO_FROM_NUMBER = Deno.env.get("TWILIO_FROM_NUMBER") || "";
const TWILIO_MESSAGING_SERVICE_SID = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID") || "";

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
    const to = normalizePhone(body?.to);
    const message = normalizeMessage(body?.message);

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
