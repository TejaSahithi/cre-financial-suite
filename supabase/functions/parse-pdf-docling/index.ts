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
 * Enhanced Docling API client with retry logic and better error handling
 *
 * Calls the Docling HTTP API with the file bytes. Supports PDF, Word, Excel, images, and text files.
 * If DOCLING_API_URL is not set, falls back to Gemini native extraction.
 * Includes retry logic for transient failures and comprehensive error handling.
 */
async function callDoclingAPI(fileBytes: Uint8Array, fileName: string, mimeType = "application/octet-stream"): Promise<DoclingOutput> {
  const doclingUrl = Deno.env.get("DOCLING_API_URL");

  // ── Mock mode (no Docling service configured) — try Gemini native ────────
  if (!doclingUrl) {
    console.warn("[parse-pdf-docling] DOCLING_API_URL not set — trying Gemini native extraction");
    return extractWithGeminiNative(fileBytes, fileName, mimeType);
  }

  // ── Real Docling call with retry logic ──────────────────────────────────
  const apiKey = Deno.env.get("DOCLING_API_KEY");
  const maxRetries = 3;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[parse-pdf-docling] Calling Docling API (attempt ${attempt}/${maxRetries}) for ${fileName}`);
      
      const formData = new FormData();
      formData.append(
        "file",
        new Blob([fileBytes], { type: mimeType }),
        fileName,
      );
      
      // Enhanced output format request based on file type
      let outputFormats = "text,tables,fields";
      if (mimeType.startsWith("image/")) {
        outputFormats = "text,fields"; // Images may not have tables
      } else if (mimeType.includes("word") || mimeType.includes("doc")) {
        outputFormats = "text,tables,fields"; // Word docs can have all formats
      }
      formData.append("output_formats", outputFormats);

      const headers: Record<string, string> = {};
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

      const response = await fetch(`${doclingUrl}/api/v1/convert`, {
        method: "POST",
        headers,
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const raw = await response.json();
        console.log(`[parse-pdf-docling] Docling API succeeded on attempt ${attempt}`);
        return normaliseDoclingResponse(raw, fileName);
      }

      const errText = await response.text().catch(() => "unknown error");
      console.error(`[parse-pdf-docling] Docling API returned ${response.status}: ${errText}`);

      // If it's a client error (4xx), don't retry - fall back to Gemini
      if (response.status >= 400 && response.status < 500) {
        console.log(`[parse-pdf-docling] Client error ${response.status}, falling back to Gemini`);
        return extractWithGeminiNative(fileBytes, fileName, mimeType);
      }

      // Server error (5xx) - retry with exponential backoff
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        console.log(`[parse-pdf-docling] Server error ${response.status}, retrying in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Final attempt failed - fall back to Gemini
      console.log(`[parse-pdf-docling] All Docling attempts failed, falling back to Gemini`);
      return extractWithGeminiNative(fileBytes, fileName, mimeType);

    } catch (err) {
      console.error(`[parse-pdf-docling] Docling attempt ${attempt} failed:`, err.message);
      
      if (err.name === 'AbortError') {
        console.log(`[parse-pdf-docling] Request timeout on attempt ${attempt}`);
      }
      
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.log(`[parse-pdf-docling] Retrying Docling in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // All attempts failed - fall back to Gemini
      console.log(`[parse-pdf-docling] All Docling attempts failed with errors, falling back to Gemini`);
      return extractWithGeminiNative(fileBytes, fileName, mimeType);
    }
  }

  // Should never reach here, but fallback just in case
  return extractWithGeminiNative(fileBytes, fileName, mimeType);
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
 * Enhanced Gemini-native file extraction with better format support
 * Used when DOCLING_API_URL is not set or when Docling API fails.
 * Sends the raw file bytes directly to Gemini 1.5 Pro which natively
 * understands PDFs, images, Word documents, Excel files, and many other formats.
 */
async function extractWithGeminiNative(
  fileBytes: Uint8Array,
  fileName: string,
  mimeType: string,
): Promise<DoclingOutput> {
  const hasVertexAI = !!Deno.env.get("VERTEX_PROJECT_ID") && !!Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");

  if (!hasVertexAI) {
    console.warn("[parse-pdf-docling] No Docling and no Vertex AI — returning enhanced mock output");
    return buildMockOutput(fileName, mimeType);
  }

  console.log(`[parse-pdf-docling] Using Gemini native extraction for ${fileName} (${mimeType})`);

  // Enhanced system prompt based on file type
  let systemPrompt = `You are a document data extraction engine for commercial real estate.
Extract ALL structured data from the document. Return ONLY valid JSON, no explanation.
The first character must be "{" and the last must be "}".`;

  // Customize extraction approach based on file type
  let extractionInstructions = "";
  if (mimeType.includes("pdf")) {
    extractionInstructions = "This is a PDF document. Extract all text, tables, and form fields.";
  } else if (mimeType.includes("word") || mimeType.includes("doc")) {
    extractionInstructions = "This is a Word document. Extract all text content, tables, and any structured data.";
  } else if (mimeType.includes("excel") || mimeType.includes("sheet")) {
    extractionInstructions = "This is an Excel spreadsheet. Extract all sheet data, preserving table structure.";
  } else if (mimeType.startsWith("image/")) {
    extractionInstructions = "This is an image document. Use OCR to extract all visible text and any table structures.";
  } else {
    extractionInstructions = "Extract all structured data from this document.";
  }

  const userPrompt = `${extractionInstructions}

Extract all data from this document and return a JSON object with:
{
  "full_text": "complete text content of the document",
  "fields": [
    {"key": "field_name", "value": "field_value", "confidence": 0.95, "page": 1}
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
- Tenant/lessee names and contact information
- Landlord/lessor information  
- Property addresses and descriptions
- Lease dates (start, end, commencement)
- Rent amounts (base rent, additional rent, escalations)
- Square footage and measurements
- Lease terms and conditions
- CAM (Common Area Maintenance) details
- Security deposits and fees
- Assignment and subletting clauses
- Any financial data, dates, or structured information

Be thorough and extract ALL data, even if it seems minor.`;

  const maxRetries = 2;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[parse-pdf-docling] Gemini extraction attempt ${attempt}/${maxRetries}`);
      
      const result = await callVertexAIFileJSON<Record<string, unknown>>({
        systemPrompt,
        userPrompt,
        fileBytes,
        fileMimeType: mimeType,
        maxOutputTokens: 8192,
        temperature: 0,
      });

      if (result && typeof result === 'object') {
        console.log(`[parse-pdf-docling] Gemini extraction succeeded on attempt ${attempt}`);
        // Normalise the Gemini response into DoclingOutput shape
        return normaliseDoclingResponse(result as Record<string, unknown>, fileName);
      }

      console.warn(`[parse-pdf-docling] Gemini returned invalid result on attempt ${attempt}`);
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
        continue;
      }

    } catch (err) {
      console.error(`[parse-pdf-docling] Gemini extraction attempt ${attempt} failed:`, err.message);
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
    }
  }

  console.warn("[parse-pdf-docling] All Gemini attempts failed — using enhanced mock");
  return buildMockOutput(fileName, mimeType);
}
/** Enhanced mock output generator based on file type */
function buildMockOutput(fileName: string, mimeType = "application/octet-stream"): DoclingOutput {
  // Customize mock data based on file type
  let mockData = {
    model_version: "mock-1.0",
    page_count: 1,
    text_blocks: [] as DoclingTextBlock[],
    tables: [] as DoclingTable[],
    fields: [] as DoclingField[],
    full_text: "",
    raw_response: { _mock: true, source_file: fileName, mime_type: mimeType },
  };

  if (mimeType.includes("pdf") || fileName.toLowerCase().includes("lease")) {
    // PDF or lease document mock
    mockData = {
      ...mockData,
      page_count: 3,
      text_blocks: [
        { block_index: 0, type: "heading", text: "COMMERCIAL LEASE AGREEMENT", page: 1 },
        { block_index: 1, type: "paragraph", text: "This Lease Agreement is entered into between Landlord Corp and Acme Tenant LLC.", page: 1 },
        { block_index: 2, type: "paragraph", text: "The premises located at 123 Main Street, Suite 400, New York, NY 10001.", page: 1 },
        { block_index: 3, type: "paragraph", text: "Term: 36 months commencing January 1, 2025", page: 2 },
        { block_index: 4, type: "paragraph", text: "Base Rent: $8,500.00 per month", page: 2 },
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
          markdown: "| Field | Value |\n|---|---|\n| Tenant Name | Acme Tenant LLC |\n| Lease Start Date | 01/01/2025 |",
        },
      ],
      fields: [
        { key: "tenant_name", value: "Acme Tenant LLC", confidence: 0.97, page: 1 },
        { key: "start_date", value: "01/01/2025", confidence: 0.95, page: 1 },
        { key: "end_date", value: "12/31/2027", confidence: 0.95, page: 1 },
        { key: "monthly_rent", value: "$8,500.00", confidence: 0.93, page: 2 },
        { key: "square_footage", value: "2,400", confidence: 0.91, page: 1 },
        { key: "lease_type", value: "Triple Net (NNN)", confidence: 0.88, page: 2 },
        { key: "escalation_rate", value: "3%", confidence: 0.85, page: 2 },
      ],
      full_text: `COMMERCIAL LEASE AGREEMENT\n\nTenant: Acme Tenant LLC\nLandlord: Landlord Corp\nPremises: 123 Main Street, Suite 400, New York, NY 10001\nTerm: 36 months\nStart: 01/01/2025\nEnd: 12/31/2027\nBase Rent: $8,500/month\nSquare Footage: 2,400 SF\nLease Type: Triple Net (NNN)\nAnnual Escalation: 3%`,
    };
  } else if (mimeType.includes("excel") || mimeType.includes("sheet")) {
    // Excel spreadsheet mock
    mockData = {
      ...mockData,
      tables: [
        {
          table_index: 0,
          headers: ["Property", "Tenant", "Rent", "Start Date", "End Date"],
          rows: [
            ["123 Main St", "Acme Corp", "$5,000", "2024-01-01", "2026-12-31"],
            ["456 Oak Ave", "Beta LLC", "$7,500", "2024-03-01", "2027-02-28"],
            ["789 Pine Rd", "Gamma Inc", "$6,200", "2024-06-01", "2027-05-31"],
          ],
          markdown: "| Property | Tenant | Rent | Start Date | End Date |\n|---|---|---|---|---|\n| 123 Main St | Acme Corp | $5,000 | 2024-01-01 | 2026-12-31 |",
        },
      ],
      fields: [
        { key: "total_properties", value: "3", confidence: 1.0, page: 1 },
        { key: "total_monthly_rent", value: "$18,700", confidence: 0.95, page: 1 },
      ],
      full_text: "Property\tTenant\tRent\tStart Date\tEnd Date\n123 Main St\tAcme Corp\t$5,000\t2024-01-01\t2026-12-31\n456 Oak Ave\tBeta LLC\t$7,500\t2024-03-01\t2027-02-28\n789 Pine Rd\tGamma Inc\t$6,200\t2024-06-01\t2027-05-31",
    };
  } else if (mimeType.includes("word") || mimeType.includes("doc")) {
    // Word document mock
    mockData = {
      ...mockData,
      page_count: 2,
      text_blocks: [
        { block_index: 0, type: "heading", text: "Property Management Report", page: 1 },
        { block_index: 1, type: "paragraph", text: "Monthly summary for December 2024", page: 1 },
        { block_index: 2, type: "paragraph", text: "Total occupied units: 45 out of 50", page: 1 },
        { block_index: 3, type: "paragraph", text: "Occupancy rate: 90%", page: 1 },
      ],
      fields: [
        { key: "report_month", value: "December 2024", confidence: 0.98, page: 1 },
        { key: "occupied_units", value: "45", confidence: 0.95, page: 1 },
        { key: "total_units", value: "50", confidence: 0.95, page: 1 },
        { key: "occupancy_rate", value: "90%", confidence: 0.93, page: 1 },
      ],
      full_text: "Property Management Report\nMonthly summary for December 2024\nTotal occupied units: 45 out of 50\nOccupancy rate: 90%",
    };
  } else if (mimeType.startsWith("image/")) {
    // Image document mock (OCR simulation)
    mockData = {
      ...mockData,
      text_blocks: [
        { block_index: 0, type: "paragraph", text: "LEASE AGREEMENT", page: 1 },
        { block_index: 1, type: "paragraph", text: "Tenant: John Doe", page: 1 },
        { block_index: 2, type: "paragraph", text: "Monthly Rent: $2,500", page: 1 },
      ],
      fields: [
        { key: "tenant_name", value: "John Doe", confidence: 0.85, page: 1 },
        { key: "monthly_rent", value: "$2,500", confidence: 0.80, page: 1 },
      ],
      full_text: "LEASE AGREEMENT\nTenant: John Doe\nMonthly Rent: $2,500",
    };
  } else {
    // Generic text document mock
    mockData = {
      ...mockData,
      text_blocks: [
        { block_index: 0, type: "paragraph", text: "Document content extracted from " + fileName, page: 1 },
        { block_index: 1, type: "paragraph", text: "This is a sample text extraction.", page: 1 },
      ],
      fields: [
        { key: "document_name", value: fileName, confidence: 1.0, page: 1 },
      ],
      full_text: `Document content extracted from ${fileName}\nThis is a sample text extraction.`,
    };
  }

  return mockData;
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

    // 4. Enhanced file format validation and support
    const fileName: string = fileRecord.file_name ?? "document";
    const mimeType: string = fileRecord.mime_type ?? "application/octet-stream";
    
    // Log file details for debugging
    console.log(`[parse-pdf-docling] Processing file: ${fileName}, MIME: ${mimeType}, Size: ${fileRecord.file_size || 'unknown'} bytes`);
    
    // Validate file format support
    const supportedFormats = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
      'text/csv',
      'image/jpeg',
      'image/png',
      'image/tiff',
      'image/webp',
      'image/gif',
      'image/bmp',
      'application/octet-stream' // Generic fallback
    ];
    
    const isSupported = supportedFormats.some(format => mimeType.includes(format.split('/')[1])) || 
                       mimeType.startsWith('image/') || 
                       mimeType.startsWith('text/');
    
    if (!isSupported && mimeType !== 'application/octet-stream') {
      console.warn(`[parse-pdf-docling] Potentially unsupported MIME type: ${mimeType}, proceeding with extraction attempt`);
    }

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

      const fileBytes = new Uint8Array(await fileBlob.arrayBuffer());

      // 7. Call shared parsing utility (includes OCR fallback)
      const { parseDocument } = await import("../_shared/extraction/parser.ts");
      const doclingOutput = await parseDocument(fileBytes, fileName, mimeType);
      const extractionMethod = doclingOutput.extraction_method || "unknown";

      // 8. Store extraction results with metadata
      const extractionMetadata = {
        extraction_method: extractionMethod,
        file_format: mimeType,
        page_count: doclingOutput.page_count || 1,
        table_count: doclingOutput.tables.length,
        field_count: doclingOutput.fields.length,
        text_block_count: doclingOutput.text_blocks.length,
        has_content: !!(doclingOutput.full_text || doclingOutput.tables.length || doclingOutput.fields.length),
        extraction_timestamp: new Date().toISOString(),
      };
      
      const { error: updateError } = await supabaseAdmin
        .from("uploaded_files")
        .update({
          status: "pdf_parsed",
          docling_raw: {
            ...doclingOutput,
            _metadata: extractionMetadata
          },
          parsed_data: [],
          row_count: doclingOutput.tables.reduce((n, t) => n + t.rows.length, 0),
          processing_completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", file_id);

      if (updateError) {
        throw new Error(`Failed to store extraction results: ${updateError.message}`);
      }

      console.log(`[parse-pdf-docling] Successfully stored extraction results using ${extractionMethod} method`);

      // 9. Return enhanced structured output to the caller
      return new Response(
        JSON.stringify({
          error: false,
          file_id,
          processing_status: "pdf_parsed",
          extraction_method: extractionMethod,
          file_format: mimeType,
          page_count: doclingOutput.page_count,
          table_count: doclingOutput.tables.length,
          field_count: doclingOutput.fields.length,
          text_block_count: doclingOutput.text_blocks.length,
          has_content: extractionMetadata.has_content,
          content_summary: {
            text_length: doclingOutput.full_text?.length || 0,
            tables_found: doclingOutput.tables.length > 0,
            fields_found: doclingOutput.fields.length > 0,
            structured_data: doclingOutput.tables.length > 0 || doclingOutput.fields.length > 0
          },
          docling_output: doclingOutput,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );

    } catch (extractionError) {
      // Enhanced failure handling with detailed error information
      console.error(`[parse-pdf-docling] Extraction process failed:`, extractionError.message);
      
      const errorDetails = {
        error_type: "extraction_failed",
        file_name: fileName,
        mime_type: mimeType,
        file_size: fileRecord.file_size || 0,
        error_message: extractionError.message,
        timestamp: new Date().toISOString(),
      };
      
      await supabaseAdmin
        .from("uploaded_files")
        .update({
          status: "failed",
          error_message: `Document extraction failed: ${extractionError.message}`,
          docling_raw: { _error: errorDetails }, // Store error details for debugging
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
