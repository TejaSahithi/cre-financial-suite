// @ts-nocheck
/**
 * extract-document-fields — Universal Multi-Format AI Extraction Edge Function
 *
 * Accepts raw text from any document (PDF, Word, CSV, Excel, TXT) already
 * extracted browser-side, then uses Google Vertex AI (Gemini 1.5 Pro) to
 * return structured JSON fields for the requested CRE module.
 *
 * Request:
 *   POST { moduleType: string, rawText: string, fileName: string }
 *
 * Response:
 *   { rows: object[], method: 'ai' | 'fallback', confidence: number }
 */

import { corsHeaders } from "../_shared/cors.ts";
import { callVertexAIJSON } from "../_shared/vertex-ai.ts";

// ── Module-specific field schemas & prompts ───────────────────────────────────

const MODULE_SCHEMAS: Record<string, { fields: string; example: string }> = {
  property: {
    fields: `{
  "name": string or null,
  "address": string or null,
  "city": string or null,
  "state": string (2-letter code) or null,
  "zip": string or null,
  "property_type": "office"|"retail"|"industrial"|"mixed_use"|"multifamily"|"hotel"|"land"|"other" or null,
  "total_sqft": number or null,
  "year_built": number (4-digit year) or null,
  "total_units": number or null,
  "floors": number or null,
  "status": "active"|"inactive"|"under_construction"|"sold" or null,
  "market_value": number (USD, no symbols) or null,
  "purchase_price": number (USD) or null,
  "cap_rate": number (e.g. 5.5 for 5.5%) or null,
  "noi": number (USD annual) or null,
  "manager": string or null,
  "notes": string or null
}`,
    example: '{"name": "Tower One", "address": "123 Main St", "city": "Phoenix", "state": "AZ", "zip": "85001", "property_type": "office", "total_sqft": 50000}'
  },
  lease: {
    fields: `{
  "tenant_name": string or null,
  "property_name": string or null,
  "unit_number": string or null,
  "start_date": "YYYY-MM-DD" or null,
  "end_date": "YYYY-MM-DD" or null,
  "lease_term_months": number or null,
  "monthly_rent": number (USD/month, no symbols) or null,
  "annual_rent": number (USD/year) or null,
  "rent_per_sf": number (annual $/SF) or null,
  "square_footage": number or null,
  "lease_type": "nnn"|"gross"|"modified_gross"|"nn"|"net" or null,
  "security_deposit": number (USD) or null,
  "cam_amount": number (annual USD) or null,
  "escalation_rate": number (e.g. 3 for 3%) or null,
  "renewal_options": string or null,
  "status": "active"|"expired"|"pending"|"vacant" or null,
  "notes": string or null
}`,
    example: '{"tenant_name": "Acme Corp", "monthly_rent": 8500, "start_date": "2024-01-01", "end_date": "2026-12-31"}'
  },
  tenant: {
    fields: `{
  "name": string or null,
  "company": string or null,
  "email": string or null,
  "phone": string or null,
  "contact_name": string or null,
  "industry": string or null,
  "status": "active"|"inactive" or null,
  "notes": string or null
}`,
    example: '{"name": "John Smith", "company": "Acme Corp", "email": "john@acme.com"}'
  },
  building: {
    fields: `{
  "name": string or null,
  "address": string or null,
  "total_sqft": number or null,
  "floors": number or null,
  "year_built": number (4-digit year) or null,
  "status": string or null
}`,
    example: '{"name": "Building A", "floors": 5, "total_sqft": 50000}'
  },
  unit: {
    fields: `{
  "unit_number": string or null,
  "floor": number or null,
  "square_footage": number or null,
  "unit_type": "office"|"retail"|"industrial"|"residential"|"storage"|"other" or null,
  "status": "vacant"|"occupied"|"under_renovation" or null,
  "monthly_rent": number (USD) or null,
  "tenant_name": string or null
}`,
    example: '{"unit_number": "101", "square_footage": 1200, "status": "occupied"}'
  },
  expense: {
    fields: `{
  "date": "YYYY-MM-DD" or null,
  "category": string or null,
  "amount": number (USD, no symbols) or null,
  "vendor": string or null,
  "description": string or null,
  "classification": "recoverable"|"non_recoverable"|"conditional" or null,
  "gl_code": string or null,
  "property_name": string or null,
  "invoice_number": string or null,
  "fiscal_year": number (4-digit year) or null,
  "month": number (1-12) or null
}`,
    example: '{"date": "2024-03-15", "amount": 1250.00, "vendor": "ABC Maintenance", "category": "maintenance"}'
  },
  revenue: {
    fields: `{
  "property_name": string or null,
  "tenant_name": string or null,
  "type": "base_rent"|"cam_recovery"|"parking"|"percentage_rent"|"other" or null,
  "amount": number (USD, no symbols) or null,
  "date": "YYYY-MM-DD" or null,
  "fiscal_year": number (4-digit year) or null,
  "month": number (1-12) or null,
  "notes": string or null
}`,
    example: '{"tenant_name": "Acme Corp", "amount": 8500, "type": "base_rent", "date": "2024-01-01"}'
  },
  gl_account: {
    fields: `{
  "code": string or null,
  "name": string or null,
  "type": "income"|"expense"|"asset"|"liability"|"equity" or null,
  "category": string or null,
  "normal_balance": "debit"|"credit" or null,
  "is_active": true | false,
  "is_recoverable": true | false,
  "notes": string or null
}`,
    example: '{"code": "5100", "name": "Maintenance Expense", "type": "expense"}'
  },
};

const SYSTEM_PROMPT = `You are a commercial real estate (CRE) data extraction engine. 
Your ONLY job is to extract structured field values from documents and return them as valid JSON.

CRITICAL RULES:
1. Output ONLY valid JSON — no explanation, no markdown, no code fences, no commentary.
2. If extracting MULTIPLE records (e.g. a rent roll table), output a JSON array: [{...}, {...}]
3. If extracting a SINGLE record (e.g. one lease), output a single object: {...}
4. All monetary values: plain numbers only. "$12,000" → 12000. "$1,200/month" → 1200.
5. All percentages: plain numbers. "3%" → 3. "3.5%" → 3.5.
6. All dates: YYYY-MM-DD format. "January 1, 2024" → "2024-01-01".
7. If a field is not found anywhere in the document: use null — do NOT omit the key.
8. For tables/rent rolls: extract EACH ROW as a separate object in the array.`;

function buildUserPrompt(moduleType: string, rawText: string, fileName: string): string {
  const schema = MODULE_SCHEMAS[moduleType] || MODULE_SCHEMAS.property;
  return `Extract all ${moduleType} data from the document below.
  
File: ${fileName}
Module: ${moduleType.toUpperCase()}

If the document contains a SINGLE record, return one JSON object.
If it contains MULTIPLE records (table, rent roll, schedule), return a JSON ARRAY of objects.

Each record must have EXACTLY these fields (use null for missing values):
${schema.fields}

Example output for one record:
${schema.example}

DOCUMENT:
---
${rawText.slice(0, 20000)}
---`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

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
    const { moduleType = "property", rawText = "", fileName = "document" } = body;

    if (!rawText || rawText.trim().length < 10) {
      return respond({ error: "rawText is required and must not be empty", rows: [] }, 400);
    }

    const hasVertexAI =
      !!Deno.env.get("VERTEX_PROJECT_ID") &&
      !!Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");

    if (!hasVertexAI) {
      console.warn("[extract-document-fields] Vertex AI not configured");
      return respond({ error: "Vertex AI not configured", rows: [], method: "fallback" });
    }

    console.log(`[extract-document-fields] Processing ${moduleType} from "${fileName}" (${rawText.length} chars)`);

    const result = await callVertexAIJSON({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(moduleType, rawText, fileName),
      maxOutputTokens: 4096,
      temperature: 0,
    });

    if (!result) {
      return respond({ error: "AI returned no parseable JSON", rows: [], method: "ai_failed" }, 500);
    }

    // Normalise: always return an array of rows
    const rows = Array.isArray(result) ? result : [result];

    // Strip nulls at top level (keep nulls inside objects so UI shows —)
    const cleanRows = rows
      .filter(r => r && typeof r === "object")
      .map((r, i) => ({ ...r, _row: i + 1 }));

    console.log(`[extract-document-fields] Extracted ${cleanRows.length} rows`);

    return respond({
      rows: cleanRows,
      method: "ai",
      model: "gemini-1.5-pro-002",
      charCount: rawText.length,
    });

  } catch (err) {
    console.error("[extract-document-fields] Error:", err.message);
    return respond({ error: err.message, rows: [], method: "error" }, 500);
  }
});
