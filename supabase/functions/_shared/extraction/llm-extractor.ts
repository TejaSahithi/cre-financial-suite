// @ts-nocheck
/**
 * Extraction Pipeline - Step 3: LLM Fallback Extraction
 *
 * ONLY called for fields that Step 1 (rule) and Step 2 (table) could not extract.
 * Sends focused, field-wise prompts to OpenAI with ONLY relevant text chunks.
 *
 * Key design rules:
 *   - NEVER pass entire document - only relevant chunks
 *   - Extract fields in small groups (3-7 fields per call)
 *   - Strict JSON output schema - no freeform text
 *   - NO calculations - LLM only reads raw values
 *   - If not found -> null (never guess)
 *   - Temperature = 0 for deterministic extraction
 */

import type {
  DoclingOutput,
  ExtractedField,
  ExtractedRecord,
  StepResult,
  ModuleType,
  TextChunk,
  ExtractionInput,
} from "./types.ts";
import { getSchema, getFieldGroups, type FieldDef, type FieldGroup } from "./schemas.ts";
import { buildRelevantSnippet, chunkDocument } from "./chunker.ts";
import { callLLMJSON } from "../llm.ts";
import { callLLMJSONWithProvenance } from "./provenance/transport/openai.ts";

// -- System prompt - short, strict, no room for hallucination -----------------

const LLM_SYSTEM_PROMPT = `You are a CRE data extraction tool.
You extract ONLY the specific fields requested from the provided text snippet, with SOURCE EVIDENCE.

RULES:
1. Output ONLY valid JSON - no explanation, no markdown, no preamble.
2. For EVERY field requested, return an object of this shape:
     { "value": <extracted value or null>,
       "source_text": "<the exact phrase from the document you used, verbatim, or null>",
       "source_page": <page number if known, else null>,
       "confidence": <number 0.0-1.0> }
   The top-level JSON is { "<field_key>": { value, source_text, source_page, confidence }, ... }.
3. If a field is NOT found, return { "value": null, "source_text": null, "source_page": null, "confidence": 0 }.
4. NEVER guess, infer, or calculate values. Only extract what is explicitly stated.
5. NEVER calculate totals, annual amounts, or derived values - EXCEPTION: notice periods.
   If a field expects MONTHS but the document states the period in DAYS, convert: months = Math.round(days / 30).
   Examples: '180 days' notice -> 6 months. '90 days' notice -> 3 months. '30 days' notice -> 1 month.
   This conversion applies ONLY to notice-period fields (renewal_notice_months, termination_notice_months).

6. ENTITY vs PERSON disambiguation - critical:
   tenant_name and landlord_name are LEGAL ENTITY names (LLC, Inc., Corp, Trust, individual property owner).
   Signatory / signer / "By:" lines belong to tenant_signatory_name or landlord_signatory_name, NEVER to *_name.

   EXAMPLES:
     Input:  "TENANT: Tech Solutions, Inc.   By: JOHN SMITH, President"
     Output: tenant_name.value = "Tech Solutions, Inc."
             tenant_signatory_name.value = "JOHN SMITH"

     Input:  "LANDLORD: Acme Partners, LLC   By: Jane Doe, Manager"
     Output: landlord_name.value = "Acme Partners, LLC"
             landlord_signatory_name.value = "Jane Doe"

     Input:  "This Lease is between John Smith ('Landlord') and Acme Corp ('Tenant')"
     Output: landlord_name.value = "John Smith"  (the entity here is a natural person)
             tenant_name.value = "Acme Corp"

     Input:  "entered into by and between 224 Partners, LLC (\"Landlord\") and Mindful Tech Solutions Inc. (\"Tenant\")"
     Output: landlord_name.value = "224 Partners, LLC"
             tenant_name.value = "Mindful Tech Solutions Inc."

   In a "by and between ... (Landlord) and ... (Tenant)" parties clause:
   - landlord_name is the entity that appears BEFORE the (Landlord) parenthetical
   - tenant_name is the entity that appears BEFORE the (Tenant) parenthetical, NOT after it
   For other formats (TENANT: / LESSEE: label style), extract the FIRST entity name
   following the label, STOPPING at "By:" / "Signed:" / "Its:" / "Title:".

7. Date conventions:
   YYYY-MM-DD format. "January 1, 2024" -> "2024-01-01".
   When the lease shows "commences on February 1, 2024 and ends January 31" with year elided,
   the end year is one year AFTER the commencement year unless the lease explicitly says otherwise.
   So "commences February 1, 2024 and ends January 31" -> end_date.value = "2025-01-31".
   If unsure of the year, leave value null with confidence 0.

8. Monthly vs Annual rent:
   Only put a value in monthly_rent if the lease explicitly says "per month" / "monthly" / "$X/mo".
   Only put a value in annual_rent if the lease explicitly says "per year" / "annually" / "p.a." / "/yr".
   If only one is present, leave the other's value null.

9. Square footage scope:
   square_footage / rentable_area_sqft = the LEASED PREMISES area (tenant's space).
   NEVER use building total, complex total, gross leasable area for the whole project.
   Look for "Premises containing approximately X rentable square feet" or "Leased Premises: X SF".

10. Monetary values: plain numbers only. "$12,500" -> 12500.
11. Percentages: plain number. "3%" -> 3.
12. source_text MUST BE THE EXACT VERBATIM text from the document snippet. NEVER paraphrase your reasoning. NEVER explain how you derived the value.
    If you derived the value from a specific phrase (e.g. extracting Tenant from "Assignee: John"), the source_text MUST BE the exact phrase "Assignee: John".
    If the text is OCR-garbled, return the garbled text exactly as it appears.
    For lease review fields, source_text must be a COMPLETE, EXACT FULL SENTENCE from the lease document that contains the value and enough surrounding context for a reviewer to understand why the value was extracted.
    Do NOT return fragments like only "THIS LEASE AGREEMENT", only a party name, only a date, or text ending mid-sentence.
    Prefer the SHORTEST verbatim clause that supports the value - a single numbered line item or sentence is ideal.
    Do NOT quote an entire paragraph, section header, or document preamble (e.g., "SUMMARY OF BASIC LEASE INFORMATION...").
    If the snippet contains [[PAGE n]] markers, source_page is mandatory and must match the page containing source_text.
    If you cannot provide an exact source_text for a found value, return value null.

13. Numbered-summary documents are common - leases often start with a section like:
        "1. Date: January 1, 2025
         2. Landlord: Acme Partners, LLC
         3. Address of Landlord: 123 Main St, Suite 100, Cityville, ST 12345
         4. Tenant: Tech Solutions, Inc.
         5. Address of Tenant: 456 Tech Blvd, Cityville, ST 12345
         6. Premises: 2,500 rentable square feet
         9. Rent: $5,000 per month
         10. Permitted Use: General Office"
    The label after the number IS the field label. Extract from these lines even though they don't say
    "Landlord Name:" or "Property Address:" verbatim.
    CRITICAL - numbered-list boundary rule: when extracting a value from a numbered line,
    STOP at the end of that line. The NUMBER that begins the NEXT line is NOT part of the
    current field's value. Examples:
      "2. Landlord: Acme Partners, LLC\n3. Address..." -> landlord_name = "Acme Partners, LLC"  NOT "Acme Partners, LLC 3"
      "3. Address of Landlord: 123 Main St\n4. Tenant..." -> landlord_address = "123 Main St"  NOT "4"
    If the address appears only as a trailing number (e.g. you see only "4"), it is WRONG - return null.
    For tenant_contact_name / landlord_contact_name: the value MUST be a human first+last name.
    NEVER return a calendar month name (January, February, March, April, May, June, July,
    August, September, October, November, December) - those are dates, not person names.
      BAD:  tenant_contact_name = "January"  (extracted from "January 9, 2024")
      GOOD: tenant_contact_name = "Narendra Pydi"  (actual name from the tenant line)
    For property_name: return ONLY the official trade/marketing name of the building (e.g.
    "Markets at Choto", "The Commons"). If no such name is stated, return null. NEVER return
    clause text, parking clauses, or any phrase that contains the word "Tenant".

14. Multi-line labeled values: when an address spans several lines, join with commas.
    "Address: 123 Main St / Suite #100 / Cityville, ST 12345" -> "123 Main St, Suite #100, Cityville, ST 12345".

15. Premises Address vs Landlord Address vs Tenant Mailing Address:
    property_address / premises_address = the address of the LEASED PREMISES (where the tenant operates).
    In single-tenant office leases this often equals "Address of Tenant" (suite #).
    "Address of Landlord" is the landlord's mailing address - DO NOT use it as property_address.
    The "Building:" or "Premises:" line is the most authoritative source for property_address.

16. Universal document handling:
    Always extract explicit terms found in the uploaded document, whether it is a full lease, amendment,
    assignment, addendum, exhibit, abstract, image, PDF, DOCX, or plain text. Document type may guide
    field mapping, but it must never cause you to ignore explicit fields.

17. Assignment/amendment documents:
    Extract assignor, assignee/current tenant, landlord, lease date, premises size/address, assignment
    effective date, assumption language, landlord consent, amended expiration date, amended base rent,
    assignee notice address, assignment consideration, and all-other-terms-remain-unchanged language
    ONLY when explicitly stated. Do NOT infer CAM, taxes, insurance, utilities, or other expense recovery
    rules from "assumes all obligations" or "all other terms remain unchanged."

18. Short-value fields - do NOT return full clause text:
    permitted_use: Return ONLY the core activity (1-8 words). "restaurant", "IT work", "retail clothing sales".
       NOT the entire use clause paragraph. If the text describes restrictions ("shall not", "without prior written consent"),
       that is a USE RESTRICTION clause, NOT the permitted use - return null.
    renewal_options: Return a brief format like "2 - 5-year options" or "1 option for 3 years". NOT the full clause.
    assignment_provisions: Return 1-2 sentence summary. "Requires prior written landlord consent." NOT the full clause.
    property_name: Return the marketing name of the shopping center/building (e.g. "Markets at Choto"). NOT clause text, addresses, or party names.

19. TI allowance extraction:
    ti_allowance = TOTAL dollars, NOT the per-SF rate.
    If the document states "$24.00 per SF" AND also states the total (e.g. "$68,352"), return the TOTAL (68352).
    If ONLY the per-SF rate is given with no total calculated, return null for ti_allowance.

20. Person name fields - CRITICAL:
    tenant_contact_name and tenant_signatory_name must be a human name ONLY (e.g. "John Smith").
    NEVER return: clause text, verb phrases ("leases and accepts..."), party descriptions, or partial sentences.
    If you cannot find a clear human name in a signature block, return null.
    landlord_contact_name and landlord_signatory_name - same rule.

21. Numeric fields - return plain numbers, never sentence fragments:
    admin_fee_pct: Return only the number (e.g. 5 for "five percent (5%)"). NOT the full sentence.
    cam_cap_pct: Return only the cap percentage number. NOT the full sentence.
    late_fee_percent: Return only the percentage number.
    escalation_rate: Return only the percentage number.
    gross_up_threshold: Return only the percentage number (e.g. 95 for "grossed up to 95%").

22. security_deposit - CRITICAL:
    Return the TOTAL final dollar amount as a plain number.
    If a Security Deposit Addendum adds component amounts (e.g. "3rd month rent $6,004 + 86th month rent $6,904.60 = $12,908.60"), return the TOTAL (12908.60).
    NEVER return an intermediate component. If no deposit is mentioned, return null.

23. Dates - return YYYY-MM-DD only:
    commencement_date: The lease TERM start date. ONLY return a specific calendar date. If formulaic ("upon delivery", "upon C of O", "one day after X"), return null.
    expiration_date: The lease TERM end date. Only return a specific calendar date. If formulaic, return null.
    For date source_text: quote the exact labeled line (e.g. "Commencement Date: March 1, 2024") - 1 sentence max.`;

// -- Prompt builder for a field group -----------------------------------------

function buildFieldGroupPrompt(
  group: FieldGroup,
  fieldDefs: Record<string, FieldDef>,
  textSnippet: string,
  moduleType: string,
  isFileMode = false,
): string {
  const fieldDescriptions = group.fields
    .map((f) => {
      const def = fieldDefs[f];
      if (!def) return null;
      let desc = `  "${f}": ${def.description}`;
      if (def.type === "enum" && def.enumValues) {
        desc += ` (one of: ${def.enumValues.join(" | ")})`;
      }
      if (def.type === "date") desc += " (YYYY-MM-DD)";
      if (def.type === "number") desc += " (plain number, no $ or commas)";
      return desc;
    })
    .filter(Boolean)
    .join("\n");

  // OpenAI extraction in this pipeline consumes Azure-extracted text snippets,
  // not attached binary files. Keep prompts grounded in the text provided.
  const snippetLabel = isFileMode
    ? "TEXT EXCERPT FROM AZURE DOCUMENT INTELLIGENCE"
    : "TEXT SNIPPET (May contain OCR fragments/errors)";
  const importantNote = isFileMode
    ? "IMPORTANT: Use the Azure-extracted text provided below. Values such as rent schedules, security deposits, CAM caps, gross-up provisions, and escalation rates may appear later in the snippet; do not invent values that are not supported by the text."
    : "IMPORTANT: The text snippet may come from OCR and contain fragments or misread characters. Use context to infer the correct values where possible.";
  const noTextFallback = isFileMode
    ? "[No Azure-extracted text provided]"
    : "[No text provided]";

  return `Extract these ${moduleType} fields from the text below.
Context: ${group.hint}

FIELDS TO EXTRACT (return null if not found):
{
${fieldDescriptions}
}

${snippetLabel}:
---------------------------
${textSnippet || noTextFallback}
---------------------------

${importantNote}
For each field, return a JSON object with this EXACT shape:
{
  "value": <extracted value or null>,
  "source_text": "<exact quote from the lease text. Mandatory if value is found.>",
  "source_page": <page number or null>,
  "confidence": <0.0 to 1.0>
}
If you cannot find the exact source quote, return value as null. DO NOT paraphrase.
Return ONLY a JSON object with the field keys above mapped to these evidence objects. Nothing else.`;
}


// -- Prompt builder for multi-row extraction from table text -------------------

function buildMultiRowPrompt(
  fields: string[],
  fieldDefs: Record<string, FieldDef>,
  textSnippet: string,
  moduleType: string,
): string {
  const fieldDescriptions = fields
    .map((f) => {
      const def = fieldDefs[f];
      if (!def) return null;
      let desc = `  "${f}": ${def.description}`;
      if (def.type === "enum" && def.enumValues) {
        desc += ` (one of: ${def.enumValues.join(" | ")})`;
      }
      return desc;
    })
    .filter(Boolean)
    .join("\n");

  return `Extract ALL ${moduleType} records from the text below.
Each record should have ONLY these fields (null if missing):

{
${fieldDescriptions}
}

Return a JSON ARRAY of objects. Each distinct record = one object.
If there is only one record, still return an array with one object.

TEXT (May contain OCR fragments/errors):
---------------------------
${textSnippet}
---------------------------

IMPORTANT: The text snippet may come from OCR and contain fragments or misread characters. Carefully reconstruct the records from the fragments.

For each field in a record, return a JSON object with this EXACT shape:
{
  "value": <extracted value or null>,
  "source_text": "<exact quote from the lease text. Mandatory if value is found.>",
  "source_page": <page number or null>,
  "confidence": <0.0 to 1.0>
}
If you cannot find the exact source quote, return value as null. DO NOT paraphrase.
Return ONLY the JSON array of objects. Nothing else.`;
}


// -- Parse LLM response safely ------------------------------------------------

/**
 * Per-field evidence shape returned by the LLM under the new prompt:
 *   { value, source_text, source_page, confidence }
 * Legacy responses returning bare values are also accepted.
 */
type LlmFieldEvidence = {
  value: unknown;
  sourceText: string | null;
  sourcePage: number | null;
  confidence: number | null;
};

function normalizeLlmEvidence(raw: unknown): LlmFieldEvidence {
  if (raw == null) {
    return { value: null, sourceText: null, sourcePage: null, confidence: null };
  }
  if (typeof raw === "object" && !Array.isArray(raw) && ("value" in (raw as Record<string, unknown>))) {
    const obj = raw as Record<string, unknown>;
    const conf = obj.confidence;
    const sourceText = typeof obj.source_text === "string"
      ? obj.source_text.replace(/\s+/g, " ").trim().slice(0, 2400)
      : null;
    return {
      value: obj.value ?? null,
      sourceText: sourceText || null,
      sourcePage: Number.isFinite(Number(obj.source_page)) && Number(obj.source_page) > 0 ? Number(obj.source_page) : null,
      confidence: typeof conf === "number" && Number.isFinite(conf) ? Math.max(0, Math.min(1, conf > 1 ? conf / 100 : conf)) : null,
    };
  }
  // Legacy bare value
  return { value: raw, sourceText: null, sourcePage: null, confidence: null };
}

function parseLLMResponse(raw: unknown, expectedFields: string[]): Record<string, LlmFieldEvidence> | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const result: Record<string, LlmFieldEvidence> = {};
  for (const field of expectedFields) {
    result[field] = normalizeLlmEvidence(obj[field]);
  }
  return result;
}

function parseLLMArrayResponse(raw: unknown, expectedFields: string[]): Array<Record<string, LlmFieldEvidence>> {
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const obj = item as Record<string, unknown>;
      const result: Record<string, LlmFieldEvidence> = {};
      for (const field of expectedFields) {
        result[field] = normalizeLlmEvidence(obj[field]);
      }
      return result;
    });
}

// -- Diagnostic accumulator ----------------------------------------------------
// Carried through the entire LLM extraction step and returned in
// StepResult.diagnostics so the pipeline can forward them into
// extractionDebug without reading edge-function logs.

function makeDiag(input: ExtractionInput, _missingVars: string[]) {
  return {
    openai_config_present: !!Deno.env.get("OPENAI_API_KEY"),
    openai_config_missing_vars: Deno.env.get("OPENAI_API_KEY") ? [] : ["OPENAI_API_KEY"],
    // Presence of each relevant env var (values never logged).
    openai_env_keys_present: {
      OPENAI_API_KEY: !!Deno.env.get("OPENAI_API_KEY"),
      OPENAI_MODEL: !!Deno.env.get("OPENAI_MODEL"),
      OPENAI_MAX_OUTPUT_TOKENS: !!Deno.env.get("OPENAI_MAX_OUTPUT_TOKENS"),
    },
    model_name: null as string | null,
    llm_call_attempted: false,
    llm_file_mode_attempted: false,
    llm_text_mode_attempted: false,
    llm_raw_response_chars: 0,
    llm_json_parse_success: null as boolean | null,
    llm_json_parse_error: null as string | null,
    llm_json_repair_applied: false,
    llm_raw_response_preview: null as string | null,
    llm_fields_before_filter_count: 0,
    llm_empty_response_reason: null as string | null,
    fileBase64_available: Boolean(input.fileBase64),
    fileMimeType: input.fileMimeType ?? null,
    text_chars_sent_to_llm: 0,
    groups_attempted: 0,
    groups_succeeded: 0,
    groups_failed: [] as string[],
    llm_requested_fields: [] as string[],
    llm_returned_fields: [] as string[],
    llm_returned_field_details: {} as Record<string, Record<string, unknown>>,
    unmapped_llm_keys: [] as string[],
    call_errors: [] as string[],
  };
}

function recordLlmFieldTrace(
  diag: ReturnType<typeof makeDiag>,
  raw: unknown,
  expectedFields: string[],
) {
  const rows = Array.isArray(raw) ? raw : [raw];
  const expected = new Set(expectedFields);
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      if (!expected.has(key) && !diag.unmapped_llm_keys.includes(key)) {
        diag.unmapped_llm_keys.push(key);
      }
      const evidence = normalizeLlmEvidence(value);
      if (evidence.value != null && !diag.llm_returned_fields.includes(key)) {
        diag.llm_returned_fields.push(key);
      }
      diag.llm_returned_field_details[key] = {
        value: evidence.value ?? null,
        source_text: evidence.sourceText ?? null,
        source_page: evidence.sourcePage ?? null,
        confidence: evidence.confidence ?? null,
      };
    }
  }
}

// OpenAI call + JSON parse.
async function callOpenAIAndParse<T = unknown>(
  _input: ExtractionInput,
  opts: { systemPrompt: string; userPrompt: string; maxOutputTokens?: number; temperature?: number },
  diag: ReturnType<typeof makeDiag>,
  chunkIndex?: number,
): Promise<T | null> {
  diag.llm_call_attempted = true;
  diag.llm_text_mode_attempted = true;
  diag.text_chars_sent_to_llm += opts.userPrompt.length;

  try {
    const callOpts = {
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      temperature: opts.temperature,
      maxOutputTokens: opts.maxOutputTokens,
    };
    const response = _input.provenance
      ? await callLLMJSONWithProvenance(
        _input.provenance.supabaseAdmin,
        { ..._input.provenance.context, operation: "legacy_hybrid_field_group", chunkIndex },
        callOpts,
      )
      : await callLLMJSON(callOpts);

    if (!diag.model_name) diag.model_name = response.model;
    diag.llm_raw_response_chars += JSON.stringify(response.data ?? "").length;

    if (response.finishReason === "length") {
      console.warn(
        `[llm-extractor] OpenAI finish_reason=length; output may be truncated. ` +
        `model=${response.model}, completion_tokens=${response.completionTokens}`,
      );
    }

    if (response.data == null) {
      diag.llm_json_parse_success = false;
      diag.llm_empty_response_reason = "empty_content_from_openai";
      return null;
    }

    diag.llm_json_parse_success = true;
    return response.data as T;
  } catch (callErr) {
    const msg = String(callErr?.message ?? callErr);
    diag.call_errors.push(msg);
    diag.llm_empty_response_reason = diag.llm_empty_response_reason ?? `openai_call_error: ${msg.slice(0, 120)}`;
    throw callErr;
  }
}

// Unified LLM call - OpenAI only.

async function callLLMAndParse<T = unknown>(
  input: ExtractionInput,
  opts: { systemPrompt: string; userPrompt: string; maxOutputTokens?: number; temperature?: number },
  diag: ReturnType<typeof makeDiag>,
  chunkIndex?: number,
): Promise<T | null> {
  return callOpenAIAndParse<T>(input, opts, diag, chunkIndex);
}

// -- Main: LLM field-wise extraction ------------------------------------------

/**
 * Step 3 of the extraction pipeline.
 *
 * Only extracts fields that are MISSING from previous steps.
 * Uses targeted prompts with relevant text snippets.
 * Uses OpenAI for targeted field extraction.
 * Returns StepResult.diagnostics with full LLM call diagnostics so the
 * pipeline can surface them in extractionDebug.
 */
export async function extractWithLLM(
  input: ExtractionInput,
  docling: DoclingOutput,
  missingFields: string[],
  moduleType: ModuleType,
  existingRecords: ExtractedRecord[],
  options: { maxChunks?: number; temperature?: number } = {},
): Promise<StepResult> {
  const schema = getSchema(moduleType);
  const groups = getFieldGroups(moduleType);
  const warnings: string[] = [];
  const { maxChunks = 6, temperature = 0 } = options;

  const hasOpenAI = !!Deno.env.get("OPENAI_API_KEY");
  const diag = makeDiag(input, []);

  if (!hasOpenAI) {
    const msg = "OPENAI_API_KEY is not set. LLM extraction skipped. " +
      `Fields requiring AI: [${missingFields.join(", ")}].`;
    console.warn(`[llm-extractor] ${msg}`);
    warnings.push(msg);
    diag.llm_empty_response_reason = "no_llm_configured";
    return { records: [], warnings, diagnostics: diag };
  }

  if (missingFields.length === 0) {
    diag.llm_empty_response_reason = "no_missing_fields";
    return { records: [], warnings: ["No missing fields - LLM extraction skipped"], diagnostics: diag };
  }

  // Filter groups to only include groups with missing fields
  const relevantGroups = groups
    .map((g) => ({
      ...g,
      fields: g.fields.filter((f) => missingFields.includes(f)),
    }))
    .filter((g) => g.fields.length > 0);

  if (relevantGroups.length === 0) {
    diag.llm_empty_response_reason = "no_field_groups_match";
    return { records: [], warnings: ["No field groups match missing fields"], diagnostics: diag };
  }
  diag.llm_requested_fields = [...new Set(relevantGroups.flatMap((group) => group.fields))];

  // Determine extraction strategy:
  // - If we have existing multi-row records from tables, fill in missing fields per-group
  // - If no existing records, try multi-row extraction from chunks
  const isMultiRow = existingRecords.length > 1;

  if (isMultiRow) {
    return await fillMissingFieldsForRecords(
      input, docling, relevantGroups, schema, moduleType, existingRecords, temperature, warnings, diag,
    );
  }

  return await extractFieldGroups(
    input, docling, relevantGroups, schema, moduleType, missingFields, maxChunks, temperature, warnings, diag,
  );
}

// -- Strategy A: Fill missing fields for existing multi-row records ------------

async function fillMissingFieldsForRecords(
  input: ExtractionInput,
  docling: DoclingOutput,
  groups: FieldGroup[],
  schema: Record<string, FieldDef>,
  moduleType: ModuleType,
  existingRecords: ExtractedRecord[],
  temperature: number,
  warnings: string[],
  diag: ReturnType<typeof makeDiag>,
): Promise<StepResult> {
  const records: ExtractedRecord[] = [];

  // Collect all labels from the missing fields for snippet building
  const allLabels: string[] = [];
  for (const group of groups) {
    for (const f of group.fields) {
      if (schema[f]?.labels) allLabels.push(...schema[f].labels);
    }
  }

  for (const group of groups) {
    const snippet = buildRelevantSnippet(docling, allLabels, 24000);
    const prompt = buildMultiRowPrompt(group.fields, schema, snippet, moduleType);
    diag.groups_attempted += 1;
    // Note: buildMultiRowPrompt is for multi-record extraction; file-mode
    // directive is embedded in the system prompt (LLM_SYSTEM_PROMPT rule 16)
    // rather than repeated here to avoid conflicting instructions.

    try {
      const result = await callLLMAndParse(
        input,
        { systemPrompt: LLM_SYSTEM_PROMPT, userPrompt: prompt, maxOutputTokens: 4096, temperature },
        diag,
        diag.groups_attempted - 1,
      );

      if (result == null) {
        warnings.push(
          `LLM group "${group.name}" (multi-row) returned no parseable result. ` +
          `Reason: ${diag.llm_empty_response_reason ?? "unknown"}`,
        );
        diag.groups_failed.push(group.name);
        continue;
      }
      recordLlmFieldTrace(diag, result, group.fields);

      const parsed = parseLLMArrayResponse(result, group.fields);

      // Count non-null fields before the null-value filter
      const nonNullBefore = parsed.reduce(
        (sum, row) => sum + Object.values(row).filter((e) => e?.value != null).length, 0,
      );
      diag.llm_fields_before_filter_count += nonNullBefore;
      if (nonNullBefore === 0) {
        warnings.push(`LLM group "${group.name}" (multi-row) parsed successfully but all values are null.`);
        diag.groups_failed.push(group.name);
        continue;
      }
      diag.groups_succeeded += 1;

      // Map LLM rows back to existing record indices
      for (let i = 0; i < Math.min(parsed.length, existingRecords.length); i++) {
        if (!records[i]) {
          records[i] = { fields: {}, rowIndex: i };
        }
        for (const [field, evidence] of Object.entries(parsed[i])) {
          if (evidence?.value == null) continue;
          if (!evidence.sourceText) continue;
          records[i].fields[field] = {
            value: evidence.value,
            source: "llm",
            confidence: evidence.confidence ?? 0.70,
            sourceText: evidence.sourceText,
            sourcePage: evidence.sourcePage ?? null,
          };
        }
      }
    } catch (err) {
      const msg = `LLM group "${group.name}" (multi-row) failed: ${err.message}`;
      warnings.push(msg);
      diag.groups_failed.push(group.name);
    }
  }

  if (diag.llm_empty_response_reason == null && records.length === 0) {
    diag.llm_empty_response_reason = "all_groups_returned_null_or_zero_fields";
  }

  return { records, warnings, diagnostics: diag };
}

// -- Bounded concurrency helper ------------------------------------------------
// Runs `worker` for every item in `items`, keeping at most `limit` workers
// active simultaneously.  Output slots are pre-allocated so results come back
// in the original item order regardless of completion order.

type SettledResult<R> =
  | { status: "fulfilled"; value: R }
  | { status: "rejected"; reason: unknown };

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<SettledResult<R>>> {
  const results: Array<SettledResult<R>> = new Array(items.length);
  let cursor = 0;

  async function runLane(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = { status: "fulfilled", value: await worker(items[idx], idx) };
      } catch (err) {
        results[idx] = { status: "rejected", reason: err };
      }
    }
  }

  // Spawn min(limit, items.length) lanes and let them drain the work queue.
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runLane()),
  );
  return results;
}

// -- Concurrency ceiling -------------------------------------------------------
// Hard cap prevents runaway parallelism even if the env var is set higher.
// Raise the cap here (in code) if you ever have reason to exceed 3.
const MAX_ALLOWED_CONCURRENCY = 3;

function resolveConcurrencyLimit(): number {
  const raw = typeof Deno !== "undefined"
    ? Deno.env.get("LLM_GROUP_CONCURRENCY")
    : undefined;
  if (!raw) return MAX_ALLOWED_CONCURRENCY;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return MAX_ALLOWED_CONCURRENCY;
  return Math.min(parsed, MAX_ALLOWED_CONCURRENCY);
}

// -- Strategy B: Extract field groups for single-record documents --------------

async function extractFieldGroups(
  input: ExtractionInput,
  docling: DoclingOutput,
  groups: FieldGroup[],
  schema: Record<string, FieldDef>,
  moduleType: ModuleType,
  missingFields: string[],
  maxChunks: number,
  temperature: number,
  warnings: string[],
  diag: ReturnType<typeof makeDiag>,
): Promise<StepResult> {
  const concurrencyLimit = resolveConcurrencyLimit();
  const llmStartMs = Date.now();

  console.log(
    `[llm-extractor] extractFieldGroups: group_count=${groups.length} concurrency=${concurrencyLimit}`,
  );

  // Pre-build prompts so every group item is self-contained before dispatch.
  type GroupWork = {
    group: FieldGroup;
    prompt: string;
  };

  const workItems: GroupWork[] = groups.map((group) => {
    const labels: string[] = [];
    for (const f of group.fields) {
      if (schema[f]?.labels) labels.push(...schema[f].labels);
    }
    const snippet = buildRelevantSnippet(docling, labels, 24000);
    const prompt = buildFieldGroupPrompt(group, schema, snippet, moduleType, Boolean(input.fileBase64));
    return { group, prompt };
  });

  diag.groups_attempted += workItems.length;

  // Each worker returns the extracted field map for its group, or null on
  // failure. Errors are caught here so one group cannot cancel siblings.
  type GroupOutcome =
    | { ok: true; groupName: string; fields: Record<string, ExtractedField>; nonNullBefore: number }
    | { ok: false; groupName: string; warning: string; failTag?: string };

  const settled = await runWithConcurrency<GroupWork, GroupOutcome>(
    workItems,
    concurrencyLimit,
    async ({ group, prompt }, idx) => {
      const groupStartMs = Date.now();
      try {
        const result = await callLLMAndParse(
          input,
          { systemPrompt: LLM_SYSTEM_PROMPT, userPrompt: prompt, maxOutputTokens: 4096, temperature },
          diag,
          idx,
      );

        const groupMs = Date.now() - groupStartMs;
        console.log(`[llm-extractor] group "${group.name}" done in ${groupMs}ms`);

        if (result == null) {
          return {
            ok: false,
            groupName: group.name,
            warning:
              `LLM group "${group.name}" returned no parseable result. ` +
              `Reason: ${diag.llm_empty_response_reason ?? "unknown"}`,
          };
        }

        recordLlmFieldTrace(diag, result, group.fields);

        const parsed = parseLLMResponse(result, group.fields);
        if (!parsed) {
          return {
            ok: false,
            groupName: group.name,
            warning: `LLM group "${group.name}": response parsed but schema mapping returned null.`,
          };
        }

        const nonNullBefore = Object.values(parsed).filter((e) => e?.value != null).length;
        if (nonNullBefore === 0) {
          return {
            ok: false,
            groupName: group.name,
            warning: `LLM group "${group.name}" parsed successfully but all field values are null.`,
          };
        }

        const fields: Record<string, ExtractedField> = {};
        for (const [field, evidence] of Object.entries(parsed)) {
          if (evidence?.value == null) continue;
          if (!evidence.sourceText) continue;
          fields[field] = {
            value: evidence.value,
            source: "llm",
            confidence: evidence.confidence ?? 0.70,
            sourceText: evidence.sourceText,
            sourcePage: evidence.sourcePage ?? null,
          };
        }
        return { ok: true, groupName: group.name, fields, nonNullBefore };
      } catch (err) {
        const groupMs = Date.now() - groupStartMs;
        const errMsg = String(err?.message ?? err);
        // Detect OpenAI quota/rate limiting; do not retry, just tag and continue.
        const isQuota =
          errMsg.includes("429") ||
          /quota|rate.?limit|resource.?exhausted/i.test(errMsg);
        const failTag = isQuota ? "failed_openai_rate_limit" : undefined;
        console.warn(
          `[llm-extractor] group "${group.name}" ${isQuota ? "quota-exceeded" : "failed"} ` +
          `after ${groupMs}ms: ${errMsg.slice(0, 120)}`,
        );
        return {
          ok: false,
          groupName: group.name,
          warning: `LLM group "${group.name}" ${isQuota ? "[quota exceeded]" : "failed"}: ${errMsg}`,
          failTag,
        };
      }
    },
  );

  // Merge results in original group order (settled is pre-sorted by runWithConcurrency).
  const merged: Record<string, ExtractedField> = {};

  for (const result of settled) {
    if (result.status === "rejected") {
      // runWithConcurrency catches all errors inside the worker itself, so
      // this branch is defensive - the worker never throws past its try/catch.
      const errMsg = String((result.reason as any)?.message ?? result.reason);
      warnings.push(`LLM group worker threw unexpectedly: ${errMsg}`);
      continue;
    }
    const outcome = result.value;
    if (!outcome.ok) {
      warnings.push(outcome.warning);
      diag.groups_failed.push(
        outcome.failTag
          ? `${outcome.groupName}:${outcome.failTag}`
          : outcome.groupName,
      );
      continue;
    }
    diag.llm_fields_before_filter_count += outcome.nonNullBefore;
    diag.groups_succeeded += 1;
    // First-write wins: earlier groups (higher confidence by ordering) take priority.
    for (const [field, evidence] of Object.entries(outcome.fields)) {
      if (!merged[field]) merged[field] = evidence;
    }
  }

  const totalLlmMs = Date.now() - llmStartMs;
  console.log(
    `[llm-extractor] LLM extraction complete in ${totalLlmMs}ms ` +
    `(${diag.groups_succeeded} succeeded, ${diag.groups_failed.length} failed)`,
  );

  if (Object.keys(merged).length === 0) {
    if (diag.llm_empty_response_reason == null) {
      diag.llm_empty_response_reason = "all_groups_returned_null_or_zero_fields";
    }
    return { records: [], warnings, diagnostics: diag };
  }

  return {
    records: [{ fields: merged, rowIndex: 0 }],
    warnings,
    diagnostics: diag,
  };
}