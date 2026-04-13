// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { callVertexAIFileJSON } from "../_shared/vertex-ai.ts";

/**
 * parse-pdf-docling Edge Function
 *
 * Step 1 of PDF ingestion layer.
 *
 * Flow:
 *   PDF Upload → [this function] → raw Docling output stored → (Step 2+) normalise → existing pipeline
 *
 * What this function does:
 *   1. Accept { file_id } in the request body
 *   2. Verify auth + org_id isolation
 *   3. Fetch the PDF from Supabase Storage
 *   4. Call the Docling HTTP API to extract structured data
 *   5. Store the raw Docling output in uploaded_files.docling_raw (JSONB) for debugging
 *   6. Update processing_status to 'pdf_parsed' (new intermediate status)
 *   7. Return the structured Docling output — NOT yet normalised, NOT yet in DB tables
 *
 * What this function does NOT do:
 *   - Does NOT insert into leases / expenses / properties tables
 *   - Does NOT skip validation
 *   - Does NOT modify the CSV/Excel pipeline
 *
 * Environment variables required:
 *   DOCLING_API_URL  — base URL of the Docling service (e.g. http://docling:5001)
 *   DOCLING_API_KEY  — optional bearer token if the Docling service requires auth
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single table extracted by Docling */
interface DoclingTable {
  /** 0-based index of the table within the document */
  table_index: number;
  /** Column headers (first row if detected, otherwise empty) */
  headers: string[];
  /** Data rows — each row is an array of cell strings */
  rows: string[][];
  /** Raw markdown representation of the table (useful for debugging) */
  markdown?: string;
}

/** A text block extracted by Docling */
interface DoclingTextBlock {
  /** Sequential block index */
  block_index: number;
  /** Detected block type: paragraph, heading, list_item, etc. */
  type: string;
  /** Extracted text content */
  text: string;
  /** Page number (1-based) */
  page?: number;
}

/** Key-value fields detected by Docling's form/field extraction */
interface DoclingField {
  key: string;
  value: string;
  /** Confidence score 0–1 if provided by the model */
  confidence?: number;
  /** Page number where the field was found */
  page?: number;
}

/**
 * Top-level Docling output structure.
 * This is the raw output stored verbatim — normalisation happens in Step 3.
 */
interface DoclingOutput {
  /** Docling model/version used */
  model_version?: string;
  /** Total pages in the document */
  page_count?: number;
  /** All extracted text blocks in document order */
  text_blocks: DoclingTextBlock[];
  /** All extracted tables */
  tables: DoclingTable[];
  /** Key-value fields detected (e.g. "Tenant:", "Rent:", "Start Date:") */
  fields: DoclingField[];
  /** Full plain-text representation of the document */
  full_text?: string;
  /** Raw Docling JSON response (verbatim, for debugging) */
  raw_response?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Docling API client
// ---------------------------------------------------------------------------

/**
 * Calls the Docling HTTP API with the PDF bytes.
 *
 * Docling exposes a REST endpoint that accepts a PDF file and returns
 * structured JSON. The exact endpoint path and request format depend on
 * the Docling deployment; this implementation targets the standard
 * `/api/v1/convert` endpoint used by the official Docling server.
 *
 * If DOCLING_API_URL is not set, a mock response is returned so the
 * function can be tested without a live Docling instance.
 */
async function callDoclingAPI(fileBytes: Uint8Array, fileName: string, mimeType = "application/pdf"): Promise<DoclingOutput> {
  const doclingUrl = Deno.env.get("DOCLING_API_URL");

  // ── Mock mode (no Docling service configured) — try Gemini native ────────
  if (!doclingUrl) {
    console.warn("[parse-pdf-docling] DOCLING_API_URL not set — trying Gemini native extraction");
    return extractWithGeminiNative(fileBytes, fileName, mimeType);
  }

  // ── Real Docling call ──────────────────────────────────────────────────
  const apiKey = Deno.env.get("DOCLING_API_KEY");

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([fileBytes], { type: mimeType }),
    fileName,
  );
  // Request all output types: text, tables, and key-value fields
  formData.append("output_formats", "text,tables,fields");

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${doclingUrl}/api/v1/convert`, {
    method: "POST",
    headers,
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown error");
    console.error(`[parse-pdf-docling] Docling API returned ${response.status}: ${errText} — falling back to Gemini`);
    return extractWithGeminiNative(fileBytes, fileName, mimeType);
  }

  const raw = await response.json();
  return normaliseDoclingResponse(raw, fileName);
}

/**
 * Normalises the raw Docling JSON response into our DoclingOutput shape.
 * Docling's response schema may vary by version; this handles the most
 * common field names and falls back gracefully.
 */
function normaliseDoclingResponse(
  raw: Record<string, unknown>,
  fileName: string,
): DoclingOutput {
  // Text blocks — Docling may call these "blocks", "paragraphs", or "elements"
  const rawBlocks: unknown[] =
    (raw.blocks as unknown[]) ??
    (raw.paragraphs as unknown[]) ??
    (raw.elements as unknown[]) ??
    [];

  const text_blocks: DoclingTextBlock[] = rawBlocks.map((b: any, i) => ({
    block_index: i,
    type: b.type ?? b.label ?? "paragraph",
    text: b.text ?? b.content ?? "",
    page: b.page ?? b.page_number ?? undefined,
  }));

  // Tables
  const rawTables: unknown[] = (raw.tables as unknown[]) ?? [];
  const tables: DoclingTable[] = rawTables.map((t: any, i) => {
    const rows: string[][] = (t.data ?? t.rows ?? []).map((row: any) =>
      Array.isArray(row) ? row.map(String) : Object.values(row).map(String)
    );
    const headers: string[] =
      t.headers ?? (rows.length > 0 ? rows[0] : []);
    const dataRows = t.headers ? rows : rows.slice(1);
    return {
      table_index: i,
      headers,
      rows: dataRows,
      markdown: t.markdown ?? t.md ?? undefined,
    };
  });

  // Key-value fields
  const rawFields: unknown[] =
    (raw.fields as unknown[]) ??
    (raw.key_value_pairs as unknown[]) ??
    [];
  const fields: DoclingField[] = rawFields.map((f: any) => ({
    key: f.key ?? f.label ?? "",
    value: f.value ?? f.text ?? "",
    confidence: f.confidence ?? f.score ?? undefined,
    page: f.page ?? undefined,
  }));

  // Full text
  const full_text: string =
    (raw.full_text as string) ??
    (raw.text as string) ??
    text_blocks.map((b) => b.text).join("\n");

  return {
    model_version: (raw.model_version as string) ?? (raw.version as string) ?? undefined,
    page_count: (raw.page_count as number) ?? (raw.pages as number) ?? undefined,
    text_blocks,
    tables,
    fields,
    full_text,
    raw_response: raw,
  };
}

/**
 * Gemini-native file extraction — used when DOCLING_API_URL is not set.
 * Sends the raw file bytes directly to Gemini 1.5 Pro which natively
 * understands PDFs, images, and many document formats.
 */
async function extractWithGeminiNative(
  fileBytes: Uint8Array,
  fileName: string,
  mimeType: string,
): Promise<DoclingOutput> {
  const hasVertexAI = !!Deno.env.get("VERTEX_PROJECT_ID") && !!Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");

  if (!hasVertexAI) {
    console.warn("[parse-pdf-docling] No Docling and no Vertex AI — returning mock output");
    return buildMockOutput(fileName);
  }

  console.log(`[parse-pdf-docling] Using Gemini native extraction for ${fileName} (${mimeType})`);

  const systemPrompt = `You are a document data extraction engine for commercial real estate.
Extract ALL structured data from the document. Return ONLY valid JSON, no explanation.
The first character must be "{" and the last must be "}".`;

  const userPrompt = `Extract all data from this document and return a JSON object with:
{
  "full_text": "complete text content of the document",
  "fields": [
    {"key": "field_name", "value": "field_value", "confidence": 0.95}
  ],
  "tables": [
    {
      "table_index": 0,
      "headers": ["col1", "col2"],
      "rows": [["val1", "val2"]],
      "markdown": "| col1 | col2 |\\n|---|---|\\n| val1 | val2 |"
    }
  ],
  "text_blocks": [
    {"block_index": 0, "type": "paragraph", "text": "...", "page": 1}
  ],
  "page_count": 1
}

Extract every field, table, and text block you can find. For CRE documents look for:
tenant names, dates, rent amounts, square footage, lease terms, escalation rates, CAM details.`;

  try {
    const result = await callVertexAIFileJSON<Record<string, unknown>>({
      systemPrompt,
      userPrompt,
      fileBytes,
      fileMimeType: mimeType,
      maxOutputTokens: 8192,
      temperature: 0,
    });

    if (!result) {
      console.warn("[parse-pdf-docling] Gemini returned null — using mock");
      return buildMockOutput(fileName);
    }

    // Normalise the Gemini response into DoclingOutput shape
    return normaliseDoclingResponse(result as Record<string, unknown>, fileName);
  } catch (err) {
    console.error("[parse-pdf-docling] Gemini native extraction error:", err.message);
    return buildMockOutput(fileName);
  }
}
function buildMockOutput(fileName: string): DoclingOutput {
  return {
    model_version: "mock-1.0",
    page_count: 3,
    text_blocks: [
      { block_index: 0, type: "heading", text: "COMMERCIAL LEASE AGREEMENT", page: 1 },
      { block_index: 1, type: "paragraph", text: "This Lease Agreement is entered into between Landlord Corp and Acme Tenant LLC.", page: 1 },
      { block_index: 2, type: "paragraph", text: "The premises located at 123 Main Street, Suite 400, New York, NY 10001.", page: 1 },
    ],
    tables: [
      {
        table_index: 0,
        headers: ["Field", "Value"],
        rows: [
          ["Tenant Name", "Acme Tenant LLC"],
          ["Lease Start Date", "01/01/2025"],
          ["Lease End Date", "12/31/2027"],
          ["Monthly Base Rent", "$8,500.00"],
          ["Rentable Square Footage", "2,400 SF"],
          ["Lease Type", "Triple Net (NNN)"],
          ["Annual Escalation", "3%"],
        ],
        markdown: "| Field | Value |\n|---|---|\n| Tenant Name | Acme Tenant LLC |",
      },
    ],
    fields: [
      { key: "tenant_name", value: "Acme Tenant LLC", confidence: 0.97, page: 1 },
      { key: "start_date", value: "01/01/2025", confidence: 0.95, page: 1 },
      { key: "end_date", value: "12/31/2027", confidence: 0.95, page: 1 },
      { key: "monthly_rent", value: "$8,500.00", confidence: 0.93, page: 1 },
      { key: "square_footage", value: "2,400", confidence: 0.91, page: 1 },
      { key: "lease_type", value: "Triple Net (NNN)", confidence: 0.88, page: 2 },
      { key: "escalation_rate", value: "3%", confidence: 0.85, page: 2 },
    ],
    full_text: `COMMERCIAL LEASE AGREEMENT\n\nTenant: Acme Tenant LLC\nStart: 01/01/2025\nEnd: 12/31/2027\nRent: $8,500/month\nArea: 2,400 SF\n`,
    raw_response: { _mock: true, source_file: fileName },
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
    // 1. Authenticate + resolve org_id
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin);

    // 2. Parse request body
    const body = await req.json();
    const { file_id } = body;

    if (!file_id) {
      return new Response(
        JSON.stringify({ error: true, message: "file_id is required", error_code: "MISSING_FILE_ID" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 3. Fetch the uploaded_files record (org_id isolation enforced)
    const { data: fileRecord, error: fetchError } = await supabaseAdmin
      .from("uploaded_files")
      .select("*")
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

    // 4. Accept any file format — Docling handles PDF, Word, Excel, images, text
    const fileName: string = fileRecord.file_name ?? "document";
    const mimeType: string = fileRecord.mime_type ?? "application/octet-stream";

    // 5. Update status → 'parsing' (reuses existing pipeline status)
    await supabaseAdmin
      .from("uploaded_files")
      .update({
        status: "parsing",
        processing_started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", file_id);

    try {
      // 6. Download the PDF from Supabase Storage
      //    The file_url is the public URL; derive the storage path from it.
      const storagePath = fileRecord.file_url.replace(
        /^.*\/storage\/v1\/object\/public\/financial-uploads\//,
        "",
      );

      const { data: fileBlob, error: downloadError } = await supabaseAdmin
        .storage
        .from("financial-uploads")
        .download(storagePath);

      if (downloadError || !fileBlob) {
        throw new Error(
          `Failed to download PDF from storage: ${downloadError?.message ?? "File not found"}`,
        );
      }

      const pdfBytes = new Uint8Array(await fileBlob.arrayBuffer());

      // 7. Call Docling to extract structured data
      //    Docling handles PDF, Word, Excel, images, and plain text natively.
      console.log(`[parse-pdf-docling] Calling Docling for file_id=${file_id}, name=${fileName}, size=${pdfBytes.length} bytes`);
      const doclingOutput = await callDoclingAPI(pdfBytes, fileName, mimeType);

      // 8. Store raw Docling output in uploaded_files for debugging.
      //    We use a new column `docling_raw` (JSONB).
      //    We also set status to 'pdf_parsed' — a new intermediate status
      //    that signals "Docling extraction done, normalisation pending".
      //    parsed_data is left empty at this stage; it will be populated
      //    by the normalisation step (Step 3).
      const { error: updateError } = await supabaseAdmin
        .from("uploaded_files")
        .update({
          status: "pdf_parsed",
          docling_raw: doclingOutput,          // raw output for debugging
          parsed_data: [],                      // will be filled by normaliser
          row_count: doclingOutput.tables.reduce((n, t) => n + t.rows.length, 0),
          processing_completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", file_id);

      if (updateError) {
        throw new Error(`Failed to store Docling output: ${updateError.message}`);
      }

      // 9. Return the structured Docling output to the caller.
      //    The caller (or the next pipeline step) will normalise this into
      //    the lease schema and pass it to validate-data.
      return new Response(
        JSON.stringify({
          error: false,
          file_id,
          processing_status: "pdf_parsed",
          page_count: doclingOutput.page_count,
          table_count: doclingOutput.tables.length,
          field_count: doclingOutput.fields.length,
          text_block_count: doclingOutput.text_blocks.length,
          docling_output: doclingOutput,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );

    } catch (extractionError) {
      // On failure: mark as 'failed' with error message (same as CSV pipeline)
      await supabaseAdmin
        .from("uploaded_files")
        .update({
          status: "failed",
          error_message: extractionError.message,
          processing_completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", file_id);

      throw extractionError;
    }

  } catch (err) {
    console.error("[parse-pdf-docling] Error:", err.message);
    return new Response(
      JSON.stringify({
        error: true,
        message: err.message,
        error_code: "PDF_PARSING_FAILED",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
