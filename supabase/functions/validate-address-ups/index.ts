// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("FRONTEND_URL") || "http://localhost:5173",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UPS_BASE_URL = Deno.env.get("UPS_BASE_URL") || "https://onlinetools.ups.com";
const UPS_CLIENT_ID = Deno.env.get("UPS_CLIENT_ID");
const UPS_CLIENT_SECRET = Deno.env.get("UPS_CLIENT_SECRET");

function normalizeText(value: string | undefined | null) {
  return (value || "").toString().trim();
}

function formatCandidate(candidate: any) {
  const addressLine1 = normalizeText(candidate.addressLine1);
  const city = normalizeText(candidate.city);
  const state = normalizeText(candidate.state);
  const postalCode = normalizeText(candidate.postalCode);
  const countryCode = normalizeText(candidate.countryCode || "US").toUpperCase();

  const formattedAddress = [
    addressLine1,
    [city, state].filter(Boolean).join(", "),
    [postalCode, countryCode].filter(Boolean).join(" "),
  ].filter(Boolean).join(", ");

  return {
    addressLine1,
    city,
    state,
    postalCode,
    countryCode,
    formattedAddress,
  };
}

function fallbackResponse(input: any, source = "fallback", message = "UPS validation is not configured yet. Please confirm the normalized billing address below.") {
  const candidate = formatCandidate({
    addressLine1: input.addressLine1,
    city: input.city,
    state: input.state,
    postalCode: input.postalCode,
    countryCode: input.countryCode,
  });

  return {
    success: true,
    valid: Boolean(candidate.addressLine1 && candidate.city && candidate.state && candidate.postalCode),
    source,
    message,
    candidates: candidate.addressLine1 ? [candidate] : [],
  };
}

function parseUpsCandidate(node: any) {
  const address = node?.AddressKeyFormat || node?.addressKeyFormat || node || {};
  return formatCandidate({
    addressLine1: Array.isArray(address.AddressLine)
      ? address.AddressLine.filter(Boolean).join(", ")
      : normalizeText(address.AddressLine),
    city: address.PoliticalDivision2 || address.city,
    state: address.PoliticalDivision1 || address.state,
    postalCode: address.PostcodePrimaryLow || address.postalCode,
    countryCode: address.CountryCode || address.countryCode,
  });
}

async function getUpsAccessToken() {
  const auth = btoa(`${UPS_CLIENT_ID}:${UPS_CLIENT_SECRET}`);
  const response = await fetch(`${UPS_BASE_URL}/security/v1/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "x-merchant-id": UPS_CLIENT_ID || "",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`UPS token request failed: ${errorText}`);
  }

  const data = await response.json();
  if (!data?.access_token) {
    throw new Error("UPS token response did not include access_token");
  }

  return data.access_token;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } }
    );

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const input = {
      addressLine1: normalizeText(body?.addressLine1),
      city: normalizeText(body?.city),
      state: normalizeText(body?.state).toUpperCase(),
      postalCode: normalizeText(body?.postalCode),
      countryCode: normalizeText(body?.countryCode || "US").toUpperCase(),
    };

    if (!input.addressLine1 || !input.city || !input.state || !input.postalCode) {
      return new Response(JSON.stringify({
        error: "addressLine1, city, state, and postalCode are required",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!UPS_CLIENT_ID || !UPS_CLIENT_SECRET) {
      return new Response(JSON.stringify(fallbackResponse(input)), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    try {
      const accessToken = await getUpsAccessToken();
      const response = await fetch(`${UPS_BASE_URL}/api/addressvalidation/v2/3?regionalrequestindicator=false&maximumcandidatelistsize=10`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          transId: crypto.randomUUID(),
          transactionSrc: "CRE Platform",
        },
        body: JSON.stringify({
          XAVRequest: {
            AddressKeyFormat: {
              AddressLine: [input.addressLine1],
              PoliticalDivision2: input.city,
              PoliticalDivision1: input.state,
              PostcodePrimaryLow: input.postalCode,
              CountryCode: input.countryCode,
            },
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`UPS address validation failed: ${errorText}`);
      }

      const data = await response.json();
      const rawCandidates = data?.XAVResponse?.Candidate
        || data?.XAVResponse?.CandidateList
        || data?.candidate
        || [];
      const candidates = (Array.isArray(rawCandidates) ? rawCandidates : [rawCandidates])
        .map(parseUpsCandidate)
        .filter((candidate: any) => candidate.addressLine1);

      if (candidates.length === 0) {
        return new Response(JSON.stringify({
          success: true,
          valid: false,
          source: "ups",
          message: "UPS could not find a suggested billing address for those details. Please review the fields and try again.",
          candidates: [],
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        success: true,
        valid: true,
        source: "ups",
        message: candidates.length === 1
          ? "Billing address verified with UPS."
          : "Select the UPS-validated billing address to continue.",
        candidates,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (upsError: any) {
      console.error("[validate-address-ups] UPS request failed:", upsError.message);
      return new Response(JSON.stringify(
        fallbackResponse(
          input,
          "fallback",
          "UPS validation is temporarily unavailable. Please confirm the normalized billing address below before submitting."
        )
      ), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } catch (err: any) {
    console.error("[validate-address-ups] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message || "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
