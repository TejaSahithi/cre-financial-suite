// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { callVertexAIJSON } from "../_shared/vertex-ai.ts";

/**
 * extract-lease Edge Function
 *
 * Extracts structured lease fields from a PDF using a two-stage pipeline:
 *
 *   Stage 1 — Text extraction
 *     a) If DOCLING_API_URL is set: call Docling for structured text + tables
 *     b) Otherwise: download the PDF and extract raw text via a simple byte scan
 *        (good enough for text-based PDFs; scanned images need Docling/OCR)
 *
 *   Stage 2 — LLM extraction (Vertex AI Gemini 1.5 Pro)
 *     Send the extracted text to Gemini with a structured prompt.
 *     Gemini returns a JSON object with all lease fields + confidence scores.
 *
 *   Fallback — If Vertex AI env vars are not set, return an empty scaffold
 *     so the UI can still render the manual-entry form without errors.
 *
 * Required env vars (set via `supabase secrets set`):
 *   VERTEX_PROJECT_ID          — GCP project ID
 *   VERTEX_LOCATION            — Region (e.g. "us-central1")
 *   GOOGLE_SERVICE_ACCOUNT_KEY — Service account JSON as a single-line string
 *
 * Optional env vars:
 *   DOCLING_API_URL     — Docling service URL for better PDF text extraction
 *   DOCLING_API_KEY     — Auth token for Docling (if required)
 *
 * Request body: { file_url: string, file_name: string }
 * Response: lease fields object with confidence_scores
 */

// ---------------------------------------------------------------------------
// Lease field schema (what Gemini must return)
// ---------------------------------------------------------------------------

const LEASE_SCHEMA = `{
  "tenant_name": "string | null",
  "lease_type": "triple_net | gross | modified_gross | full_service | null",
  "start_date": "YYYY-MM-DD | null",
  "end_date": "YYYY-MM-DD | null",
  "base_rent": "number (monthly, USD) | null",
  "rent_per_sf": "number (annual $/SF) | null",
  "total_sf": "number | null",
  "annual_rent": "number (USD) | null",
  "escalation_type": "fixed | cpi | none | null",
  "escalation_rate": "number (percentage, e.g. 3 for 3%) | null",
  "escalation_timing": "calendar_year | lease_anniversary | null",
  "free_rent_months": "number | null",
  "ti_allowance": "number (USD) | null",
  "renewal_type": "string | null",
  "renewal_options": "string | null",
  "renewal_notice_months": "number | null",
  "cam_cap_type": "none | cumulative | non_cumulative | null",
  "cam_cap_rate": "number (percentage) | null",
  "cpi_index": "string | null",
  "admin_fee_pct": "number (percentage) | null",
  "management_fee_basis": "tenant_annual_rent | cam_pool_pro_rata | null",
  "gross_up_clause": "boolean | null",
  "hvac_responsibility": "landlord | tenant | shared | null",
  "hvac_landlord_limit": "number (USD annual) | null",
  "percentage_rent": "boolean | null",
  "percentage_rent_rate": "number (percentage) | null",
  "percentage_rent_breakpoint": "number (USD) | null",
  "sales_reporting_frequency": "monthly | quarterly | annual | null",
  "recon_deadline_days": "number | null",
  "recon_collection_limit_months": "number | null",
  "property_address": "string | null",
  "suite_number": "string | null",
  "confidence_scores": {
    "<field_name>": "number 0-100 representing extraction confidence"
  }
}`;

// ---------------------------------------------------------------------------
// Stage 1a: Docling text extraction
// ---------------------------------------------------------------------------

async function extractTextWithDocling(fileUrl: string, fileName: string): Promise<string | null> {
  const doclingUrl = Deno.env.get("DOCLING_API_URL");
  if (!doclingUrl || fileUrl.startsWith("blob:")) return null;

  try {
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) return null;
    const fileBytes = new Uint8Array(await fileRes.arrayBuffer());

    const apiKey = Deno.env.get("DOCLING_API_KEY");
    const formData = new FormData();
    formData.append("file", new Blob([fileBytes], { type: "application/pdf" }), fileName);
    formData.append("output_formats", "text,tables");

    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(`${doclingUrl}/api/v1/convert`, {
      method: "POST",
      headers,
      body: formData,
    });

    if (!res.ok) return null;
    const raw = await res.json();

    // Combine full text + table markdown for maximum context
    const parts: string[] = [];

    if (raw.full_text) parts.push(raw.full_text);
    if (raw.text) parts.push(raw.text);

    if (Array.isArray(raw.tables)) {
      for (const table of raw.tables) {
        if (table.markdown) parts.push(`\n[TABLE]\n${table.markdown}\n[/TABLE]`);
        else if (Array.isArray(table.rows)) {
          const rows = table.rows.map((r: string[]) => r.join(" | ")).join("\n");
          parts.push(`\n[TABLE]\n${rows}\n[/TABLE]`);
        }
      }
    }

    const combined = parts.join("\n\n").trim();
    return combined.length > 50 ? combined : null;
  } catch (err) {
    console.error("[extract-lease] Docling error:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stage 1b: Fallback — download PDF and extract printable ASCII text
// ---------------------------------------------------------------------------

async function extractTextFallback(fileUrl: string): Promise<string | null> {
  if (fileUrl.startsWith("blob:")) return null;

  try {
    const res = await fetch(fileUrl);
    if (!res.ok) return null;

    const bytes = new Uint8Array(await res.arrayBuffer());

    // Extract printable ASCII runs (length >= 4) from the PDF byte stream.
    // This works for text-based PDFs. Scanned PDFs will yield little text.
    const chunks: string[] = [];
    let current = "";

    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b >= 32 && b <= 126) {
        current += String.fromCharCode(b);
      } else {
        if (current.length >= 4) chunks.push(current);
        current = "";
      }
    }
    if (current.length >= 4) chunks.push(current);

    // Join and clean up — remove PDF internals noise
    const raw = chunks.join(" ");
    const cleaned = raw
      .replace(/\s+/g, " ")
      .replace(/[^\x20-\x7E\n]/g, "")
      .trim();

    // Limit to first 12,000 chars to stay within Gemini's context window
    return cleaned.length > 100 ? cleaned.slice(0, 12000) : null;
  } catch (err) {
    console.error("[extract-lease] Fallback text extraction error:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stage 2: Vertex AI (Gemini) extraction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert commercial real estate lease analyst. 
Your job is to extract structured data from lease documents with high accuracy.

Rules:
- Extract ONLY information explicitly stated in the document. Do not infer or guess.
- For dates, always output YYYY-MM-DD format.
- For monetary values, output numbers only (no $ signs or commas).
- For percentages, output the number only (e.g. 3 for 3%).
- If a field is not mentioned in the document, set it to null.
- confidence_scores must be integers 0-100:
  - 95-100: field is explicitly stated with exact value
  - 80-94: field is clearly implied or stated with minor ambiguity
  - 60-79: field is mentioned but requires interpretation
  - 0-59: field is inferred or uncertain
- Return ONLY valid JSON. No explanation, no markdown, no code fences.`;

interface LeaseExtractionResult {
  tenant_name: string | null;
  lease_type: string | null;
  start_date: string | null;
  end_date: string | null;
  base_rent: number | null;
  rent_per_sf: number | null;
  total_sf: number | null;
  annual_rent: number | null;
  escalation_type: string | null;
  escalation_rate: number | null;
  escalation_timing: string | null;
  free_rent_months: number | null;
  ti_allowance: number | null;
  renewal_type: string | null;
  renewal_options: string | null;
  renewal_notice_months: number | null;
  cam_cap_type: string | null;
  cam_cap_rate: number | null;
  cpi_index: string | null;
  admin_fee_pct: number | null;
  management_fee_basis: string | null;
  gross_up_clause: boolean | null;
  hvac_responsibility: string | null;
  hvac_landlord_limit: number | null;
  percentage_rent: boolean | null;
  percentage_rent_rate: number | null;
  percentage_rent_breakpoint: number | null;
  sales_reporting_frequency: string | null;
  recon_deadline_days: number | null;
  recon_collection_limit_months: number | null;
  property_address: string | null;
  suite_number: string | null;
  confidence_scores: Record<string, number>;
}

async function extractWithVertexAI(text: string, fileName: string): Promise<LeaseExtractionResult | null> {
  const result = await callVertexAIJSON<LeaseExtractionResult>({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Extract all lease fields from the following lease document text.

File: ${fileName}

Return a JSON object matching this exact schema:
${LEASE_SCHEMA}

LEASE DOCUMENT TEXT:
---
${text}
---`,
    maxOutputTokens: 2048,
    temperature: 0,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Empty scaffold (when no API key or extraction fails)
// ---------------------------------------------------------------------------

function emptyScaffold(): LeaseExtractionResult {
  return {
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
    escalation_timing: "lease_anniversary",
    free_rent_months: null,
    ti_allowance: null,
    renewal_type: null,
    renewal_options: null,
    renewal_notice_months: null,
    cam_cap_type: "none",
    cam_cap_rate: null,
    cpi_index: null,
    admin_fee_pct: 10,
    management_fee_basis: "cam_pool_pro_rata",
    gross_up_clause: false,
    hvac_responsibility: "landlord",
    hvac_landlord_limit: null,
    percentage_rent: false,
    percentage_rent_rate: null,
    percentage_rent_breakpoint: null,
    sales_reporting_frequency: "annual",
    recon_deadline_days: 90,
    recon_collection_limit_months: 12,
    property_address: null,
    suite_number: null,
    confidence_scores: {},
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { file_url = "", file_name = "lease.pdf" } = body;

    // Check if Vertex AI is available
    const hasVertexAI = !!Deno.env.get("VERTEX_PROJECT_ID") && !!Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");

    if (!hasVertexAI) {
      console.warn("[extract-lease] VERTEX_PROJECT_ID or GOOGLE_SERVICE_ACCOUNT_KEY not set — returning empty scaffold");
      return new Response(
        JSON.stringify(emptyScaffold()),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Stage 1: Extract text from PDF
    let extractedText: string | null = null;

    // Try Docling first (better quality)
    if (file_url && !file_url.startsWith("blob:")) {
      extractedText = await extractTextWithDocling(file_url, file_name);
    }

    // Fall back to raw byte extraction
    if (!extractedText && file_url && !file_url.startsWith("blob:")) {
      extractedText = await extractTextFallback(file_url);
    }

    if (!extractedText) {
      console.warn("[extract-lease] Could not extract text from PDF — returning scaffold");
      return new Response(
        JSON.stringify(emptyScaffold()),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(`[extract-lease] Extracted ${extractedText.length} chars from ${file_name}, sending to Vertex AI`);

    // Stage 2: Vertex AI extraction
    const extracted = await extractWithVertexAI(extractedText, file_name);

    if (!extracted) {
      console.warn("[extract-lease] Vertex AI returned null — returning scaffold");
      return new Response(
        JSON.stringify(emptyScaffold()),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Derive annual_rent from base_rent if missing
    if (!extracted.annual_rent && extracted.base_rent) {
      extracted.annual_rent = Math.round(extracted.base_rent * 12);
    }

    // Derive base_rent from annual_rent if missing
    if (!extracted.base_rent && extracted.annual_rent) {
      extracted.base_rent = Math.round(extracted.annual_rent / 12);
    }

    console.log(`[extract-lease] Successfully extracted lease fields for ${file_name} via Vertex AI`);

    return new Response(
      JSON.stringify(extracted),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (err) {
    console.error("[extract-lease] Error:", err.message);

    // Return scaffold on error so the UI doesn't break
    return new Response(
      JSON.stringify({ ...emptyScaffold(), _extraction_error: err.message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
