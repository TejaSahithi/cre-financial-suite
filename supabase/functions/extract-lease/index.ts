// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { callVertexAI } from "../_shared/vertex-ai.ts";
import { normalizeLease } from "../_shared/lease-normalizer.ts";

/**
 * extract-lease Edge Function
 *
 * Pipeline:
 *   1. Download PDF from URL
 *   2. Extract text (Docling if available, else raw byte scan)
 *   3. Send to Vertex AI Gemini with a strict JSON prompt
 *   4. Normalize raw AI output (strip $, commas, convert dates)
 *   5. Return clean typed JSON — always, even on failure (returns scaffold)
 *
 * Request body: { file_url: string, file_name?: string }
 */

// ── Strict prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a commercial real estate lease data extraction engine.
Your ONLY job is to output a single valid JSON object — no explanation, no markdown, no code fences.

STRICT RULES:
1. Output ONLY raw JSON. The first character must be "{" and the last must be "}".
2. Do NOT wrap in markdown code blocks or add any text before or after the JSON.
3. All monetary values must be plain numbers (no "$", no commas, no "per month").
   Example: "$12,000/month" → 12000
4. All percentages must be plain numbers (no "%" sign).
   Example: "3%" → 3
5. All dates must be in YYYY-MM-DD format.
   Example: "January 1, 2024" → "2024-01-01"
6. If a field is not found in the document, use null — never omit the key.
7. confidence_scores: integer 0-100 per field.
   95-100 = explicitly stated. 80-94 = clearly implied. 60-79 = requires interpretation. 0-59 = uncertain.`;

const USER_PROMPT_TEMPLATE = (text: string, fileName: string) => `Extract all lease fields from the document below.

File: ${fileName}

Return EXACTLY this JSON structure (no extra keys, no missing keys):
{
  "tenant_name": string or null,
  "lease_type": "triple_net" | "gross" | "modified_gross" | "full_service" | null,
  "lease_start": "YYYY-MM-DD" or null,
  "lease_end": "YYYY-MM-DD" or null,
  "lease_term_months": number or null,
  "base_rent": number (monthly USD, no symbols) or null,
  "rent_per_sf": number (annual $/SF) or null,
  "total_sf": number or null,
  "annual_rent": number (USD) or null,
  "escalation_type": "fixed" | "cpi" | "none" | null,
  "escalation_value": number (percentage, e.g. 3 for 3%) or null,
  "escalation_timing": "calendar_year" | "lease_anniversary" | null,
  "free_rent_months": number or null,
  "ti_allowance": number (USD) or null,
  "renewal_options": string or null,
  "renewal_notice_months": number or null,
  "cam_applicable": true | false | null,
  "cam_cap_type": "none" | "cumulative" | "non_cumulative" | null,
  "cam_cap_rate": number (percentage) or null,
  "cam_cap": number (USD annual cap) or null,
  "admin_fee_pct": number (percentage) or null,
  "gross_up_clause": true | false | null,
  "hvac_responsibility": "landlord" | "tenant" | "shared" | null,
  "percentage_rent": true | false | null,
  "percentage_rent_rate": number (percentage) or null,
  "property_address": string or null,
  "suite_number": string or null,
  "confidence_scores": {
    "tenant_name": 0-100,
    "lease_start": 0-100,
    "lease_end": 0-100,
    "base_rent": 0-100,
    "escalation_type": 0-100,
    "cam_applicable": 0-100
  }
}

LEASE DOCUMENT:
---
${text.slice(0, 14000)}
---`;

// ── Text extraction ───────────────────────────────────────────────────────

async function extractTextWithDocling(fileUrl: string, fileName: string): Promise<string | null> {
  const doclingUrl = Deno.env.get("DOCLING_API_URL");
  if (!doclingUrl) return null;

  try {
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) return null;
    const fileBytes = new Uint8Array(await fileRes.arrayBuffer());

    const formData = new FormData();
    formData.append("file", new Blob([fileBytes], { type: "application/pdf" }), fileName);
    formData.append("output_formats", "text,tables");

    const headers: Record<string, string> = {};
    const apiKey = Deno.env.get("DOCLING_API_KEY");
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(`${doclingUrl}/api/v1/convert`, {
      method: "POST", headers, body: formData,
    });
    if (!res.ok) return null;

    const raw = await res.json();
    const parts: string[] = [];
    if (raw.full_text) parts.push(raw.full_text);
    if (raw.text) parts.push(raw.text);
    if (Array.isArray(raw.tables)) {
      for (const t of raw.tables) {
        if (t.markdown) parts.push(`\n[TABLE]\n${t.markdown}\n[/TABLE]`);
      }
    }
    const combined = parts.join("\n\n").trim();
    return combined.length > 50 ? combined : null;
  } catch (err) {
    console.error("[extract-lease] Docling error:", err.message);
    return null;
  }
}

async function extractTextFallback(fileUrl: string): Promise<string | null> {
  try {
    const res = await fetch(fileUrl);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());

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

    const cleaned = chunks.join(" ")
      .replace(/\s+/g, " ")
      .replace(/[^\x20-\x7E\n]/g, "")
      .trim();

    return cleaned.length > 100 ? cleaned : null;
  } catch (err) {
    console.error("[extract-lease] Fallback extraction error:", err.message);
    return null;
  }
}

// ── Empty scaffold ────────────────────────────────────────────────────────

function emptyScaffold() {
  return {
    tenant_name: null, lease_type: null,
    lease_start: null, lease_end: null, lease_term_months: null,
    base_rent: null, rent_per_sf: null, total_sf: null, annual_rent: null,
    escalation_type: null, escalation_value: null, escalation_timing: null,
    free_rent_months: null, ti_allowance: null,
    renewal_options: null, renewal_notice_months: null,
    cam_applicable: null, cam_cap_type: null, cam_cap_rate: null, cam_cap: null,
    admin_fee_pct: null, gross_up_clause: null, hvac_responsibility: null,
    percentage_rent: null, percentage_rent_rate: null,
    property_address: null, suite_number: null,
    confidence: 0, confidence_scores: {},
  };
}

// ── Main handler ──────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const respond = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const body = await req.json().catch(() => ({}));
    const { file_url = "", file_name = "lease.pdf" } = body;

    const hasVertexAI =
      !!Deno.env.get("VERTEX_PROJECT_ID") &&
      !!Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");

    if (!hasVertexAI) {
      console.warn("[extract-lease] Vertex AI not configured — returning scaffold");
      return respond(emptyScaffold());
    }

    if (!file_url || file_url.startsWith("blob:")) {
      console.warn("[extract-lease] No valid file_url — returning scaffold");
      return respond(emptyScaffold());
    }

    // Stage 1: Extract text
    let text = await extractTextWithDocling(file_url, file_name);
    if (!text) text = await extractTextFallback(file_url);

    if (!text) {
      console.warn("[extract-lease] Could not extract text — returning scaffold");
      return respond(emptyScaffold());
    }

    console.log(`[extract-lease] Extracted ${text.length} chars from "${file_name}"`);

    // Stage 2: Vertex AI
    const aiResponse = await callVertexAI({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: USER_PROMPT_TEMPLATE(text, file_name),
      maxOutputTokens: 2048,
      temperature: 0,
    });

    const rawText = aiResponse.content.trim();
    console.log("[extract-lease] Raw AI response (first 500 chars):", rawText.slice(0, 500));

    // Parse — strip any accidental markdown fences
    const jsonText = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    let rawParsed: Record<string, unknown>;
    try {
      rawParsed = JSON.parse(jsonText);
    } catch (parseErr) {
      console.error("[extract-lease] JSON parse failed:", parseErr.message, "| Raw:", jsonText.slice(0, 300));
      return respond({ ...emptyScaffold(), _extraction_error: "AI returned non-JSON output" });
    }

    // Stage 3: Normalize
    const normalized = normalizeLease(rawParsed);
    console.log("[extract-lease] Normalized output:", JSON.stringify(normalized).slice(0, 400));

    return respond(normalized);

  } catch (err) {
    console.error("[extract-lease] Unhandled error:", err.message);
    return respond({ ...emptyScaffold(), _extraction_error: err.message });
  }
});
