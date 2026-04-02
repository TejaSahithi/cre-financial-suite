// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";

/**
 * extract-lease Edge Function
 *
 * Called by LeaseUpload.jsx after a PDF is uploaded.
 * Accepts { file_url, file_name } and returns structured lease fields.
 *
 * If DOCLING_API_URL is configured, it calls Docling for real OCR.
 * Otherwise it returns a scaffold with empty fields so the user can
 * fill them in manually — this prevents the CORS error the UI was seeing.
 */

// ---------------------------------------------------------------------------
// Docling call (optional — falls back to scaffold if not configured)
// ---------------------------------------------------------------------------

async function extractWithDocling(fileUrl: string, fileName: string): Promise<Record<string, unknown>> {
  const doclingUrl = Deno.env.get("DOCLING_API_URL");
  if (!doclingUrl) return null;

  try {
    // Download the file
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) return null;
    const fileBytes = new Uint8Array(await fileRes.arrayBuffer());

    const apiKey = Deno.env.get("DOCLING_API_KEY");
    const formData = new FormData();
    formData.append("file", new Blob([fileBytes], { type: "application/pdf" }), fileName);
    formData.append("output_formats", "fields");

    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(`${doclingUrl}/api/v1/convert`, { method: "POST", headers, body: formData });
    if (!res.ok) return null;

    const raw = await res.json();
    const fields: Record<string, unknown> = {};

    // Map Docling fields to lease schema
    const fieldMap: Record<string, string> = {
      tenant_name: "tenant_name", tenant: "tenant_name", lessee: "tenant_name",
      start_date: "start_date", lease_start: "start_date", commencement: "start_date",
      end_date: "end_date", lease_end: "end_date", expiration: "end_date",
      monthly_rent: "base_rent", base_rent: "base_rent", rent: "base_rent",
      annual_rent: "annual_rent",
      square_footage: "total_sf", sqft: "total_sf", area: "total_sf",
      lease_type: "lease_type",
      escalation_rate: "escalation_rate",
      escalation_type: "escalation_type",
    };

    for (const f of (raw.fields ?? [])) {
      const key = (f.key ?? "").toLowerCase().replace(/\s+/g, "_");
      const canonical = fieldMap[key] ?? key;
      fields[canonical] = f.value;
      if (!fields.confidence_scores) fields.confidence_scores = {};
      (fields.confidence_scores as Record<string, number>)[canonical] = Math.round((f.confidence ?? 0.85) * 100);
    }

    return Object.keys(fields).length > 0 ? fields : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  // Always handle OPTIONS for CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Auth is optional here — if the token is missing we still return a scaffold
    // so the UI doesn't break. We just won't have org context.
    let user: any = null;
    try {
      const result = await verifyUser(req);
      user = result.user;
    } catch {
      // unauthenticated — return scaffold
    }

    const body = await req.json().catch(() => ({}));
    const { file_url = "", file_name = "lease.pdf" } = body;

    // Try Docling extraction first
    let extracted: Record<string, unknown> | null = null;
    if (file_url && !file_url.startsWith("blob:")) {
      extracted = await extractWithDocling(file_url, file_name);
    }

    // Fall back to empty scaffold — user fills in manually
    if (!extracted) {
      extracted = {
        tenant_name: "",
        lease_type: "triple_net",
        start_date: "",
        end_date: "",
        base_rent: 0,
        rent_per_sf: 0,
        total_sf: 0,
        annual_rent: 0,
        escalation_type: "fixed",
        escalation_rate: 3,
        cam_cap_type: "none",
        cam_cap_rate: 5,
        gross_up_clause: false,
        admin_fee_allowed: true,
        admin_fee_pct: 10,
        management_fee_pct: 5,
        confidence_scores: {},
      };
    }

    return new Response(
      JSON.stringify(extracted),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (err) {
    console.error("[extract-lease] Error:", err.message);
    return new Response(
      JSON.stringify({ error: true, message: err.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
