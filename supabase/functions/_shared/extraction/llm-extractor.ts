// @ts-nocheck
/**
 * Extraction Pipeline — Step 3: LLM Fallback Extraction
 *
 * ONLY called for fields that Step 1 (rule) and Step 2 (table) could not extract.
 * Sends focused, field-wise prompts to Gemini with ONLY relevant text chunks.
 *
 * Key design rules:
 *   - NEVER pass entire document — only relevant chunks
 *   - Extract fields in small groups (3-7 fields per call)
 *   - Strict JSON output schema — no freeform text
 *   - NO calculations — LLM only reads raw values
 *   - If not found → null (never guess)
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
import { callVertexAI, callVertexAIWithFile, callVertexAIJSON, callVertexAIFileJSON } from "../vertex-ai.ts";

// ── System prompt — short, strict, no room for hallucination ─────────────────

const LLM_SYSTEM_PROMPT = `You are a CRE data extraction tool.
You extract ONLY the specific fields requested from the provided text snippet, with SOURCE EVIDENCE.

RULES:
1. Output ONLY valid JSON — no explanation, no markdown, no preamble.
2. For EVERY field requested, return an object of this shape:
     { "value": <extracted value or null>,
       "source_text": "<the exact phrase from the document you used, verbatim, or null>",
       "source_page": <page number if known, else null>,
       "confidence": <number 0.0–1.0> }
   The top-level JSON is { "<field_key>": { value, source_text, source_page, confidence }, ... }.
3. If a field is NOT found, return { "value": null, "source_text": null, "source_page": null, "confidence": 0 }.
4. NEVER guess, infer, or calculate values. Only extract what is explicitly stated.
5. NEVER calculate totals, annual amounts, or derived values.

6. ENTITY vs PERSON disambiguation — critical:
   tenant_name and landlord_name are LEGAL ENTITY names (LLC, Inc., Corp, Trust, individual property owner).
   Signatory / signer / "By:" lines belong to tenant_signatory_name or landlord_signatory_name, NEVER to *_name.

   EXAMPLES:
     Input:  "TENANT: Mindful Tech Solutions, Inc.   By: NARENDRA PYDI, President"
     Output: tenant_name.value = "Mindful Tech Solutions, Inc."
             tenant_signatory_name.value = "NARENDRA PYDI"

     Input:  "LANDLORD: 224 Partners, LLC   By: Jane Doe, Manager"
     Output: landlord_name.value = "224 Partners, LLC"
             landlord_signatory_name.value = "Jane Doe"

     Input:  "This Lease is between John Smith ('Landlord') and Acme Corp ('Tenant')"
     Output: landlord_name.value = "John Smith"  (the entity here is a natural person)
             tenant_name.value = "Acme Corp"

   When extracting tenant_name, look for the FIRST entity name following the word "Tenant" / "Lessee" / "Occupant",
   STOPPING at "By:" / "Signed:" / "Its:" / "Title:".

7. Date conventions:
   YYYY-MM-DD format. "January 1, 2024" → "2024-01-01".
   When the lease shows "commences on February 1, 2024 and ends January 31" with year elided,
   the end year is one year AFTER the commencement year unless the lease explicitly says otherwise.
   So "commences February 1, 2024 and ends January 31" → end_date.value = "2025-01-31".
   If unsure of the year, leave value null with confidence 0.

8. Monthly vs Annual rent:
   Only put a value in monthly_rent if the lease explicitly says "per month" / "monthly" / "$X/mo".
   Only put a value in annual_rent if the lease explicitly says "per year" / "annually" / "p.a." / "/yr".
   If only one is present, leave the other's value null.

9. Square footage scope:
   square_footage / rentable_area_sqft = the LEASED PREMISES area (tenant's space).
   NEVER use building total, complex total, gross leasable area for the whole project.
   Look for "Premises containing approximately X rentable square feet" or "Leased Premises: X SF".

10. Monetary values: plain numbers only. "$12,500" → 12500.
11. Percentages: plain number. "3%" → 3.
12. source_text MUST BE THE EXACT VERBATIM text from the document snippet. NEVER paraphrase your reasoning. NEVER explain how you derived the value.
    If you derived the value from a specific phrase (e.g. extracting Tenant from "Assignee: John"), the source_text MUST BE the exact phrase "Assignee: John".
    If the text is OCR-garbled, return the garbled text exactly as it appears.

13. Numbered-summary documents are common — leases often start with a section like:
        "1. Date: January 9, 2024
         2. Landlord: 224 Partners, LLC
         3. Address of Landlord: 224 S Peters Road, Suite 212 Knoxville, TN 37923
         4. Tenant: Mindful Tech Solutions, Inc.
         5. Address of Tenant: 224 S Peters Road Suite #211 Knoxville, TN 37923
         6. Premises: 1,110 rentable square feet
         9. Rent: $1,400 per month
         10. Permitted Use: IT work"
    The label after the number IS the field label. Extract from these lines even though they don't say
    "Landlord Name:" or "Property Address:" verbatim.

14. Multi-line labeled values: when an address spans several lines, join with commas.
    "Address: 224 S Peters Road / Suite #211 / Knoxville, TN 37923" → "224 S Peters Road, Suite #211, Knoxville, TN 37923".

15. Premises Address vs Landlord Address vs Tenant Mailing Address:
    property_address / premises_address = the address of the LEASED PREMISES (where the tenant operates).
    In single-tenant office leases this often equals "Address of Tenant" (suite #).
    "Address of Landlord" is the landlord's mailing address — DO NOT use it as property_address.
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
    rules from "assumes all obligations" or "all other terms remain unchanged."`;

// ── Prompt builder for a field group ─────────────────────────────────────────

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

  // When file bytes are attached (isFileMode), the text snippet is often only
  // page 1 of a multi-page PDF. Explicitly direct the model to use the full
  // attached document so values on pages 2+ are not missed.
  const snippetLabel = isFileMode
    ? "TEXT EXCERPT — page 1 only (values may be on later pages; use the ATTACHED PDF)"
    : "TEXT SNIPPET (May contain OCR fragments/errors)";
  const importantNote = isFileMode
    ? "IMPORTANT: The COMPLETE lease document is attached as a PDF. Extract values from the ATTACHED FILE — do not limit yourself to the text excerpt above. Values such as rent schedules, security deposits, CAM caps, gross-up provisions, and escalation rates are often on pages 2 or later and are only in the attached file. Use the text excerpt as a supplement, not the sole source."
    : "IMPORTANT: The text snippet may come from OCR and contain fragments or misread characters. Use context to infer the correct values where possible.";
  const noTextFallback = isFileMode
    ? "(No extracted text — use the ATTACHED PDF document exclusively)"
    : "[No text provided, refer to the attached visual document]";

  return `Extract these ${moduleType} fields from the text below.
Context: ${group.hint}

FIELDS TO EXTRACT (return null if not found):
{
${fieldDescriptions}
}

${snippetLabel}:
───────────────────────────
${textSnippet || noTextFallback}
───────────────────────────

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


// ── Prompt builder for multi-row extraction from table text ───────────────────

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
───────────────────────────
${textSnippet}
───────────────────────────

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


// ── Parse LLM response safely ────────────────────────────────────────────────

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
    return {
      value: obj.value ?? null,
      sourceText: typeof obj.source_text === "string" ? (obj.source_text as string).slice(0, 400) : null,
      sourcePage: typeof obj.source_page === "number" && Number.isFinite(obj.source_page) ? Number(obj.source_page) : null,
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

// ── Diagnostic accumulator ────────────────────────────────────────────────────
// Carried through the entire LLM extraction step and returned in
// StepResult.diagnostics so the pipeline can forward them into
// extractionDebug without reading edge-function logs.

function makeDiag(input: ExtractionInput, missingVars: string[]) {
  return {
    vertex_config_present:
      (!!Deno.env.get("VERTEX_PROJECT_ID") || !!Deno.env.get("GOOGLE_PROJECT_ID")) &&
      (!!Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || (!!Deno.env.get("GOOGLE_CLIENT_EMAIL") && !!Deno.env.get("GOOGLE_PRIVATE_KEY"))),
    vertex_config_missing_vars: missingVars,
    // Presence of each relevant env var (values never logged).
    vertex_env_keys_present: {
      VERTEX_PROJECT_ID: !!Deno.env.get("VERTEX_PROJECT_ID"),
      GOOGLE_PROJECT_ID: !!Deno.env.get("GOOGLE_PROJECT_ID"),
      VERTEX_LOCATION: !!Deno.env.get("VERTEX_LOCATION"),
      GOOGLE_SERVICE_ACCOUNT_KEY: !!Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY"),
      GOOGLE_CLIENT_EMAIL: !!Deno.env.get("GOOGLE_CLIENT_EMAIL"),
      GOOGLE_PRIVATE_KEY: !!Deno.env.get("GOOGLE_PRIVATE_KEY"),
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

// ── Diagnostic-aware Vertex call + JSON parse ─────────────────────────────────
// Replaces direct callVertexAIJSON / callVertexAIFileJSON inside the extraction
// loops so we can capture: raw response chars, parse success/fail, repair
// applied, raw preview on failure — all without touching vertex-ai.ts API.

function repairTruncatedJson(text: string): string | null {
  const lastClose = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (lastClose < 0) return null;
  return text.slice(0, lastClose + 1);
}

async function callVertexAndParse<T = unknown>(
  input: ExtractionInput,
  opts: { systemPrompt: string; userPrompt: string; maxOutputTokens?: number; temperature?: number },
  diag: ReturnType<typeof makeDiag>,
): Promise<T | null> {
  const isFileMode = Boolean(input.fileBase64);
  diag.llm_call_attempted = true;
  if (isFileMode) {
    diag.llm_file_mode_attempted = true;
  } else {
    diag.llm_text_mode_attempted = true;
    diag.text_chars_sent_to_llm += opts.userPrompt.length;
  }

  let rawContent: string;
  let modelUsed: string;

  try {
    if (isFileMode) {
      const resp = await callVertexAIWithFile({
        ...opts,
        fileBase64: input.fileBase64,
        fileMimeType: input.fileMimeType || "application/pdf",
      });
      rawContent = resp.content;
      modelUsed = resp.model;
    } else {
      const resp = await callVertexAI(opts);
      rawContent = resp.content;
      modelUsed = resp.model;
    }
  } catch (callErr) {
    const msg = String(callErr?.message ?? callErr);
    diag.call_errors.push(msg);
    diag.llm_empty_response_reason = diag.llm_empty_response_reason ?? `vertex_call_error: ${msg.slice(0, 120)}`;
    throw callErr;
  }

  if (!diag.model_name) diag.model_name = modelUsed;

  // Strip code fences the model sometimes adds despite responseMimeType=json
  let text = rawContent.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  diag.llm_raw_response_chars += text.length;

  if (!text) {
    diag.llm_json_parse_success = false;
    diag.llm_empty_response_reason = diag.llm_empty_response_reason
      ?? `empty_content_from_model_${modelUsed}`;
    console.warn(`[llm-extractor] ${isFileMode ? "file" : "text"} mode: empty response from ${modelUsed}`);
    return null;
  }

  // Attempt JSON parse
  try {
    const parsed = JSON.parse(text) as T;
    diag.llm_json_parse_success = true;
    return parsed;
  } catch (parseErr) {
    // Attempt truncation repair
    const repaired = repairTruncatedJson(text);
    if (repaired) {
      try {
        const parsed = JSON.parse(repaired) as T;
        diag.llm_json_parse_success = true;
        diag.llm_json_repair_applied = true;
        console.warn(
          `[llm-extractor] Repaired truncated JSON (orig ${text.length} chars, model=${modelUsed})`,
        );
        return parsed;
      } catch {
        // fall through to full failure
      }
    }
    const preview = text.slice(0, 300);
    diag.llm_json_parse_success = false;
    diag.llm_json_parse_error = String(parseErr?.message ?? parseErr);
    diag.llm_raw_response_preview = preview;
    diag.llm_empty_response_reason = diag.llm_empty_response_reason ?? "json_parse_failed";
    console.error(
      `[llm-extractor] JSON parse failed (model=${modelUsed}, ${text.length} chars). ` +
      `Error: ${parseErr?.message}. Preview: ${preview}`,
    );
    return null;
  }
}

// ── Main: LLM field-wise extraction ──────────────────────────────────────────

/**
 * Step 3 of the extraction pipeline.
 *
 * Only extracts fields that are MISSING from previous steps.
 * Uses targeted prompts with relevant text snippets.
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

  // Collect which Vertex config vars are missing (regardless of whether
  // hasVertexAI ends up true, so we always have a diagnostic).
  const missingVars: string[] = [];
  if (!Deno.env.get("VERTEX_PROJECT_ID") && !Deno.env.get("GOOGLE_PROJECT_ID")) {
    missingVars.push("VERTEX_PROJECT_ID (or GOOGLE_PROJECT_ID)");
  }
  if (!Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") && !(Deno.env.get("GOOGLE_CLIENT_EMAIL") && Deno.env.get("GOOGLE_PRIVATE_KEY"))) {
    missingVars.push("GOOGLE_SERVICE_ACCOUNT_KEY (or GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY)");
  }

  const hasVertexAI = missingVars.length === 0;
  const diag = makeDiag(input, missingVars);

  if (!hasVertexAI) {
    const msg =
      `Vertex AI not configured — missing env vars: [${missingVars.join(", ")}]. ` +
      `LLM extraction skipped. Fields requiring AI: [${missingFields.join(", ")}].`;
    console.warn(`[llm-extractor] ${msg}`);
    warnings.push(msg);
    diag.llm_empty_response_reason = "vertex_not_configured";
    return { records: [], warnings, diagnostics: diag };
  }

  if (missingFields.length === 0) {
    diag.llm_empty_response_reason = "no_missing_fields";
    return { records: [], warnings: ["No missing fields — LLM extraction skipped"], diagnostics: diag };
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
  // - If we have existing multi-row records from tables → fill in missing fields per-group
  // - If no existing records → try multi-row extraction from chunks
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

// ── Strategy A: Fill missing fields for existing multi-row records ────────────

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
    const snippet = buildRelevantSnippet(docling, allLabels, 16000);
    const prompt = buildMultiRowPrompt(group.fields, schema, snippet, moduleType);
    diag.groups_attempted += 1;
    // Note: buildMultiRowPrompt is for multi-record extraction; file-mode
    // directive is embedded in the system prompt (LLM_SYSTEM_PROMPT rule 16)
    // rather than repeated here to avoid conflicting instructions.

    try {
      const result = await callVertexAndParse(
        input,
        { systemPrompt: LLM_SYSTEM_PROMPT, userPrompt: prompt, maxOutputTokens: 4096, temperature },
        diag,
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
          records[i].fields[field] = {
            value: evidence.value,
            source: "llm",
            confidence: evidence.confidence ?? 0.70,
            sourceText: evidence.sourceText ?? `LLM extracted (group: ${group.name})`,
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

// ── Strategy B: Extract field groups for single-record documents ──────────────

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
  const merged: Record<string, ExtractedField> = {};

  for (const group of groups) {
    // Collect labels for this group's fields
    const labels: string[] = [];
    for (const f of group.fields) {
      if (schema[f]?.labels) labels.push(...schema[f].labels);
    }

    // Build a focused snippet instead of sending entire chunks
    const snippet = buildRelevantSnippet(docling, labels, 16000);
    const prompt = buildFieldGroupPrompt(group, schema, snippet, moduleType, Boolean(input.fileBase64));
    diag.groups_attempted += 1;

    try {
      const result = await callVertexAndParse(
        input,
        { systemPrompt: LLM_SYSTEM_PROMPT, userPrompt: prompt, maxOutputTokens: 2048, temperature },
        diag,
      );

      if (result == null) {
        warnings.push(
          `LLM group "${group.name}" returned no parseable result. ` +
          `Reason: ${diag.llm_empty_response_reason ?? "unknown"}`,
        );
        diag.groups_failed.push(group.name);
        continue;
      }
      recordLlmFieldTrace(diag, result, group.fields);

      const parsed = parseLLMResponse(result, group.fields);
      if (!parsed) {
        warnings.push(`LLM group "${group.name}": response parsed but schema mapping returned null.`);
        diag.groups_failed.push(group.name);
        continue;
      }

      // Count non-null fields before the null-value filter below
      const nonNullBefore = Object.values(parsed).filter((e) => e?.value != null).length;
      diag.llm_fields_before_filter_count += nonNullBefore;
      if (nonNullBefore === 0) {
        warnings.push(`LLM group "${group.name}" parsed successfully but all field values are null.`);
        diag.groups_failed.push(group.name);
        continue;
      }
      diag.groups_succeeded += 1;

      for (const [field, evidence] of Object.entries(parsed)) {
        if (evidence?.value == null) continue;
        if (merged[field]) continue;
        merged[field] = {
          value: evidence.value,
          source: "llm",
          confidence: evidence.confidence ?? 0.70,
          sourceText: evidence.sourceText ?? `LLM extracted (group: ${group.name})`,
          sourcePage: evidence.sourcePage ?? null,
        };
      }
    } catch (err) {
      const msg = `LLM group "${group.name}" failed: ${err.message}`;
      warnings.push(msg);
      diag.groups_failed.push(group.name);
    }
  }

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
