// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import {
  detectFileType,
  classifyDocumentSubtype,
  type DetectionResult,
  type FileFormat,
  type ModuleType,
  type DocumentSubtype,
} from "../_shared/file-detector.ts";
import { ALLOWED_TRANSITIONS, setFailed, setStatus } from "../_shared/pipeline-status.ts";

/**
 * ingest-file — Unified File Ingestion Router
 *
 * This is the single entry point for ALL file formats (CSV, Excel, PDF, text).
 * It replaces the need to call parse-file or parse-pdf-docling directly.
 *
 * Flow:
 *   1. Accept { file_id, module_type? }
 *   2. Fetch the file record + download first bytes from storage
 *   3. Detect file format + module type (using file-detector)
 *   4. Route to the correct extraction function:
 *        csv / xls / xlsx / text  →  parse-file  (existing CSV pipeline)
 *        pdf                      →  parse-pdf-docling  (Docling OCR)
 *        unknown                  →  attempt text fallback, else fail
 *   5. Return detection result + routing decision to caller
 *
 * The downstream functions (parse-file, parse-pdf-docling) handle their own
 * status updates. This function only does detection + routing.
 *
 * RULES:
 *   - Does NOT modify compute engines
 *   - Does NOT bypass validation
 *   - Does NOT insert raw data into DB tables
 *   - All formats converge into the same validate-data → store-data pipeline
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Edge Function caller with selective retry and strict timeout budget.
 *
 * Timeout budget: Supabase Edge Functions have a 150 s hard wall. With two
 * downstream calls (parse-pdf-docling + normalize-pdf-output) plus overhead,
 * each call must complete within 45 s, leaving ≥60 s for parkForManualReview
 * and the HTTP response before the hard limit.
 *
 * Do NOT raise timeoutMs above 45 000 without reducing retries or splitting
 * the pipeline into async/queue steps.
 *
 * Retry policy:
 *   - 4xx (client errors): never retry.
 *   - 546 (Supabase resource exhaustion): never retry — the same resource
 *     pressure will cause the retry to fail and the wasted time will push the
 *     orchestrator past the 150 s wall, surfacing a second 546 to the user.
 *   - 529 (Supabase overloaded): never retry for the same reason.
 *   - 5xx (other transient server errors): retry once with 1 s delay.
 *   - Network / AbortError (timeout): never retry.
 */
async function callEdgeFunction(
  supabaseUrl: string,
  functionName: string,
  body: Record<string, unknown>,
  authToken: string,
  actingOrgId?: string | null,
  retries = 1,
  timeoutMs = 45000,
  discardSuccessBody = false,
): Promise<{ ok: boolean; status: number; data: unknown; error?: string; timedOut?: boolean }> {
  const url = `${supabaseUrl}/functions/v1/${functionName}`;
  const authorization = authToken.match(/^Bearer\s+/i) ? authToken : `Bearer ${authToken}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[ingest-file] Calling ${functionName} (attempt ${attempt}/${retries})`);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": authorization,
          "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
          ...(actingOrgId ? { "x-acting-org-id": actingOrgId } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.ok) {
        console.log(`[ingest-file] ${functionName} succeeded on attempt ${attempt}`);
        // When the caller doesn't need the response body (e.g. the downstream
        // function writes its output directly to the DB), discard the body
        // rather than buffering it in ingest-file's heap. Large payloads from
        // parse-pdf-docling / normalize-pdf-output (field traces, docling_raw)
        // are the primary cause of ingest-file hitting the 546 memory limit.
        if (discardSuccessBody) {
          await res.body?.cancel().catch(() => undefined);
          return { ok: true, status: res.status, data: null };
        }
        const data = await res.json().catch(() => ({}));
        return { ok: true, status: res.status, data };
      }

      const data = await res.json().catch(() => ({}));

      // Resource-exhaustion responses from Supabase — never retry.
      // Retrying burns the remaining wall-time budget and causes the
      // orchestrator itself to be killed with 546 before it can park.
      if (res.status === 546 || res.status === 529) {
        const message =
          (data as any)?.message ||
          "Function ran out of compute resources. The PDF may be too large or complex. Try re-extracting.";
        console.error(`[ingest-file] ${functionName} hit resource limit (${res.status}), not retrying`);
        return { ok: false, status: res.status, data, error: message };
      }

      // Client errors (4xx) — never retry.
      if (res.status >= 400 && res.status < 500) {
        const message =
          (data as any)?.message ||
          (data as any)?.error_details ||
          (data as any)?.error_code ||
          `Client error: ${res.status}`;
        console.log(`[ingest-file] ${functionName} client error ${res.status}, not retrying`);
        return { ok: false, status: res.status, data, error: message };
      }

      // Transient 5xx — retry once with a short delay.
      if (attempt < retries) {
        const delay = 1000;
        console.log(`[ingest-file] ${functionName} failed with ${res.status}, retrying in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      return {
        ok: false,
        status: res.status,
        data,
        error: (data as any)?.message || (data as any)?.error_details || `Server error on attempt ${attempt}`,
      };
    } catch (err) {
      const isTimeout =
        err?.name === "TimeoutError" ||
        err?.name === "AbortError" ||
        String(err?.message || "").toLowerCase().includes("timeout");

      console.error(
        `[ingest-file] ${functionName} attempt ${attempt} failed${isTimeout ? " (timeout)" : ""}:`,
        err.message,
      );

      // Never retry on timeout — the next attempt will consume the same
      // budget and the orchestrator needs the remaining time to park.
      return {
        ok: false,
        status: isTimeout ? 504 : 500,
        data: {},
        timedOut: isTimeout,
        error: isTimeout
          ? `${functionName} timed out after ${timeoutMs / 1000}s — PDF may be too large. Try re-extracting.`
          : `Network error: ${err.message}`,
      };
    }
  }

  return { ok: false, status: 500, data: {}, error: "Unexpected retry loop exit" };
}

/**
 * Download only the first `maxBytes` bytes of a file using an HTTP Range
 * request. This avoids loading the entire file into the edge function's heap
 * just for magic-byte / content-keyword detection, which was a primary cause
 * of 546 OOM for large PDFs (the two old download helpers each fetched the
 * whole file, doubling the allocation before any downstream call ran).
 *
 * Falls back to a full download if the storage API rejects the Range header
 * (e.g. an older bucket config that doesn't support partial content).
 */
async function downloadPreviewBytes(
  _supabaseAdmin: any,
  storagePath: string,
  maxBytes = 2048,
): Promise<Uint8Array> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (supabaseUrl && serviceKey) {
    try {
      const objectUrl = `${supabaseUrl}/storage/v1/object/financial-uploads/${storagePath}`;
      const res = await fetch(objectUrl, {
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
          Range: `bytes=0-${maxBytes - 1}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      // 206 Partial Content or 200 (server ignored Range but returned the file)
      if (res.ok || res.status === 206) {
        const buf = await res.arrayBuffer();
        return new Uint8Array(buf.slice(0, maxBytes));
      }
    } catch {
      // fall through to Supabase client fallback
    }
  }

  // Fallback: full download via Supabase client (only hits for unusual configs)
  try {
    const { data, error } = await _supabaseAdmin.storage
      .from("financial-uploads")
      .download(storagePath);
    if (error || !data) return new Uint8Array(0);
    const buf = await data.arrayBuffer();
    return new Uint8Array(buf.slice(0, maxBytes));
  } catch {
    return new Uint8Array(0);
  }
}

const MANUAL_REVIEW_FIELDS: Record<string, string[]> = {
  leases: [
    "tenant_name",
    "property_name",
    "assignor_name",
    "assignee_name",
    "assignment_effective_date",
    "unit_number",
    "start_date",
    "end_date",
    "monthly_rent",
    "square_footage",
    "lease_type",
    "notes",
  ],
  expenses: ["vendor", "invoice_number", "date", "amount", "category", "classification", "description"],
  invoices: ["vendor", "invoice_number", "date", "amount", "category", "description"],
  properties: ["name", "address", "city", "state", "zip", "total_sqft", "notes"],
  revenue: ["tenant_name", "property_name", "type", "amount", "date", "notes"],
  buildings: ["name", "address", "total_sqft", "floors", "notes"],
  units: ["unit_number", "square_footage", "monthly_rent", "tenant_name", "notes"],
  tenants: ["name", "company", "contact_name", "email", "phone", "notes"],
  gl_accounts: ["code", "name", "type", "category", "notes"],
};

function buildManualReviewPayload(opts: {
  fileId: string;
  fileName: string;
  moduleType: string;
  documentSubtype: string;
  extractionMethod: string;
  reason: string;
}) {
  const fields = MANUAL_REVIEW_FIELDS[opts.moduleType] ?? ["document_notes"];
  const standardFields = fields.map((fieldKey) => ({
    id: `0:standard:${fieldKey}`,
    field_key: fieldKey,
    label: humanizeFieldName(fieldKey),
    value: null,
    original_value: null,
    field_type: inferFieldType(fieldKey),
    required: ["tenant_name", "start_date", "end_date", "monthly_rent", "amount", "date", "name"].includes(fieldKey),
    is_standard: true,
    confidence: 0,
    source: "system",
    evidence: null,
    status: "missing",
    accepted: false,
    rejected: false,
    user_edit: null,
  }));
  const missingRequired = standardFields
    .filter((field) => field.required)
    .map((field) => field.field_key);
  const record = {
    record_index: 0,
    row_index: 0,
    values: Object.fromEntries(standardFields.map((field) => [field.field_key, null])),
    fields: Object.fromEntries(
      standardFields.map((field) => [
        field.field_key,
        {
          value: null,
          confidence: 0,
          source: "system",
          evidence: null,
          status: "missing",
        },
      ]),
    ),
    standard_fields: standardFields,
    custom_fields: [],
    rejected_fields: [],
    missing_required: missingRequired,
    warnings: [opts.reason],
    confidence: 0,
    notes: opts.reason,
  };

  return {
    schema_version: 2,
    file_id: opts.fileId,
    file_name: opts.fileName,
    module_type: opts.moduleType,
    document_subtype: opts.documentSubtype,
    extraction_method: opts.extractionMethod,
    pipeline_method: "manual_review_fallback",
    avg_confidence: 0,
    review_required: true,
    review_status: "pending",
    records: [record],
    rows: [record],
    global_warnings: [
      "Automatic extraction did not finish. You can still enter, accept, reject, and add fields manually.",
      opts.reason,
    ],
    warnings: [
      "Automatic extraction did not finish. You can still enter, accept, reject, and add fields manually.",
      opts.reason,
    ],
    validation_errors: [],
    metadata: {
      totalRecords: 1,
      avgConfidence: 0,
      manualReviewFallback: true,
    },
    built_at: new Date().toISOString(),
  };
}

function buildStructuredReviewPayload(opts: {
  fileId: string;
  fileName: string;
  moduleType: string;
  documentSubtype: string;
  rows: Record<string, unknown>[];
}) {
  const sourceRows = Array.isArray(opts.rows) && opts.rows.length > 0 ? opts.rows : [{}];
  const defaultFields = MANUAL_REVIEW_FIELDS[opts.moduleType] ?? ["document_notes"];

  const records = sourceRows.map((row, index) => {
    const rowKeys = Object.keys(row || {});
    const fieldKeys = rowKeys.length > 0 ? rowKeys : defaultFields;
    const standardFields = fieldKeys.map((fieldKey) => {
      const value = row?.[fieldKey] ?? null;
      const missing = value === null || value === undefined || String(value).trim() === "";
      return {
        id: `${index}:standard:${fieldKey}`,
        field_key: fieldKey,
        label: humanizeFieldName(fieldKey),
        value,
        original_value: value,
        field_type: inferFieldType(fieldKey),
        required: ["tenant_name", "start_date", "end_date", "monthly_rent"].includes(fieldKey),
        is_standard: true,
        confidence: missing ? 0 : 0.75,
        source: "structured_parser",
        evidence: null,
        status: missing ? "missing" : "needs_review",
        accepted: false,
        rejected: false,
        user_edit: null,
      };
    });
    const values = Object.fromEntries(standardFields.map((field) => [field.field_key, field.value ?? null]));
    const missingRequired = standardFields
      .filter((field) => field.required && (field.value === null || field.value === undefined || String(field.value).trim() === ""))
      .map((field) => field.field_key);

    return {
      record_index: index,
      row_index: index,
      values,
      fields: Object.fromEntries(
        standardFields.map((field) => [
          field.field_key,
          {
            value: field.value ?? null,
            confidence: field.confidence,
            source: field.source,
            evidence: null,
            status: field.status,
          },
        ]),
      ),
      standard_fields: standardFields,
      custom_fields: [],
      rejected_fields: [],
      missing_required: missingRequired,
      warnings: [],
      confidence: averageConfidence(standardFields.map((field) => field.confidence)),
      notes: null,
    };
  });

  return {
    schema_version: 2,
    file_id: opts.fileId,
    file_name: opts.fileName,
    module_type: opts.moduleType,
    document_subtype: opts.documentSubtype,
    extraction_method: "structured_parser",
    pipeline_method: "structured_review_gate",
    avg_confidence: averageConfidence(records.flatMap((record: any) => record.standard_fields.map((field: any) => field.confidence))),
    review_required: true,
    review_status: "pending",
    records,
    rows: records,
    global_warnings: [
      "Structured lease import was parsed and is waiting for Lease Review before storage.",
    ],
    warnings: [
      "Structured lease import was parsed and is waiting for Lease Review before storage.",
    ],
    validation_errors: [],
    metadata: {
      totalRecords: records.length,
      avgConfidence: averageConfidence(records.flatMap((record: any) => record.standard_fields.map((field: any) => field.confidence))),
      structuredReviewGate: true,
    },
    built_at: new Date().toISOString(),
  };
}

function averageConfidence(values: number[]): number {
  const numeric = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (numeric.length === 0) return 0;
  return Math.round((numeric.reduce((sum, value) => sum + value, 0) / numeric.length) * 100) / 100;
}

async function buildManualReviewTransitionDiagnostics(args: {
  supabaseAdmin: any;
  fileId: string;
  reason: string;
}) {
  const currentLookup = await args.supabaseAdmin
    .from("uploaded_files")
    .select("status, processing_status")
    .eq("id", args.fileId)
    .maybeSingle();

  if (currentLookup.error) {
    console.warn("[ingest-file] Could not read status before manual review fallback:", currentLookup.error);
  }

  const previousStatus = currentLookup.data?.status ?? null;
  const allowedNextStatuses = previousStatus
    ? ALLOWED_TRANSITIONS[previousStatus] ?? []
    : [];

  return {
    previous_status: previousStatus,
    previous_processing_status: currentLookup.data?.processing_status ?? null,
    requested_next_status: "review_required",
    allowed_next_statuses: allowedNextStatuses,
    transition_source: "ingest-file.parkForManualReview",
    function_name: "ingest-file.parkForManualReview",
    fallback_reason: args.reason,
  };
}

async function parkForManualReview(args: {
  supabaseAdmin: any;
  fileId: string;
  fileName: string;
  moduleType: string;
  documentSubtype: string;
  extractionMethod: string;
  reason: string;
}) {
  const payload = buildManualReviewPayload({
    fileId: args.fileId,
    fileName: args.fileName,
    moduleType: args.moduleType,
    documentSubtype: args.documentSubtype,
    extractionMethod: args.extractionMethod,
    reason: args.reason,
  });
  const transitionDiagnostics = await buildManualReviewTransitionDiagnostics({
    supabaseAdmin: args.supabaseAdmin,
    fileId: args.fileId,
    reason: args.reason,
  });
  const extractionDebug = {
    mapping_failed: true,
    manual_review_fallback: true,
    ...transitionDiagnostics,
  };

  payload.metadata = {
    ...payload.metadata,
    mapping_failed: true,
    fallback_reason: args.reason,
    extraction_debug: extractionDebug,
  };
  payload.diagnostics = extractionDebug;

  const { error } = await setStatus(args.supabaseAdmin, args.fileId, "review_required", {
    review_required: true,
    review_status: "pending",
    processing_status: "review_required",
    extraction_method: args.extractionMethod,
    ui_review_payload: payload,
    normalized_output: {
      method: "manual_review_fallback",
      rows: payload.rows.map((row: any) => row.values),
      warnings: payload.global_warnings,
      validationErrors: [],
      mapping_failed: true,
      extraction_debug: extractionDebug,
      metadata: payload.metadata,
    },
    parsed_data: payload.rows.map((row: any) => row.values),
    row_count: 1,
    valid_count: 0,
    error_count: 0,
    error_message: args.reason,
    failed_step: null,
    processing_completed_at: new Date().toISOString(),
    transition_source: "ingest-file.parkForManualReview",
    fallback_reason: args.reason,
  });

  if (error) {
    // File record is gone (deleted between dispatch and execution) — nothing to update.
    if (error.code === "NO_ROW_UPDATED") {
      console.warn(`[ingest-file] parkForManualReview: file ${args.fileId} no longer exists, skipping status update`);
      return payload;
    }
    throw new Error(`Manual review fallback failed: ${error.message}`);
  }

  return payload;
}

function humanizeFieldName(fieldName: string): string {
  return String(fieldName)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferFieldType(fieldName: string): string {
  if (fieldName.includes("date")) return "date";
  if (
    fieldName.includes("amount") ||
    fieldName.includes("rent") ||
    fieldName.includes("sqft") ||
    fieldName.includes("footage")
  ) return "number";
  return "string";
}

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------

type RoutingDecision =
  | { route: "parse-file"; reason: string }
  | { route: "parse-pdf-docling"; reason: string }
  | { route: "unsupported"; reason: string };

/** Enhanced routing decision with better format support */
function decideRoute(detection: DetectionResult): RoutingDecision {
  const { fileFormat, moduleType } = detection;
  const isTabularModule = ["properties", "buildings", "units", "revenue", "budgets", "expenses", "gl_accounts", "tenants"].includes(moduleType);

  switch (fileFormat) {
    case "csv":
    case "text":
      // Pure text/CSV — fast path through existing CSV parser
      return { route: "parse-file", reason: `${fileFormat} file → CSV parser` };

    case "xls":
    case "xlsx":
      if (isTabularModule) {
        return { route: "parse-file", reason: `${fileFormat} file → CSV/Excel parser for tabular data` };
      }
      // Excel — route through Docling which handles binary Excel natively
      return { route: "parse-pdf-docling", reason: `${fileFormat} file → Docling (handles Excel binary format)` };

    case "pdf":
      return { route: "parse-pdf-docling", reason: "PDF → Docling OCR extraction" };

    case "docx":
    case "doc":
      return { route: "parse-pdf-docling", reason: `${fileFormat} Word document → Docling extraction` };

    case "image":
      return { route: "parse-pdf-docling", reason: "Image → Docling OCR extraction" };

    case "unknown":
    default:
      // Enhanced unknown format handling - try Docling first with better error handling
      return { route: "parse-pdf-docling", reason: "Unknown format → Docling (multi-format extraction with fallback)" };
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let requestedFileId: string | null = null;
  try {
    // 1. Auth
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    const actingOrgId = req.headers.get("x-acting-org-id")?.trim() || "";

    // 2. Parse request
    const body = await req.json();
    const {
      file_id,
      module_type: explicitModuleType,
      document_subtype: explicitSubtype,   // optional override from caller (UI)
      defer_store = false,
      force_reextract = false,             // when true, reset file status so the
                                           // pipeline can re-run on already-processed files
    } = body;
    requestedFileId = file_id ?? null;

    if (!file_id) {
      return new Response(
        JSON.stringify({ error: true, message: "file_id is required", error_code: "MISSING_FILE_ID" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 3. Fetch file record (org_id isolation)
    const { data: fileRecord, error: fetchError } = await supabaseAdmin
      .from("uploaded_files")
      .select("id, org_id, file_name, file_url, mime_type, module_type, status")
      .eq("id", file_id)
      .eq("org_id", orgId)
      .single();

    if (fetchError || !fileRecord) {
      return new Response(
        JSON.stringify({
          error: true,
          message: `File not found: ${fetchError?.message ?? "Invalid file_id or org mismatch"}`,
          error_code: "FILE_NOT_FOUND",
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Re-extract support: when the caller flags force_reextract=true on a
    // file that's already past parsing, hard-reset the status to 'uploaded'
    // so the FSM accepts the new parsing → pdf_parsed → ... transitions.
    // Without this, calling ingest-file on a stored/completed file would
    // fail at the first setStatus("parsing", ...) due to the forward-only
    // transition table in pipeline-status.ts.
    if (force_reextract) {
      const currentStatus = String(fileRecord.status || "").toLowerCase();
      const needsReset = currentStatus && currentStatus !== "uploaded" && currentStatus !== "failed";
      if (needsReset) {
        console.log(`[ingest-file] force_reextract=true — resetting status from '${currentStatus}' to 'uploaded' for file_id=${file_id}`);
        const { error: resetErr } = await supabaseAdmin
          .from("uploaded_files")
          .update({
            status: "uploaded",
            error_message: null,
            processing_completed_at: null,
            // Keep docling_raw, ui_review_payload, etc. — downstream stages
            // will overwrite them as the pipeline progresses.
            updated_at: new Date().toISOString(),
          })
          .eq("id", file_id)
          .eq("org_id", orgId);
        if (resetErr) {
          throw new Error(`force_reextract reset failed: ${resetErr.message}`);
        }
        // Mutate the local copy so downstream code sees the reset status.
        fileRecord.status = "uploaded";
      }
    }

    // 4. Derive storage path from file_url
    const storagePath = fileRecord.file_url.replace(
      /^.*\/storage\/v1\/object\/public\/financial-uploads\//,
      "",
    );

    // 5. Download first 2 KB for detection (single Range request, not full file)
    const previewBytes = await downloadPreviewBytes(supabaseAdmin, storagePath, 2048);
    const fileBytes = previewBytes.slice(0, 8);
    const contentPreview = new TextDecoder("utf-8", { fatal: false }).decode(previewBytes);

    // 6. Detect file format + module type
    const detection = detectFileType({
      mimeType: fileRecord.mime_type ?? "",
      fileName: fileRecord.file_name ?? "",
      explicitModuleType: explicitModuleType ?? fileRecord.module_type ?? undefined,
      fileBytes,
      contentPreview,
    });

    // 7. Decide routing before subtype persistence so deterministic CSV/text
    // imports do not accidentally inherit the legal-document review gate.
    const routing = decideRoute(detection);

    // 7. If module_type was detected and differs from what's stored, update it
    if (
      detection.moduleType !== "unknown" &&
      detection.moduleType !== fileRecord.module_type &&
      detection.moduleSource !== "fallback"
    ) {
      await supabaseAdmin
        .from("uploaded_files")
        .update({ module_type: detection.moduleType, updated_at: new Date().toISOString() })
        .eq("id", file_id);
    }

    // 7b. Classify document subtype + review-gate requirement.
    // This runs once, here, before extraction begins — downstream functions
    // consume the persisted subtype rather than re-classifying.
    const subtypeResult = classifyDocumentSubtype({
      fileName: fileRecord.file_name ?? "",
      contentPreview,
      moduleType: (detection.moduleType === "unknown"
        ? (fileRecord.module_type as ModuleType) || "unknown"
        : detection.moduleType) as ModuleType,
      explicitSubtype,
    });

    // Lease uploads always go through the human review gate, regardless of
    // what the document-subtype classifier returned. Lease abstracts are
    // legally sensitive and downstream modules (rent projection, CAM,
    // billing) only read from the approved abstract, so skipping review
    // would silently bypass that contract. Other modules keep the
    // classifier-driven decision.
    const effectiveModule = (detection.moduleType === "unknown"
      ? (fileRecord.module_type as ModuleType) || "unknown"
      : detection.moduleType) as ModuleType;
    const isLeaseModule = effectiveModule === "leases" || effectiveModule === "lease";
    const reviewRequired = isLeaseModule
      ? true
      : routing.route === "parse-pdf-docling" && subtypeResult.reviewRequired;

    await supabaseAdmin
      .from("uploaded_files")
      .update({
        document_subtype: subtypeResult.subtype,
        review_required: reviewRequired,
        review_status: reviewRequired ? "pending" : "not_required",
        updated_at: new Date().toISOString(),
      })
      .eq("id", file_id);

    console.log(
      `[ingest-file] subtype=${subtypeResult.subtype} ` +
      `source=${subtypeResult.source} ` +
      `confidence=${subtypeResult.confidence.toFixed(2)} ` +
      `reviewRequired=${reviewRequired}`,
    );

    // NOTE: status is left at 'uploaded' here. The next function in the
    // chain (parse-file / parse-pdf-docling) transitions to 'parsing' via
    // the FSM in _shared/pipeline-status.ts. Writing an ad-hoc status
    // here breaks the CHECK constraint.

    if (routing.route === "unsupported") {
      // Mark as failed with detailed error information
      await setFailed(
        supabaseAdmin,
        file_id,
        `Unsupported file format: ${detection.fileFormat}. Supported formats: PDF, DOC, DOCX, XLS, XLSX, CSV, TXT, Images (JPG, PNG, TIFF, etc.)`,
        "ingest",
        5,
      );

      return new Response(
        JSON.stringify({
          error: true,
          message: `Unsupported file format: ${detection.fileFormat}`,
          error_code: "UNSUPPORTED_FORMAT",
          supported_formats: ["pdf", "doc", "docx", "xls", "xlsx", "csv", "txt", "jpg", "png", "tiff"],
          detection,
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 9. Call the appropriate downstream function(s)
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const downstreamAuthToken =
      req.headers.get("Authorization") ??
      req.headers.get("x-supabase-auth") ??
      req.headers.get("x-user-jwt") ??
      "";

    if (!downstreamAuthToken) {
      throw new Error("Missing downstream auth token");
    }

    console.log(
      `[ingest-file] Routing file_id=${file_id} (${detection.fileFormat}/${detection.moduleType}) → ${routing.route}`,
    );

    const detectionSummary = {
      file_format: detection.fileFormat,
      module_type: detection.moduleType,
      format_source: detection.formatSource,
      module_source: detection.moduleSource,
      confidence: detection.confidence,
    };
    const effectiveModuleType =
      detection.moduleType !== "unknown"
        ? detection.moduleType
        : (fileRecord.module_type ?? explicitModuleType ?? "documents");

    // PDF and document processing: enhanced two-step with better error handling
    if (routing.route === "parse-pdf-docling") {
      console.log(`[ingest-file] Starting PDF/document processing for ${detection.fileFormat} file`);

      // Shared deadline: ingest-file has a 150 s wall. Reserve 25 s for
      // startup, parkForManualReview, and the HTTP response. Split the
      // remaining ~125 s between the two downstream calls (≤60 s each).
      // If a call times out, its AbortError is caught and parkForManualReview
      // runs in the remaining budget rather than the whole function hitting 504.
      const PARSE_TIMEOUT_MS = 110_000;
      const NORMALIZE_TIMEOUT_MS = 45_000;

      // Step 1: Docling extraction with enhanced error handling
      // discardSuccessBody=true: parse-pdf-docling writes docling_raw directly
      // to the DB. Buffering its response in ingest-file's heap (docling_raw
      // can be several MB) is the primary cause of the 546 memory-limit error.
      const doclingResult = await callEdgeFunction(
        supabaseUrl,
        "parse-pdf-docling",
        { file_id },
        downstreamAuthToken,
        actingOrgId,
        1,
        PARSE_TIMEOUT_MS,
        !defer_store,
      );

      if (!doclingResult.ok) {
        console.error(`[ingest-file] Docling extraction failed:`, doclingResult.error);

        const reason = (doclingResult as any).timedOut
          ? `Extraction timed out after ${Math.round(PARSE_TIMEOUT_MS / 1000)}s - the PDF may be too large or scanned at very high resolution. Click Re-extract Lease to retry, or upload a smaller/optimized PDF.`
          : `Document extraction failed: ${doclingResult.error || "Unknown error"}`;
        const payload = await parkForManualReview({
          supabaseAdmin,
          fileId: file_id,
          fileName: fileRecord.file_name ?? "document",
          moduleType: effectiveModuleType,
          documentSubtype: subtypeResult.subtype,
          extractionMethod: "manual_review_fallback",
          reason,
        });
        
        return new Response(
          JSON.stringify({ 
            error: false,
            file_id, 
            detection: detectionSummary, 
            routing: { routed_to: routing.route, reason: routing.reason }, 
            result: doclingResult.data,
            error_details: doclingResult.error,
            stage: "extraction",
            manual_review: true,
            ui_review_payload: payload,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      
      console.log(`[ingest-file] Docling extraction succeeded, starting normalization`);
      
      // Step 2: Normalization with enhanced error handling
      // discardSuccessBody=true: normalize-pdf-output writes normalized_output
      // + ui_review_payload directly to the DB. Its success response includes
      // metadata.extractionDebug (field traces for every field) which can be
      // 2-3 MB — holding that alongside the earlier docling response is what
      // pushes ingest-file past the 546 memory ceiling.
      // After success we read review_required directly from the DB (below).
      const normalizeResult = await callEdgeFunction(
        supabaseUrl,
        "normalize-pdf-output",
        { file_id },
        downstreamAuthToken,
        actingOrgId,
        1,
        NORMALIZE_TIMEOUT_MS,
        !defer_store,
      );
      
      if (!normalizeResult.ok) {
        console.error(`[ingest-file] Normalization failed:`, normalizeResult.error);

        const reason = (normalizeResult as any).timedOut
          ? `Normalization timed out after ${Math.round(NORMALIZE_TIMEOUT_MS / 1000)}s - click Re-extract Lease to retry.`
          : `Document normalization failed: ${normalizeResult.error || "Unknown error"}`;
        const payload = await parkForManualReview({
          supabaseAdmin,
          fileId: file_id,
          fileName: fileRecord.file_name ?? "document",
          moduleType: effectiveModuleType,
          documentSubtype: subtypeResult.subtype,
          extractionMethod: "manual_review_fallback",
          reason,
        });

        return new Response(
          JSON.stringify({
            error: false,
            file_id,
            detection: detectionSummary,
            routing: { routed_to: routing.route, reason: routing.reason },
            result: normalizeResult.data,
            error_details: normalizeResult.error,
            stage: "normalization",
            manual_review: true,
            ui_review_payload: payload,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      } else {
        // normalize-pdf-output is the source of truth for the post-parse
        // status: it sets 'review_required' for lease-sensitive subtypes
        // or 'validated' for deterministic ones. Do NOT force 'completed'
        // here — that would short-circuit the review gate.
        console.log(
          `[ingest-file] Document processing handed off to normalize-pdf-output; ` +
          `final status will be review_required or validated.`,
        );
      }

      if (normalizeResult.ok && defer_store) {
        console.log("[ingest-file] defer_store=true; skipping validate-data/store-data so the caller can review and import rows with page context");
        return new Response(
          JSON.stringify({
            error: false,
            file_id,
            deferred_store: true,
            detection: detectionSummary,
            routing: { routed_to: routing.route, reason: routing.reason },
            steps: {
              extraction: { success: doclingResult.ok, error: doclingResult.error },
              normalization: { success: normalizeResult.ok, error: normalizeResult.error },
              validation: { success: false, skipped: true, reason: "defer_store=true" },
              storage: { success: false, skipped: true, reason: "defer_store=true" },
            },
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Read review_required from the DB — the success response body was
      // discarded to avoid ingest-file hitting the 546 memory ceiling.
      let normalizeReviewRequired = false;
      if (normalizeResult.ok) {
        const { data: fileStatusRow } = await supabaseAdmin
          .from("uploaded_files")
          .select("review_required")
          .eq("id", file_id)
          .maybeSingle();
        normalizeReviewRequired = fileStatusRow?.review_required === true;
      }

      if (normalizeResult.ok && !normalizeReviewRequired) {
        console.log("[ingest-file] Normalization succeeded; running validate-data then store-data");
        const validateResult = await callEdgeFunction(
          supabaseUrl,
          "validate-data",
          { file_id },
          downstreamAuthToken,
          actingOrgId,
        );
        const storeResult = validateResult.ok
          ? await callEdgeFunction(
            supabaseUrl,
            "store-data",
            { file_id },
            downstreamAuthToken,
            actingOrgId,
          )
          : { ok: false, status: validateResult.status, data: {}, error: "store-data skipped because validate-data failed" };

        return new Response(
          JSON.stringify({
            error: !storeResult.ok,
            file_id,
            detection: detectionSummary,
            routing: { routed_to: routing.route, reason: routing.reason },
            steps: {
              extraction: { success: doclingResult.ok, error: doclingResult.error },
              normalization: { success: normalizeResult.ok, error: normalizeResult.error },
              validation: { success: validateResult.ok, error: validateResult.error },
              storage: { success: storeResult.ok, error: storeResult.error },
            },
          }),
          { status: storeResult.ok ? 200 : storeResult.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          error: !normalizeResult.ok,
          file_id,
          detection: detectionSummary,
          routing: { routed_to: routing.route, reason: routing.reason },
          steps: {
            extraction: { success: doclingResult.ok, error: doclingResult.error },
            normalization: { success: normalizeResult.ok, error: normalizeResult.error },
          },
        }),
        { status: normalizeResult.ok ? 200 : normalizeResult.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // CSV / Excel / text: enhanced single step processing
    console.log(`[ingest-file] Starting structured data processing for ${detection.fileFormat} file`);
    
    const downstreamResult = await callEdgeFunction(
      supabaseUrl,
      routing.route,
      { file_id },
      downstreamAuthToken,
      actingOrgId,
    );
    
    if (!downstreamResult.ok) {
      console.error(`[ingest-file] Structured data processing failed:`, downstreamResult.error);

      return new Response(
        JSON.stringify({
          error: true,
          file_id,
          detection: detectionSummary,
          routing: { routed_to: routing.route, reason: routing.reason },
          result: downstreamResult.data,
          error_details: downstreamResult.error,
          stage: "parsing",
        }),
        {
          status: downstreamResult.status || 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    } else if (reviewRequired) {
      console.log("[ingest-file] Structured lease parsing succeeded; parking at review_required");

      const parsedRowsFromResponse = Array.isArray((downstreamResult.data as any)?.parsed_data)
        ? (downstreamResult.data as any).parsed_data
        : null;
      const parsedRows = parsedRowsFromResponse ?? (
        await supabaseAdmin
          .from("uploaded_files")
          .select("parsed_data")
          .eq("id", file_id)
          .maybeSingle()
      ).data?.parsed_data ?? [];

      const uiReviewPayload = buildStructuredReviewPayload({
        fileId: file_id,
        fileName: fileRecord.file_name ?? "lease import",
        moduleType: effectiveModuleType,
        documentSubtype: subtypeResult.subtype,
        rows: Array.isArray(parsedRows) ? parsedRows : [],
      });

      const flatRows = uiReviewPayload.records.map((record: any) => record.values);
      const { error: validatingStatusError } = await setStatus(supabaseAdmin, file_id, "validating", {
        parsed_data: flatRows,
        ui_review_payload: uiReviewPayload,
        row_count: flatRows.length,
        valid_count: flatRows.length,
        validation_errors: [],
        error_count: 0,
        error_message: null,
      });
      if (validatingStatusError) {
        throw new Error(`Structured lease review staging failed: ${validatingStatusError.message}`);
      }

      const { error: reviewStatusError } = await setStatus(supabaseAdmin, file_id, "review_required", {
        ui_review_payload: uiReviewPayload,
        normalized_output: {
          method: "structured_review_gate",
          rows: flatRows,
          warnings: uiReviewPayload.global_warnings,
          validationErrors: [],
          metadata: uiReviewPayload.metadata,
        },
        parsed_data: flatRows,
        valid_data: flatRows,
        row_count: flatRows.length,
        valid_count: flatRows.length,
        error_count: 0,
        error_message: null,
        processing_completed_at: new Date().toISOString(),
      });
      if (reviewStatusError) {
        throw new Error(`Structured lease review transition failed: ${reviewStatusError.message}`);
      }

      return new Response(
        JSON.stringify({
          error: false,
          file_id,
          review_required: true,
          manual_review: true,
          detection: detectionSummary,
          routing: { routed_to: routing.route, reason: routing.reason },
          steps: {
            parsing: { success: downstreamResult.ok, data: downstreamResult.data, error: downstreamResult.error },
            review_gate: { success: true, status: "review_required" },
            validation: { success: false, skipped: true, reason: "lease review_required=true" },
            storage: { success: false, skipped: true, reason: "lease review_required=true" },
          },
          ui_review_payload: uiReviewPayload,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } else if (defer_store) {
      console.log("[ingest-file] Structured parsing succeeded; defer_store=true so validate-data/store-data are skipped");
      return new Response(
        JSON.stringify({
          error: false,
          file_id,
          deferred_store: true,
          detection: detectionSummary,
          routing: { routed_to: routing.route, reason: routing.reason },
          steps: {
            parsing: { success: downstreamResult.ok, data: downstreamResult.data, error: downstreamResult.error },
            validation: { success: false, skipped: true, reason: "defer_store=true" },
            storage: { success: false, skipped: true, reason: "defer_store=true" },
          },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } else {
      console.log("[ingest-file] Structured parsing succeeded; running validate-data then store-data");
      const validateResult = await callEdgeFunction(
        supabaseUrl,
        "validate-data",
        { file_id },
        downstreamAuthToken,
        actingOrgId,
      );
      const storeResult = validateResult.ok
        ? await callEdgeFunction(
          supabaseUrl,
          "store-data",
          { file_id },
          downstreamAuthToken,
          actingOrgId,
        )
        : { ok: false, status: validateResult.status, data: {}, error: "store-data skipped because validate-data failed" };

      return new Response(
        JSON.stringify({
          error: !storeResult.ok,
          file_id,
          detection: detectionSummary,
          routing: { routed_to: routing.route, reason: routing.reason },
          steps: {
            parsing: { success: downstreamResult.ok, data: downstreamResult.data, error: downstreamResult.error },
            validation: { success: validateResult.ok, data: validateResult.data, error: validateResult.error },
            storage: { success: storeResult.ok, data: storeResult.data, error: storeResult.error },
          },
          processing_completed: storeResult.ok,
        }),
        {
          status: storeResult.ok ? 200 : storeResult.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 10. Return enhanced result with detailed status information
    return new Response(
      JSON.stringify({
        error: !downstreamResult.ok,
        file_id,
        detection: detectionSummary,
        routing: { routed_to: routing.route, reason: routing.reason },
        result: {
          success: downstreamResult.ok,
          data: downstreamResult.data,
          error: downstreamResult.error
        },
        processing_completed: downstreamResult.ok,
      }),
      {
        status: downstreamResult.ok ? 200 : downstreamResult.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );

  } catch (err) {
    console.error("[ingest-file] Unexpected error:", err.message, err.stack);

    if (requestedFileId) {
      try {
        const { user, supabaseAdmin } = await verifyUser(req);
        await setFailed(
          supabaseAdmin,
          requestedFileId,
          `Ingestion failed: ${err.message}`,
          "ingest",
          5,
        );
      } catch (updateErr) {
        console.error("[ingest-file] Failed to update file status:", updateErr.message);
      }
    }
    return new Response(
      JSON.stringify({
        error: true,
        message: `Ingestion failed: ${err.message}`,
        error_code: "INGESTION_FAILED",
        stack: err.stack,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
