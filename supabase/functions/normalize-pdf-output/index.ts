// @ts-nocheck
// v4 — lease_date in dates group; monthly_rent min=1; lease_type enum description
/**
 * normalize-pdf-output — Step 3 of the canonical pipeline
 *
 * Input:  uploaded_files row in status='pdf_parsed' with `docling_raw`
 * Output: uploaded_files row in status='review_required' or 'validated',
 *         with `normalized_output`, `ui_review_payload`, and `parsed_data`
 *         populated so store-data / the reviewer can pick up from here.
 *
 * This function is now a THIN orchestrator over `runExtractionPipeline()`
 * — it no longer owns any extraction logic of its own. All rule/table/LLM
 * work happens inside `_shared/extraction/pipeline.ts`, which is the one
 * and only extraction engine in the system.
 *
 * Review gate:
 *   - If uploaded_files.review_required = TRUE  → status := 'review_required'
 *     (the reviewer will call review-approve which flips to 'approved' and
 *      fires validate-data / store-data).
 *   - Otherwise                                  → status := 'validated'
 *     (validate-data / store-data run automatically via the existing chain).
 */

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { runExtractionPipeline } from "../_shared/extraction/pipeline.ts";
import { getSchema } from "../_shared/extraction/schemas.ts";
import { buildLeaseWorkflowAbstraction } from "../_shared/extraction/lease-workflow.ts";
import { setStatus, setFailed } from "../_shared/pipeline-status.ts";
import type { ModuleType as ExtractionModuleType } from "../_shared/extraction/types.ts";

function toExtractionModuleType(moduleType: string): ExtractionModuleType {
  switch (moduleType) {
    case "leases": return "lease";
    case "expenses": return "expense";
    case "invoices": return "expense";
    case "properties": return "property";
    case "revenue": return "revenue";
    case "building":
    case "buildings": return "building";
    case "unit":
    case "units": return "unit";
    case "tenant":
    case "tenants": return "tenant";
    case "gl_account":
    case "gl_accounts": return "gl_account";
    default: return "property";
  }
}

function buildFallbackReviewRow(moduleType: string): Record<string, unknown> {
  switch (moduleType) {
    case "lease":
    case "leases":
      return {
        tenant_name: null,
        landlord_name: null,
        property_name: null,
        property_address: null,
        assignor_name: null,
        assignee_name: null,
        assignment_effective_date: null,
        landlord_consent: null,
        assumption_scope: null,
        assignee_notice_address: null,
        unit_number: null,
        start_date: null,
        end_date: null,
        monthly_rent: null,
        annual_rent: null,
        lease_term_months: null,
        rent_per_sf: null,
        square_footage: null,
        lease_type: null,
        security_deposit: null,
        cam_amount: null,
        escalation_rate: null,
        renewal_options: null,
        ti_allowance: null,
        free_rent_months: null,
        status: null,
        notes: null,
      };
    case "expenses":
    case "invoices":
      return {
        vendor: null,
        invoice_number: null,
        date: null,
        amount: null,
        category: null,
        classification: null,
        description: null,
      };
    case "properties":
      return { name: null, address: null, city: null, state: null, zip: null, total_sqft: null };
    default:
      return { notes: null };
  }
}

/**
 * Find the docling page number that contains a given source snippet. Used
 * to back-fill source_page when an LLM or workflow extractor returned a
 * source_text but did not stamp the page. Returns null if no match.
 */
function findPageForSnippet(doclingRaw: Record<string, unknown> | null | undefined, snippet: string): number | null {
  if (!doclingRaw || !snippet) return null;
  const trimmed = String(snippet).trim();
  if (trimmed.length < 8) return null;
  // Anchor on the first ~60 characters; matching longer substrings is fragile
  // because the LLM frequently lightly paraphrases or trims whitespace.
  const probe = trimmed.slice(0, Math.min(80, trimmed.length)).toLowerCase();
  const blocks = Array.isArray((doclingRaw as any)?.text_blocks) ? (doclingRaw as any).text_blocks : [];
  for (const block of blocks) {
    const text = String(block?.text || "").toLowerCase();
    if (!text) continue;
    const page = Number(block?.page ?? block?.page_number ?? block?.source_page);
    if (!Number.isFinite(page)) continue;
    if (text.includes(probe)) return page;
  }
  // Fall back to docling fields (key/value pairs with page numbers).
  const fields = Array.isArray((doclingRaw as any)?.fields) ? (doclingRaw as any).fields : [];
  for (const field of fields) {
    const value = String(field?.value || field?.text || "").toLowerCase();
    if (!value) continue;
    const page = Number(field?.page ?? field?.page_number ?? field?.source_page);
    if (!Number.isFinite(page)) continue;
    if (value.includes(probe) || probe.includes(value)) return page;
  }
  return null;
}

function isGenericSourceText(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  if (/^(llm extracted|extracted|manual_review|not found|unknown|n\/a|na|null)$/i.test(text)) return true;
  if (lower.includes("derived from")) return true;
  if (/^[a-z][a-z0-9_]*_[a-z0-9_]*\s*:\s*/i.test(text)) return true;
  if (/^[a-z][a-z0-9_]{2,60}$/.test(text)) return true;
  return false;
}

function usableSourceText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return isGenericSourceText(text) ? null : text;
}

function workflowFieldFor(fieldKey: string, leaseFields: Record<string, any> = {}) {
  const aliases: Record<string, string[]> = {
    property_address: ["property_address", "premises_address"],
    square_footage: ["square_footage", "rentable_area_sqft", "tenant_rsf"],
    tenant_name: ["tenant_name", "assignee_name"],
    commencement_date: ["commencement_date", "start_date"],
    start_date: ["start_date", "commencement_date"],
    annual_rent: ["annual_rent", "amended_base_rent_for_additional_year"],
    monthly_rent: ["monthly_rent", "base_rent_monthly"],
    billing_frequency: ["billing_frequency", "rent_frequency"],
    expiration_date: ["expiration_date", "end_date", "amended_expiration_date"],
    end_date: ["end_date", "expiration_date", "amended_expiration_date"],
    admin_fee_pct: ["admin_fee_pct", "admin_fee_percent"],
    gross_up_threshold: ["gross_up_threshold", "gross_up_percent", "gross_up_target_occupancy_pct"],
    cam_cap_pct: ["cam_cap_pct", "cam_cap_percent", "cap_percent"],
    responsibility_taxes: ["responsibility_taxes", "tax_responsibility"],
    responsibility_insurance: ["responsibility_insurance", "insurance_responsibility"],
    responsibility_utilities: ["responsibility_utilities", "utilities_responsibility"],
    responsibility_repairs: ["responsibility_repairs", "maintenance_responsibility"],
  };
  for (const key of aliases[fieldKey] || [fieldKey]) {
    if (leaseFields?.[key]) return leaseFields[key];
  }
  return leaseFields?.[fieldKey] ?? null;
}

/**
 * Build the review payload consumed by the frontend review screen.
 * Structured so the UI can render a field-by-field grid with source and
 * confidence badges, and so we can diff it after the reviewer edits.
 */
function buildReviewPayload(opts: {
  fileId: string;
  fileName: string;
  moduleType: string;
  documentSubtype: string | null;
  extractionMethod: string | null;
  reviewRequired: boolean;
  doclingRaw?: Record<string, unknown> | null;
  result: {
    rows: Record<string, unknown>[];
    method: string;
    warnings: string[];
    validationErrors: unknown[];
    metadata: Record<string, unknown>;
  };
}) {
  const { fileId, fileName, moduleType, documentSubtype, extractionMethod, reviewRequired, doclingRaw, result } = opts;
  const extractionModuleType = toExtractionModuleType(moduleType);
  const schema = getSchema(extractionModuleType);
  const schemaEntries = Object.entries(schema)
    .filter(([, def]) => !def.derived);
  const schemaKeys = new Set(schemaEntries.map(([key]) => key));
  const requiredFields = schemaEntries
    .filter(([, def]) => def.required)
    .map(([key]) => key);
  const avgConfidence = normalizeConfidence(result.metadata?.avgConfidence);
  const source = sourceFromMethod(extractionMethod ?? result.method);
  const workflowOutputs = extractionModuleType === "lease"
    ? result.rows.map((row) =>
        buildLeaseWorkflowAbstraction({
          row,
          doclingRaw: doclingRaw ?? null,
          documentSubtype,
        })
      )
    : [];
  const rows = result.rows.map((r, index) => {
    const values = stripInternalKeys(r);
    if ((moduleType === "leases" || moduleType === "lease") && isBlank(values.notes)) {
      const camNote = extractCamNoteFromText(doclingRaw);
      if (camNote) values.notes = camNote;
    }
    const fieldConfidences = (r._field_confidences ?? {}) as Record<string, number>;
    const fieldSources = (r._field_sources ?? {}) as Record<string, string>;
    const fieldEvidence = (r._field_evidence ?? {}) as Record<string, { source_text?: string | null; source_page?: number | null }>;
    const rowConfidence = normalizeConfidence(
      r.confidence_score ?? result.metadata?.avgConfidence,
    ) ?? avgConfidence;
    const workflowOutput = workflowOutputs[index] ?? null;
    const standardFields = schemaEntries.map(([fieldKey, def]) => {
      const workflowField = workflowFieldFor(fieldKey, workflowOutput?.lease_fields ?? {});
      const value = values[fieldKey] ?? workflowField?.value ?? null;
      // Prefer evidence produced by the LLM/rule extractor; fall back to the
      // workflow's snippet match. This is what makes Raw Extracted / Source
      // Page / Exact Source Text light up in the Lease Review table.
      const llmEvidence = fieldEvidence[fieldKey];
      let mergedSourcePage =
        llmEvidence?.source_page
        ?? workflowField?.source_page
        ?? null;
      const mergedSourceText =
        usableSourceText(llmEvidence?.source_text)
        ?? usableSourceText(workflowField?.source_clause)
        ?? null;
      // Page back-fill: when we have a clause snippet but no page number,
      // search docling's per-page text_blocks for the snippet and assign the
      // matching page. Prevents Page from being blank when source text is
      // clearly identifiable in the parsed document.
      if (mergedSourcePage == null && typeof mergedSourceText === "string" && mergedSourceText.trim().length > 0) {
        const matchedPage = findPageForSnippet(doclingRaw, mergedSourceText);
        if (matchedPage != null) mergedSourcePage = matchedPage;
      }
      const hasEvidence = mergedSourcePage != null || (typeof mergedSourceText === "string" && mergedSourceText.length > 0);
      const effectiveConfidence = normalizeConfidence(fieldConfidences[fieldKey]) ?? rowConfidence;
      let inferredStatus = value == null || value === ""
        ? "missing"
        : hasEvidence
          ? (workflowField?.extraction_status === "calculated" ? "calculated" : "extracted")
          : "missing_source_evidence";
      // Low-confidence gate: never present a low-confidence value as a
      // confirmed extraction. Downgrade to needs_review so the UI shows the
      // value as a reviewer candidate, not a green Extracted badge.
      if (
        (inferredStatus === "extracted" || workflowField?.extraction_status === "extracted") &&
        typeof effectiveConfidence === "number" &&
        effectiveConfidence < 0.55
      ) {
        inferredStatus = "needs_review";
      }
      const workflowStatus = String(workflowField?.extraction_status ?? "").toLowerCase();
      const finalStatus =
        inferredStatus === "needs_review"
          ? "needs_review"
          : workflowStatus === "calculated"
            ? "calculated"
            : workflowStatus === "manual_required"
              ? "manual_required"
              : inferredStatus;
      return buildReviewField({
        recordIndex: index,
        fieldKey,
        value,
        confidence: effectiveConfidence,
        source: fieldSources[fieldKey] ?? source,
        isStandard: true,
        required: !!def.required,
        fieldType: def.type ?? "string",
        description: def.description,
        evidence: {
          page_number: mergedSourcePage,
          source_clause: mergedSourceText,
        },
        status: finalStatus,
        editable: workflowField?.editable ?? true,
      });
    });
    const customFieldsFromRows = Object.entries(values)
      .filter(([key]) => !schemaKeys.has(key) && !isInternalReviewKey(key))
      .map(([fieldKey, value]) =>
        buildReviewField({
          recordIndex: index,
          fieldKey,
          value,
          confidence: normalizeConfidence(fieldConfidences[fieldKey]) ?? rowConfidence,
          source: fieldSources[fieldKey] ?? source,
          isStandard: false,
          required: false,
          fieldType: inferFieldType(value),
          description: "Useful extracted content that does not map to a standard field.",
        })
      );
    const customFieldsFromDocument = buildCustomFieldsFromDocument({
      doclingRaw,
      schema,
      schemaKeys,
      recordIndex: index,
      existingKeys: new Set(customFieldsFromRows.map((field) => normalizeKey(field.field_key))),
      standardValues: values,
    });
    const customFields = [...customFieldsFromRows, ...customFieldsFromDocument];
    const missingRequired = requiredFields.filter((field) => isBlank(values[field]));

    return {
      row_index: index,
      record_index: index,
      values,
      fields: Object.fromEntries(
        [...standardFields, ...customFields].map((field) => [
          field.field_key,
          {
            value: field.value,
            confidence: field.confidence,
            source: field.source,
            evidence: field.evidence,
            status: field.status,
          },
        ]),
      ),
      standard_fields: standardFields,
      custom_fields: customFields,
      missing_required: missingRequired,
      rejected_fields: [],
      warnings: missingRequired.length > 0
        ? [`Missing required fields: ${missingRequired.join(", ")}`]
        : [],
      confidence: rowConfidence,
      notes: (r.extraction_notes as string | undefined) ?? null,
      workflow_output: workflowOutput,
    };
  });

  const workflowSummary = extractionModuleType === "lease"
    ? {
        records: workflowOutputs,
        summary: {
          extracted_field_count: workflowOutputs.reduce((sum, item) => sum + (item?.summary?.extracted_field_count ?? 0), 0),
          calculated_field_count: workflowOutputs.reduce((sum, item) => sum + (item?.summary?.calculated_field_count ?? 0), 0),
          manual_required_count: workflowOutputs.reduce((sum, item) => sum + (item?.summary?.manual_required_count ?? 0), 0),
          conflict_count: workflowOutputs.reduce((sum, item) => sum + (item?.summary?.conflict_count ?? 0), 0),
          clause_count: workflowOutputs.reduce((sum, item) => sum + (item?.summary?.clause_count ?? 0), 0),
          extracted_document_item_count: workflowOutputs.reduce((sum, item) => sum + (item?.summary?.extracted_document_item_count ?? 0), 0),
          expense_rule_count: workflowOutputs.reduce((sum, item) => sum + (item?.summary?.expense_rule_count ?? 0), 0),
        },
      }
    : null;

  const userWarnings = filterUserWarnings(result.warnings, result.rows.length);

  return {
    schema_version: 2,
    file_id: fileId,
    file_name: fileName,
    module_type: moduleType,
    document_subtype: documentSubtype,
    extraction_method: extractionMethod ?? result.method,
    pipeline_method: result.method,
    avg_confidence: avgConfidence,
    review_required: reviewRequired,
    review_status: "pending",
    records: rows,
    rows,
    global_warnings: userWarnings,
    warnings: userWarnings,
    validation_errors: result.validationErrors,
    metadata: {
      ...(result.metadata ?? {}),
      workflow_output: workflowSummary,
    },
    built_at: new Date().toISOString(),
  };
}

function filterUserWarnings(warnings: string[] = [], rowCount = 0): string[] {
  const out: string[] = [];
  for (const warning of warnings) {
    const text = String(warning || "");
    if (rowCount > 0 && /no tables found/i.test(text)) continue;
    if (rowCount > 0 && /GOOGLE_SERVICE_ACCOUNT_KEY|service account|private_key|JWT|Vertex AI|AI fallback/i.test(text)) {
      continue;
    }
    if (/GOOGLE_SERVICE_ACCOUNT_KEY|service account|private_key|JWT/i.test(text)) {
      const sanitized = "AI fallback extraction is unavailable because Google Vertex AI is not fully configured. Deterministic document parsing still ran.";
      if (!out.includes(sanitized)) out.push(sanitized);
      continue;
    }
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function buildReviewField(opts: {
  recordIndex: number;
  fieldKey: string;
  value: unknown;
  confidence: number | null;
  source: string;
  isStandard: boolean;
  required: boolean;
  fieldType: string;
  description?: string;
  evidence?: Record<string, unknown> | null;
  status?: string;
  editable?: boolean;
}) {
  const blank = isBlank(opts.value);
  return {
    id: `${opts.recordIndex}:${opts.isStandard ? "standard" : "custom"}:${opts.fieldKey}`,
    field_key: opts.fieldKey,
    label: humanizeFieldName(opts.fieldKey),
    value: opts.value ?? null,
    original_value: opts.value ?? null,
    field_type: opts.fieldType,
    description: opts.description ?? null,
    required: opts.required,
    is_standard: opts.isStandard,
    confidence: opts.confidence,
    source: blank ? "system" : opts.source,
    evidence: opts.evidence ?? null,
    editable: opts.editable ?? true,
    extraction_status: opts.status ?? (blank ? "not_found" : "extracted"),
    status: opts.status ?? (blank ? "missing" : "pending"),
    accepted: false,
    rejected: false,
    user_edit: null,
  };
}

function stripInternalKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
}

function isInternalReviewKey(key: string): boolean {
  return [
    "confidence_score",
    "extraction_notes",
    "_field_confidences",
    "_field_sources",
    "source",
    "warnings",
    "validation_errors",
  ].includes(key);
}

function buildCustomFieldsFromDocument(args: {
  doclingRaw?: Record<string, unknown> | null;
  schema: Record<string, any>;
  schemaKeys: Set<string>;
  recordIndex: number;
  existingKeys: Set<string>;
  standardValues: Record<string, unknown>;
}) {
  const { doclingRaw, schema, schemaKeys, recordIndex, existingKeys, standardValues } = args;
  if (!doclingRaw) return [];

  const standardAliases = buildStandardAliases(schema);
  const candidates: Array<{ key: string; value: unknown; confidence: number; source: string }> = [];

  for (const field of Array.isArray((doclingRaw as any).fields) ? (doclingRaw as any).fields : []) {
    const key = String(field?.key ?? field?.label ?? "").trim();
    const value = field?.value ?? field?.text ?? null;
    if (!key || isBlank(value)) continue;
    candidates.push({
      key,
      value,
      confidence: normalizeConfidence(field?.confidence) ?? 0.72,
      source: "document",
    });
  }

  const fullText = String((doclingRaw as any).full_text ?? "");
  for (const line of fullText.split(/\n/).slice(0, 300)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9 /&().#-]{2,48})\s*[:\-]\s*(.{2,160})\s*$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (!key || isBlank(value)) continue;
    candidates.push({ key, value, confidence: 0.6, source: "document_text" });
  }

  const out = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeKey(candidate.key);
    if (!normalized || schemaKeys.has(normalized)) continue;
    if (existingKeys.has(normalized) || seen.has(normalized)) continue;
    if (standardAliases.has(normalized)) continue;
    if (duplicatesStandardValue(candidate.key, candidate.value, standardValues)) continue;
    if (looksLikeNoise(candidate.key, candidate.value)) continue;

    seen.add(normalized);
    out.push(
      buildReviewField({
        recordIndex,
        fieldKey: normalized,
        value: candidate.value,
        confidence: candidate.confidence,
        source: candidate.source,
        isStandard: false,
        required: false,
        fieldType: inferFieldType(candidate.value),
        description: "Extra field interpreted from the document and available for user approval.",
      }),
    );
    if (out.length >= 20) break;
  }

  return out;
}

function duplicatesStandardValue(key: string, value: unknown, standardValues: Record<string, unknown>) {
  const normalizedKey = normalizeKey(key);
  const normalizedValue = normalizeComparableValue(value);
  if (!normalizedValue) return false;

  if (/_(day|month|year)$/.test(normalizedKey)) {
    const baseKey = normalizedKey.replace(/_(day|month|year)$/, "");
    const candidateStandardKeys = [baseKey, `${baseKey}_date`];
    if (candidateStandardKeys.some((candidate) => !isBlank(standardValues[candidate]))) {
      return true;
    }
  }

  for (const standardValue of Object.values(standardValues)) {
    if (isBlank(standardValue)) continue;
    const comparable = normalizeComparableValue(standardValue);
    if (!comparable) continue;
    if (normalizedValue === comparable) return true;
    if (
      normalizedValue.length > 8 &&
      comparable.length > 8 &&
      (normalizedValue.includes(comparable) || comparable.includes(normalizedValue))
    ) {
      return true;
    }
  }

  return false;
}

function buildStandardAliases(schema: Record<string, any>) {
  const aliases = new Set<string>();
  for (const [fieldKey, def] of Object.entries(schema)) {
    aliases.add(normalizeKey(fieldKey));
    for (const label of def?.labels ?? []) aliases.add(normalizeKey(label));
    for (const header of def?.tableHeaders ?? []) aliases.add(normalizeKey(header));
  }
  return aliases;
}

function normalizeKey(key: string): string {
  return String(key)
    .trim()
    .toLowerCase()
    .replace(/[#%]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function normalizeComparableValue(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.;:]$/g, "");
}

function looksLikeNoise(key: string, value: unknown): boolean {
  const normalized = normalizeKey(key);
  if (!normalized || normalized.length < 4) return true;
  if (/^https?$/.test(normalized)) return true;
  if (/^(before|after|the|and|or|with|without)_/.test(normalized)) return true;
  if (/^(signature|name|date)_[a-z0-9_]+$/.test(normalized)) return true;
  if (/^(move_in|inspection|checklist|instructions|terms|fixed_term_lease|tenant_initials|landlord_initials)/.test(normalized)) {
    return true;
  }
  if (["page", "date", "signature", "initials"].includes(normalized)) return false;
  if (/^(the|and|or|of|to|from|for|in|on|with)$/.test(normalized)) return true;
  const stringValue = String(value ?? "").trim();
  if (stringValue.length < 2) return true;
  if (stringValue.length > 240) return true;
  if (stringValue.includes("________________")) return true;
  if (/^(pro|cam|nnn|sf|psf)$/.test(normalized)) return true;
  if (/(common area maintenance|\bcam\b|pro[\s-]?rata)/i.test(`${key} ${stringValue}`)) return true;
  if (
    normalized.split("_").length >= 4 &&
    !/(tenant|landlord|property|address|rent|lease|deposit|cam|nnn|utility|water|sewer|electric|parking|pet|fee|reimbursement|insurance|tax)/i.test(normalized)
  ) {
    return true;
  }
  if (/^[a-z]/.test(stringValue) && normalized.length <= 10) return true;
  return false;
}

function extractCamNoteFromText(doclingRaw?: Record<string, unknown> | null): string | null {
  const text = String((doclingRaw as any)?.full_text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  const patterns = [
    /(?:pro[\s-]?rata[^.]{0,220}(?:common area maintenance|\bcam\b)[^.]{0,220}\.)/i,
    /(?:(?:common area maintenance|\bcam\b)[^.]{0,260}\.)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) {
      return match[0].replace(/\s+/g, " ").trim().slice(0, 300);
    }
  }

  return null;
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (value <= 1) return Math.max(0, Math.min(1, value));
  return Math.max(0, Math.min(1, value / 100));
}

function sourceFromMethod(method: string | null): string {
  const lower = String(method ?? "").toLowerCase();
  if (lower.includes("vision") || lower.includes("ocr")) return "vision";
  if (lower.includes("llm") || lower.includes("gemini") || lower.includes("vertex")) return "llm";
  if (lower.includes("table")) return "table";
  return "rule";
}

function inferFieldType(value: unknown): string {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  return "string";
}

function humanizeFieldName(fieldName: string): string {
  return fieldName
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    const body = await req.json().catch(() => ({}));
    const { file_id } = body;

    if (!file_id) {
      return jsonResponse(
        { error: true, message: "file_id is required", error_code: "MISSING_FILE_ID" },
        400,
      );
    }

    // Fetch file record (org_id isolation)
    const { data: fileRecord, error: fetchError } = await supabaseAdmin
      .from("uploaded_files")
      .select("*")
      .eq("id", file_id)
      .eq("org_id", orgId)
      .single();

    if (fetchError || !fileRecord) {
      return jsonResponse(
        {
          error: true,
          message: `File not found: ${fetchError?.message ?? "Invalid file_id"}`,
          error_code: "FILE_NOT_FOUND",
        },
        404,
      );
    }

    // Must be in pdf_parsed state
    if (fileRecord.status !== "pdf_parsed") {
      return jsonResponse(
        {
          error: true,
          message: `File status must be 'pdf_parsed'. Current: '${fileRecord.status}'`,
          error_code: "INVALID_STATUS",
        },
        422,
      );
    }

    if (!fileRecord.docling_raw) {
      return jsonResponse(
        {
          error: true,
          message: "No Docling output found. Run parse-pdf-docling first.",
          error_code: "NO_DOCLING_OUTPUT",
        },
        422,
      );
    }

    const moduleType = fileRecord.module_type ?? "unknown";
    const extractionModuleType = toExtractionModuleType(moduleType);
    const fileName = fileRecord.file_name ?? "document";

    // Load file bytes from Supabase Storage so the pipeline can fall back
    // to Gemini Vision when Docling text is weak (scanned / handwritten /
    // image-only PDFs). pipeline.ts already wires `fileBase64` into the
    // LLM extractor's file-mode branch — but until now the orchestrator
    // never passed it, so the Vision path was unreachable for every file.
    let fileBase64: string | null = null;
    let fileMimeType: string | null = fileRecord.mime_type
      ?? fileRecord.file_type
      ?? (fileRecord.file_name?.toLowerCase().endsWith(".pdf") ? "application/pdf" : null);
    let fileLoadStatus: string = "not_attempted";
    let fileLoadError: string | null = null;
    let fileBytesLength = 0;
    let detectedMagic: string | null = null;

    // Detect what was actually downloaded by inspecting the first bytes.
    // If the download silently returned an HTML error page (expired signed
    // URL, RLS deny rendered as HTML, etc.) we must NOT send that to
    // Gemini Vision and pretend it's the lease PDF.
    const detectMagic = (bytes: Uint8Array): string | null => {
      if (!bytes || bytes.length < 4) return null;
      // %PDF
      if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
      // JPEG: FF D8 FF
      if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "jpeg";
      // PNG: 89 50 4E 47
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "png";
      // GIF: 47 49 46 38
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
      // TIFF: 49 49 2A 00 or 4D 4D 00 2A
      if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2A) ||
          (bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[3] === 0x2A)) return "tiff";
      // WEBP: RIFF....WEBP
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "webp_or_riff";
      // HTML error page leaked from CDN — anything starting with "<" or "<!"
      const lead = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]).toLowerCase();
      if (lead.startsWith("<!do") || lead.startsWith("<htm") || lead.startsWith("<?xm")) return "html_or_xml";
      return null;
    };

    if (fileRecord.file_url) {
      try {
        const storagePath = String(fileRecord.file_url).replace(
          /^.*\/storage\/v1\/object\/public\/financial-uploads\//,
          "",
        );
        console.log(
          `[normalize-pdf-output] loading file bytes file_id=${file_id} ` +
          `file_name=${fileRecord.file_name ?? "?"} storage_path=${storagePath} ` +
          `module=${moduleType}`,
        );
        const { data: fileBlob, error: downloadError } = await supabaseAdmin
          .storage
          .from("financial-uploads")
          .download(storagePath);
        if (downloadError || !fileBlob) {
          fileLoadStatus = "download_failed";
          fileLoadError = downloadError?.message ?? "blob_missing";
          console.warn(
            `[normalize-pdf-output] file bytes unavailable for file_id=${file_id} — Vision fallback disabled. ${fileLoadError}`,
          );
        } else {
          const bytes = new Uint8Array(await fileBlob.arrayBuffer());
          fileBytesLength = bytes.length;
          detectedMagic = detectMagic(bytes);

          if (!detectedMagic || detectedMagic === "html_or_xml") {
            // Don't send a non-document to Vision. Mark load as failed and
            // let extraction proceed with whatever Docling produced.
            fileLoadStatus = "unexpected_content_type";
            fileLoadError = `Downloaded bytes do not look like a PDF/image (magic=${detectedMagic ?? "unknown"}, first 16 bytes hex=${
              Array.from(bytes.subarray(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join("")
            })`;
            console.warn(
              `[normalize-pdf-output] file bytes failed magic check for file_id=${file_id} — Vision fallback disabled. ${fileLoadError}`,
            );
          } else {
            // Deno base64 encoder is available; encode incrementally if large.
            // For typical lease PDFs (<10MB) the inline conversion is fine.
            let binary = "";
            const CHUNK = 8 * 1024;
            for (let offset = 0; offset < bytes.length; offset += CHUNK) {
              const slice = bytes.subarray(offset, offset + CHUNK);
              // String.fromCharCode.apply rejects very large arrays; chunked
              // conversion keeps each call within the JS arg limit.
              binary += String.fromCharCode.apply(null, Array.from(slice));
            }
            fileBase64 = btoa(binary);
            // Resolve fileMimeType from magic when possible — this is more
            // reliable than the column value or blob.type, which can be
            // wrong for files re-uploaded via Storage REST.
            const magicMime =
              detectedMagic === "pdf" ? "application/pdf"
              : detectedMagic === "jpeg" ? "image/jpeg"
              : detectedMagic === "png" ? "image/png"
              : detectedMagic === "gif" ? "image/gif"
              : detectedMagic === "tiff" ? "image/tiff"
              : detectedMagic === "webp_or_riff" ? "image/webp"
              : null;
            fileMimeType = magicMime || fileMimeType || (fileBlob as any).type || "application/pdf";
            fileLoadStatus = "loaded";
            console.log(
              `[normalize-pdf-output] file bytes loaded for file_id=${file_id} ` +
              `(${bytes.length} bytes, magic=${detectedMagic}, mime=${fileMimeType}) ` +
              `— Vision fallback enabled if needed`,
            );
          }
        }
      } catch (loadErr: any) {
        fileLoadStatus = "exception";
        fileLoadError = loadErr?.message ?? String(loadErr);
        console.warn(
          `[normalize-pdf-output] file bytes load exception for file_id=${file_id}: ${fileLoadError}`,
        );
      }
    } else {
      fileLoadStatus = "no_file_url";
      console.warn(
        `[normalize-pdf-output] uploaded_files.file_url missing for file_id=${file_id} — Vision fallback disabled`,
      );
    }

    // Transition to 'validating' while the pipeline runs.
    // (pdf_parsed → validating is allowed in the FSM.)
    const { error: validatingStatusError } = await setStatus(supabaseAdmin, file_id, "validating");
    if (validatingStatusError) {
      throw new Error(`Failed to transition file to validating: ${validatingStatusError.message}`);
    }

    try {
      // Run the canonical extraction pipeline.
      // Rule → Table → LLM(missing only) → Merge → Validate → Calculate.
      const result = await runExtractionPipeline(
        {
          moduleType: extractionModuleType,
          fileName,
          docling: fileRecord.docling_raw,
          // Pass file bytes + MIME so the LLM extractor can delegate to
          // Gemini Vision file-mode when embedded text is too weak to
          // ground a field. Pipeline returns metadata.extractionDebug
          // describing what happened.
          ...(fileBase64 ? { fileBase64, fileMimeType: fileMimeType || "application/pdf" } : {}),
        },
        {
          // Conservative defaults — tune per-module if needed later.
          maxLLMChunks: 6,
          chunkSize: 1500,
          llmTemperature: 0,
        },
      );

      // Forward file-load status into the pipeline's extractionDebug so the
      // UI/debug panel can show why Vision did or didn't run.
      if (result.metadata && typeof result.metadata === "object") {
        (result.metadata as any).extractionDebug = {
          ...((result.metadata as any).extractionDebug || {}),
          file_load_status: fileLoadStatus,
          file_load_error: fileLoadError,
          file_url_present: !!fileRecord.file_url,
          file_bytes_length: fileBytesLength,
          file_magic_detected: detectedMagic,
          file_name: fileRecord.file_name ?? null,
          file_mime_resolved: fileMimeType,
          file_id: file_id,
        };
      }

      if ((!result.rows || result.rows.length === 0) && fileRecord.review_required) {
        result.rows = [buildFallbackReviewRow(moduleType)];
        result.warnings = [
          ...(result.warnings ?? []),
          "No structured fields were extracted automatically. This document is available for manual review.",
        ];
        result.metadata = {
          ...(result.metadata ?? {}),
          totalRecords: 1,
          avgConfidence: 0,
        };
      }

      if (!result.rows || result.rows.length === 0) {
        throw new Error(
          `Extraction produced 0 rows. Warnings: ${result.warnings.join("; ")}`,
        );
      }

      const uiReviewPayload = buildReviewPayload({
        fileId: file_id,
        fileName,
        moduleType,
        documentSubtype: fileRecord.document_subtype ?? null,
        extractionMethod: fileRecord.extraction_method ?? null,
        reviewRequired: !!fileRecord.review_required,
        doclingRaw: fileRecord.docling_raw ?? null,
        result,
      });
      if (uiReviewPayload?.metadata?.workflow_output) {
        result.metadata = {
          ...(result.metadata ?? {}),
          workflow_output: uiReviewPayload.metadata.workflow_output,
        };
        (result as Record<string, unknown>).workflow_output = uiReviewPayload.metadata.workflow_output;
      }

      // ── Consolidated extraction_debug ──────────────────────────────────
      // Merge the pipeline's parser/vision diagnostics with the workflow's
      // profile + mapping + expense-rule diagnostics into one object using
      // canonical key names, then surface mapping_failure_reason. The debug
      // panel and Lease Review read this from
      // uploaded_files.normalized_output.metadata.extractionDebug (and, after
      // approval, lease.extraction_data.extraction_debug).
      {
        const firstRecord = Array.isArray(uiReviewPayload?.records) ? uiReviewPayload.records[0] : null;
        const wf = (firstRecord as any)?.workflow_output ?? null;
        const wfSummary = (wf?.summary ?? {}) as Record<string, unknown>;
        const pipelineDebug = ((result.metadata as any)?.extractionDebug ?? {}) as Record<string, unknown>;
        const uiFieldsCount = firstRecord
          ? ((firstRecord as any).standard_fields?.length ?? 0) + ((firstRecord as any).custom_fields?.length ?? 0)
          : 0;
        const fullTextChars = Number(
          wfSummary.full_text_chars
          ?? pipelineDebug.embedded_text_chars_total
          ?? pipelineDebug.normalized_text_chars_total
          ?? 0,
        );
        // mapping_failure_reason precedence: an outright parse failure
        // (no text) trumps the workflow's field-level reason.
        const mappingFailureReason =
          fullTextChars === 0
            ? "no_text_extracted"
            : (wfSummary.mapping_failure_reason as string | null) ?? null;
        const coreMappingFailed = Boolean(wfSummary.core_mapping_failed) || mappingFailureReason != null;
        const consolidated = {
          ...pipelineDebug,
          // Document classification
          document_profile: wf?.document_profile ?? wfSummary.document_profile ?? null,
          selected_document_profile: wf?.selected_document_profile ?? wfSummary.selected_document_profile ?? null,
          lease_structure: wf?.lease_structure ?? wfSummary.lease_structure ?? null,
          profile_detection_signals: wf?.profile_detection_signals ?? wfSummary.profile_detection_signals ?? null,
          // Text + parser provenance
          full_text_chars: fullTextChars,
          parser_source: pipelineDebug.vision_parser_source ?? pipelineDebug.parsing_method ?? null,
          vision_parser_used: pipelineDebug.vision_parser_used ?? false,
          vision_field_extraction_used: pipelineDebug.vision_field_extraction_used ?? pipelineDebug.vision_fallback_triggered ?? false,
          // Mapping counts
          fixed_fields_extracted: wfSummary.fixed_fields_extracted ?? 0,
          mapped_standard_fields_count: wfSummary.mapped_standard_fields_count ?? 0,
          lease_fields_count: wfSummary.lease_fields_count ?? 0,
          ui_review_payload_fields_count: uiFieldsCount,
          source_backed_fields_count: wfSummary.source_backed_fields_count ?? pipelineDebug.source_backed_fields_count ?? 0,
          value_only_fields_count: wfSummary.value_only_fields_count ?? 0,
          fields_rejected_missing_source_count: wfSummary.fields_rejected_missing_source_count ?? 0,
          fields_rejected_generic_source_count: wfSummary.fields_rejected_generic_source_count ?? pipelineDebug.rejected_generic_source_count ?? 0,
          // Expense-rule generation
          expense_rules_generated_count: wfSummary.expense_rules_generated_count ?? wfSummary.expense_rule_count ?? 0,
          real_expense_rules_count: wfSummary.real_expense_rules_count ?? 0,
          coverage_gap_rules_count: wfSummary.coverage_gap_rules_count ?? 0,
          expense_rules_demoted_for_mapping_failure: wfSummary.expense_rules_demoted_for_mapping_failure ?? 0,
          // The headline
          mapping_failure_reason: mappingFailureReason,
          core_mapping_failed: coreMappingFailed,
        };
        result.metadata = {
          ...(result.metadata ?? {}),
          extractionDebug: consolidated,
        };
        // Also expose it on the review payload metadata so the draft-creation
        // path (which only reads ui_review_payload) can persist it onto
        // lease.extraction_data.extraction_debug.
        if (uiReviewPayload?.metadata && typeof uiReviewPayload.metadata === "object") {
          (uiReviewPayload.metadata as Record<string, unknown>).extractionDebug = consolidated;
          (uiReviewPayload.metadata as Record<string, unknown>).extraction_debug = consolidated;
        }

        // Surface a user-facing warning so the Upload screen's
        // "did not return mapped values" banner reflects a real signal and
        // the Lease Review screen can show the honest message instead of a
        // misleading "N expense terms found" success.
        if (coreMappingFailed && extractionModuleType === "lease") {
          const msg =
            "Expense terms may have been detected, but core lease fields were not mapped. Manual review required.";
          uiReviewPayload.global_warnings = [
            ...(uiReviewPayload.global_warnings ?? []),
            msg,
          ];
          uiReviewPayload.warnings = [
            ...(uiReviewPayload.warnings ?? []),
            msg,
          ];
          (uiReviewPayload as Record<string, unknown>).mapping_failed = true;
          (uiReviewPayload as Record<string, unknown>).mapping_failure_reason = mappingFailureReason;
        }
      }

      // Decide the next status based on the review gate decided at ingest.
      const reviewRequired = !!fileRecord.review_required;
      const nextStatus = reviewRequired ? "review_required" : "validated";

      // FSM: 'validating' → 'validated' is allowed; 'validating' → 'review_required'
      // is NOT a valid transition in the FSM (validated is the intermediate).
      // So we always land on 'validated' first, then flip to 'review_required'
      // if a human gate is required.
      const { error: validatedErr } = await setStatus(
        supabaseAdmin,
        file_id,
        "validated",
        {
          parsed_data: result.rows,
          normalized_output: result,
          ui_review_payload: uiReviewPayload,
          row_count: result.rows.length,
          valid_count: result.rows.length - (result.validationErrors?.length ?? 0),
          error_count: result.validationErrors?.length ?? 0,
          validation_errors: result.validationErrors ?? [],
          error_message: null,
          processing_completed_at: new Date().toISOString(),
        },
      );

      if (validatedErr) {
        throw new Error(`Failed to save normalized output: ${validatedErr.message}`);
      }

      if (reviewRequired) {
        const { error: reviewErr } = await setStatus(
          supabaseAdmin,
          file_id,
          "review_required",
          {
            review_status: "pending",
          },
        );
        if (reviewErr) {
          // Not fatal — the row is still in 'validated'; we'll surface the
          // warning rather than rolling back the normalization work.
          console.warn(
            `[normalize-pdf-output] Could not transition to review_required: ${reviewErr.message}`,
          );
        }
      }

      console.log(
        `[normalize-pdf-output] OK file_id=${file_id} module=${moduleType} ` +
        `rows=${result.rows.length} method=${result.method} ` +
        `confidence=${result.metadata.avgConfidence}% nextStatus=${nextStatus}`,
      );

      return jsonResponse({
        error: false,
        file_id,
        processing_status: nextStatus,
        module_type: moduleType,
        document_subtype: fileRecord.document_subtype,
        review_required: reviewRequired,
        method: result.method,
        row_count: result.rows.length,
        warnings: result.warnings,
        validation_errors: result.validationErrors,
        metadata: result.metadata,
      });
    } catch (normError) {
      console.error(
        `[normalize-pdf-output] Failed for file_id=${file_id}: ${normError.message}`,
      );
      await setFailed(
        supabaseAdmin,
        file_id,
        normError.message,
        "normalize",
        35,
      );
      throw normError;
    }
  } catch (err) {
    console.error("[normalize-pdf-output] Error:", err.message);
    return jsonResponse(
      {
        error: true,
        message: err.message,
        error_code: "NORMALIZATION_FAILED",
      },
      400,
    );
  }
});
