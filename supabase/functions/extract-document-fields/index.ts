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
 *   { rows: object[], method: 'ai' | 'fallback', model: string }
 */

import { corsHeaders } from "../_shared/cors.ts";
import { callVertexAIJSON } from "../_shared/vertex-ai.ts";

// ── Module-specific field schemas & prompts ───────────────────────────────────

const MODULE_SCHEMAS: Record<string, { description: string; fields: string; tableHint: string }> = {
  property: {
    description: "Commercial real estate property / asset record",
    tableHint: "Look for a property listing, asset summary, or property data table.",
    fields: `{
  "name": "string — property name or building name",
  "address": "string — street address",
  "city": "string — city name",
  "state": "string — 2-letter US state code (e.g. AZ, CA, TX)",
  "zip": "string — zip/postal code",
  "property_type": "one of: office | retail | industrial | mixed_use | multifamily | hotel | land | other",
  "total_sqft": "number — total rentable square footage (no $ or commas)",
  "year_built": "number — 4-digit year (e.g. 1998)",
  "total_units": "number — number of units (apartments/suites)",
  "floors": "number — number of floors/stories",
  "status": "one of: active | inactive | under_construction | sold",
  "purchase_price": "number — acquisition/purchase price in USD",
  "market_value": "number — current appraised/market value in USD",
  "noi": "number — annual net operating income in USD",
  "cap_rate": "number — capitalization rate as a plain number (e.g. 5.5 for 5.5%)",
  "manager": "string — property manager name",
  "owner": "string — owner name or entity",
  "notes": "string — any additional notes or description"
}`
  },

  lease: {
    description: "Commercial lease / rent roll record",
    tableHint: "Look for a lease abstract, rent roll table, lease summary, or tenant schedule. Each row/tenant is a separate lease record.",
    fields: `{
  "tenant_name": "string — name of the tenant or company",
  "property_name": "string — name of the property or building",
  "unit_number": "string — unit, suite, or space number",
  "start_date": "string — lease commencement date in YYYY-MM-DD format",
  "end_date": "string — lease expiration date in YYYY-MM-DD format",
  "lease_term_months": "number — total lease duration in months",
  "monthly_rent": "number — base rent per month in USD (no $ or commas)",
  "annual_rent": "number — base rent per year in USD",
  "rent_per_sf": "number — annual rent per square foot (USD/SF/year)",
  "square_footage": "number — leased area in square feet",
  "lease_type": "one of: nnn | gross | modified_gross | nn | net",
  "security_deposit": "number — security deposit amount in USD",
  "cam_amount": "number — annual CAM charges in USD",
  "escalation_rate": "number — annual rent escalation as plain % (e.g. 3 for 3%)",
  "renewal_options": "string — description of renewal options",
  "ti_allowance": "number — tenant improvement allowance in USD",
  "free_rent_months": "number — number of free rent months",
  "status": "one of: active | expired | pending | vacant",
  "notes": "string — any additional notes"
}`
  },

  tenant: {
    description: "Tenant contact / company record",
    tableHint: "Look for tenant or contact information.",
    fields: `{
  "name": "string — tenant or contact full name",
  "company": "string — company or business name",
  "email": "string — email address",
  "phone": "string — phone number",
  "contact_name": "string — primary contact person name",
  "industry": "string — business industry or sector",
  "credit_rating": "string — credit rating or score",
  "status": "one of: active | inactive",
  "notes": "string — any notes"
}`
  },

  building: {
    description: "Building record within a property",
    tableHint: "Look for building specifications.",
    fields: `{
  "name": "string — building name",
  "address": "string — street address",
  "total_sqft": "number — total gross square footage",
  "floors": "number — number of floors",
  "year_built": "number — 4-digit year",
  "status": "string — building status"
}`
  },

  unit: {
    description: "Rentable unit or suite within a building",
    tableHint: "Look for a unit schedule, space availability list, or floor plan data.",
    fields: `{
  "unit_number": "string — unit, suite, or space identifier",
  "floor": "number — floor number",
  "square_footage": "number — rentable square footage",
  "unit_type": "one of: office | retail | industrial | residential | storage | other",
  "status": "one of: vacant | occupied | under_renovation",
  "monthly_rent": "number — current monthly rent in USD",
  "tenant_name": "string — name of current tenant (if occupied)"
}`
  },

  expense: {
    description: "Operating expense or invoice record",
    tableHint: "Look for an expense ledger, invoice log, or operating statement. Each line item is a separate expense.",
    fields: `{
  "date": "string — expense/invoice date in YYYY-MM-DD format",
  "category": "string — expense category (e.g. maintenance, utilities, insurance)",
  "amount": "number — expense amount in USD (no $ or commas)",
  "vendor": "string — vendor or supplier name",
  "description": "string — description of the expense",
  "classification": "one of: recoverable | non_recoverable | conditional",
  "gl_code": "string — general ledger account code",
  "property_name": "string — property name",
  "invoice_number": "string — invoice or reference number",
  "fiscal_year": "number — 4-digit fiscal year",
  "month": "number — calendar month (1-12)"
}`
  },

  revenue: {
    description: "Revenue or income record",
    tableHint: "Look for a revenue summary, income statement, or rent collection record.",
    fields: `{
  "property_name": "string — property name",
  "tenant_name": "string — tenant name",
  "type": "one of: base_rent | cam_recovery | parking | percentage_rent | other",
  "amount": "number — revenue amount in USD (no $ or commas)",
  "date": "string — date in YYYY-MM-DD format",
  "fiscal_year": "number — 4-digit fiscal year",
  "month": "number — calendar month (1-12)",
  "notes": "string — any notes"
}`
  },

  gl_account: {
    description: "Chart of accounts / GL account record",
    tableHint: "Look for a chart of accounts table or account list.",
    fields: `{
  "code": "string — account number or GL code",
  "name": "string — account name or description",
  "type": "one of: income | expense | asset | liability | equity",
  "category": "string — account category or grouping",
  "normal_balance": "one of: debit | credit",
  "is_active": "boolean — true if active, false if inactive",
  "is_recoverable": "boolean — true if CAM-recoverable",
  "notes": "string — any notes"
}`
  },
};

// ── System Prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert commercial real estate (CRE) data extraction system.
Your ONLY job is to extract structured field values from documents and return them as strictly valid JSON.

CRITICAL OUTPUT RULES — follow ALL of these exactly:
1. Output ONLY valid JSON. No explanation, no markdown code fences, no preamble, no commentary.
2. If extracting MULTIPLE records (e.g. rent roll table, expense log, unit list) → output a JSON ARRAY: [{...}, {...}]
3. If extracting a SINGLE record (e.g. one lease abstract, one property profile) → output a JSON OBJECT: {...}
4. NEVER omit a field key. If the value is not found anywhere, use null — never skip the key.
5. MONETARY VALUES: Extract as plain numbers only. "$12,500" → 12500. "$1.2M" → 1200000. "$25/SF" → 25.
6. PERCENTAGES: Plain numbers only. "3%" → 3. "3.5%" → 3.5. "350 bps" → 3.5.
7. DATES: Always convert to YYYY-MM-DD. "January 1, 2024" → "2024-01-01". "3/15/24" → "2024-03-15".
8. SQUARE FOOTAGE: Plain number only. "12,000 SF" → 12000. "5,500 RSF" → 5500.
9. For rent rolls and similar tables: EACH ROW = one separate JSON object in the array.
10. When you see "per SF" or "PSF" figures, extract them as rent_per_sf (annual, unless document says monthly).
11. If monthly_rent and annual_rent conflict, prefer whichever has more decimal precision or appears more explicitly.
12. For dates given as just a year (e.g. "2024"), use "2024-01-01" as a default date.`;

function buildUserPrompt(moduleType: string, rawText: string, fileName: string): string {
  const schema = MODULE_SCHEMAS[moduleType] ?? MODULE_SCHEMAS.property;
  const recordCount = rawText.length > 5000
    ? "MULTIPLE records (use a JSON array)"
    : "one or more records";

  return `Extract all ${schema.description} data from the document below.

File name: "${fileName}"
Module: ${moduleType.toUpperCase()}
Document hint: ${schema.tableHint}

TASK:
- Scan the ENTIRE document for every piece of data matching the fields below.
- This document likely contains ${recordCount}.
- Each separate record (tenant, unit, expense, etc.) must be a separate JSON object.
- Return results as a JSON array even if there is only 1 record.

FIELDS TO EXTRACT (return null for any field not found):
${schema.fields}

DOCUMENT TEXT:
─────────────────────────────────────────────────────
${rawText.slice(0, 24000)}
─────────────────────────────────────────────────────

OUTPUT ONLY VALID JSON. NO EXPLANATION.`;
}

// ── Rule-based fallback extractor (no AI needed) ─────────────────────────────
// Used when Vertex AI is not configured. Handles common lease document patterns.

function extractLeaseFieldsRuleBased(text: string, moduleType: string): Record<string, unknown>[] {
  if (moduleType !== "lease") return [];

  const t = text;
  const row: Record<string, unknown> = {};

  // Tenant name
  const tenantMatch = t.match(/Tenant[:\s]+([A-Z][^\n,]{2,60}(?:LLC|Inc|Corp|Ltd|LLP|LP|Co\.?)?)/i)
    || t.match(/Lessee[:\s]+([A-Z][^\n,]{2,60})/i);
  if (tenantMatch) row.tenant_name = tenantMatch[1].trim();

  // Lease type
  if (/gross\s+lease|full[\s-]service/i.test(t)) row.lease_type = "gross";
  else if (/triple[\s-]net|nnn/i.test(t)) row.lease_type = "nnn";
  else if (/modified[\s-]gross/i.test(t)) row.lease_type = "modified_gross";
  else if (/double[\s-]net|nn\b/i.test(t)) row.lease_type = "nn";

  // Dates — "January 1, 2025" or "01/01/2025" or "2025-01-01"
  const MONTHS: Record<string, string> = {
    january:"01",february:"02",march:"03",april:"04",may:"05",june:"06",
    july:"07",august:"08",september:"09",october:"10",november:"11",december:"12",
    jan:"01",feb:"02",mar:"03",apr:"04",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12"
  };
  function parseDate(s: string): string | null {
    s = s.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (us) return `${us[3]}-${us[1].padStart(2,"0")}-${us[2].padStart(2,"0")}`;
    const long = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    if (long) {
      const m = MONTHS[long[1].toLowerCase()];
      if (m) return `${long[3]}-${m}-${long[2].padStart(2,"0")}`;
    }
    return null;
  }

  const startMatch = t.match(/(?:Start\s*Date|Commencement\s*Date|Lease\s*Start)[:\s]+([A-Za-z0-9\/\-,\s]+?)(?:\n|$)/i);
  if (startMatch) { const d = parseDate(startMatch[1]); if (d) row.start_date = d; }

  const endMatch = t.match(/(?:End\s*Date|Expir(?:ation|y)\s*Date|Lease\s*End)[:\s]+([A-Za-z0-9\/\-,\s]+?)(?:\n|$)/i);
  if (endMatch) { const d = parseDate(endMatch[1]); if (d) row.end_date = d; }

  // Monthly rent — "$5,000 per month" or "Base Rent: $5,000"
  const rentMatch = t.match(/(?:Base\s*Rent|Monthly\s*Rent)[:\s]*\$?([\d,]+(?:\.\d{2})?)\s*(?:per\s*month)?/i)
    || t.match(/\$\s*([\d,]+(?:\.\d{2})?)\s*per\s*month/i);
  if (rentMatch) {
    const n = parseFloat(rentMatch[1].replace(/,/g, ""));
    if (!isNaN(n)) row.monthly_rent = n;
  }

  // Square footage
  const sfMatch = t.match(/([\d,]+)\s*(?:square\s*feet|sq\.?\s*ft\.?|SF|RSF)/i);
  if (sfMatch) {
    const n = parseFloat(sfMatch[1].replace(/,/g, ""));
    if (!isNaN(n)) row.square_footage = n;
  }

  // Security deposit
  const depMatch = t.match(/(?:Security\s*Deposit)[:\s]*\$?([\d,]+(?:\.\d{2})?)/i);
  if (depMatch) {
    const n = parseFloat(depMatch[1].replace(/,/g, ""));
    if (!isNaN(n)) row.security_deposit = n;
  }

  // Escalation
  const escMatch = t.match(/(?:escalation|increase)[:\s]*([\d.]+)\s*%/i);
  if (escMatch) row.escalation_rate = parseFloat(escMatch[1]);

  // Free rent
  const freeMatch = t.match(/(?:Free\s*Rent)[:\s]*(?:None|(\d+)\s*months?)/i);
  if (freeMatch) row.free_rent_months = freeMatch[1] ? parseInt(freeMatch[1]) : 0;

  // Late fee
  const lateMatch = t.match(/(?:Late\s*Fee)[:\s]*([\d.]+)\s*%/i);
  if (lateMatch) row.notes = (row.notes ? row.notes + "; " : "") + `Late fee: ${lateMatch[1]}%`;

  // Utilities included → gross lease indicator
  if (/utilities[:\s]+included/i.test(t) && !row.lease_type) row.lease_type = "gross";

  // Derive annual_rent from monthly
  if (row.monthly_rent) {
    row.annual_rent = Math.round((row.monthly_rent as number) * 12 * 100) / 100;
  }

  // Confidence scores — higher for fields we found, lower for missing
  const confidence_scores: Record<string, number> = {};
  const fields = ["tenant_name","start_date","end_date","monthly_rent","annual_rent",
    "square_footage","lease_type","security_deposit","escalation_rate","free_rent_months"];
  for (const f of fields) {
    confidence_scores[f] = row[f] != null ? 82 : 40;
  }
  row.confidence_scores = confidence_scores;

  return Object.keys(row).length > 1 ? [row] : [];
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
      console.warn("[extract-document-fields] Vertex AI not configured — using rule-based fallback");
      // Rule-based extraction for common lease fields when AI is unavailable
      const fallbackRows = extractLeaseFieldsRuleBased(rawText, moduleType);
      if (fallbackRows.length > 0) {
        return respond({ rows: fallbackRows, method: "fallback", model: "rule-based" });
      }
      return respond({ error: "Vertex AI is not configured on this server.", rows: [], method: "fallback" });
    }

    const charCount = rawText.length;
    console.log(
      `[extract-document-fields] ${moduleType} | "${fileName}" | ${charCount} chars`
    );

    const result = await callVertexAIJSON({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(moduleType, rawText, fileName),
      maxOutputTokens: 8192,
      temperature: 0,
    });

    if (!result) {
      return respond(
        { error: "AI returned no parseable JSON. The document may be too complex or empty.", rows: [], method: "ai_failed" },
        500
      );
    }

    // Normalise: always return an array
    const rows = Array.isArray(result) ? result : [result];

    // Tag each row with its source row number
    const cleanRows = rows
      .filter((r) => r && typeof r === "object")
      .map((r, i) => ({ ...r, _row: i + 1 }));

    console.log(`[extract-document-fields] Extracted ${cleanRows.length} rows`);

    return respond({
      rows: cleanRows,
      method: "ai",
      model: "gemini-1.5-pro-002",
      charCount,
    });
  } catch (err) {
    console.error("[extract-document-fields] Error:", err?.message ?? err);
    return respond({ error: String(err?.message ?? err), rows: [], method: "error" }, 500);
  }
});
