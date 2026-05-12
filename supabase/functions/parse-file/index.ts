// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { setStatus, setFailed, STATUS_PROGRESS } from "../_shared/pipeline-status.ts";
import { createLogger } from "../_shared/logger.ts";
import { parseLeases } from "../_shared/parsers/lease-parser.ts";
import { parseExpenses } from "../_shared/parsers/expense-parser.ts";
import { parseProperties } from "../_shared/parsers/property-parser.ts";
import { parseRevenues } from "../_shared/parsers/revenue-parser.ts";
import * as XLSX from "npm:xlsx";

/**
 * Parse File Edge Function
 * Reads file from Supabase Storage, parses to JSON, updates processing_status
 * 
 * Requirements: 2.1, 2.3, 2.4, 2.5, 2.6
 * Tasks: 3.1, 3.2
 */

interface ParsedRow {
  [key: string]: string | number | null;
}

interface ParseResult {
  rows: ParsedRow[];
  headers: string[];
  rowCount: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    // Get file_id from request body
    const body = await req.json();
    const { file_id } = body;

    if (!file_id) {
      throw new Error('file_id is required');
    }

    // Fetch the uploaded_files record
    const { data: fileRecord, error: fetchError } = await supabaseAdmin
      .from('uploaded_files')
      .select('*')
      .eq('id', file_id)
      .eq('org_id', orgId)
      .single();

    if (fetchError || !fileRecord) {
      throw new Error(`File not found: ${fetchError?.message || 'Invalid file_id'}`);
    }

    // Update status to 'parsing'
    const { error: parsingStatusError } = await setStatus(supabaseAdmin, file_id, "parsing", {
      processing_started_at: new Date().toISOString(),
    });
    if (parsingStatusError) {
      throw new Error(`Failed to transition file to parsing: ${parsingStatusError.message}`);
    }

    const log = createLogger(supabaseAdmin, file_id, orgId);
    await log.info("parse", `Started parsing file: ${fileRecord.file_name}`);

    try {
      // Read file from Supabase Storage
      const storagePath = fileRecord.file_url.replace(/^.*\/storage\/v1\/object\/public\/financial-uploads\//, '');
      
      const { data: fileData, error: downloadError } = await supabaseAdmin
        .storage
        .from('financial-uploads')
        .download(storagePath);

      if (downloadError || !fileData) {
        throw new Error(`Failed to download file: ${downloadError?.message || 'File not found in storage'}`);
      }

      // Read binary data
      const buffer = await fileData.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const firstSheetName = workbook.SheetNames[0];
      
      if (!firstSheetName) {
        throw new Error('File contains no worksheets or data');
      }
      
      const worksheet = workbook.Sheets[firstSheetName];
      const rawRows: ParsedRow[] = XLSX.utils.sheet_to_json(worksheet, { defval: null });
      
      let headers: string[] = [];
      if (rawRows.length > 0) {
        headers = Object.keys(rawRows[0]);
      } else {
        const headerRow = XLSX.utils.sheet_to_json(worksheet, { header: 1 })[0] as string[];
        headers = headerRow || [];
      }
      
      const parseResult: ParseResult = {
        rows: rawRows,
        headers,
        rowCount: rawRows.length
      };

      // Apply module-specific parser based on file type
      let finalParsedData = parseResult.rows;
      if (fileRecord.module_type === 'leases') {
        const leaseParseResult = parseLeases(parseResult.rows);
        finalParsedData = leaseParseResult.rows;
      } else if (fileRecord.module_type === 'expenses') {
        const expenseParseResult = parseExpenses(parseResult.rows);
        finalParsedData = expenseParseResult.rows;
      } else if (fileRecord.module_type === 'properties') {
        const propertyParseResult = parseProperties(parseResult.rows);
        finalParsedData = propertyParseResult.rows;
      } else if (fileRecord.module_type === 'revenue') {
        const revenueParseResult = parseRevenues(parseResult.rows);
        finalParsedData = revenueParseResult.rows;
      }

      // Update uploaded_files with parsed data and status='parsed'
      const { error: updateError } = await supabaseAdmin
        .from('uploaded_files')
        .update({
          parsed_data: finalParsedData,
          row_count: finalParsedData.length,
        })
        .eq('id', file_id);

      if (updateError) {
        throw new Error(`Failed to update file record: ${updateError.message}`);
      }

      await setStatus(supabaseAdmin, file_id, "parsed", {
        processing_completed_at: new Date().toISOString(),
      });

      await log.info("parse", `Parsed ${finalParsedData.length} rows`, { row_count: finalParsedData.length });

      return new Response(
        JSON.stringify({
          error: false,
          file_id,
          processing_status: 'parsed',
          parsed_data: finalParsedData,
          row_count: finalParsedData.length,
          headers: parseResult.headers
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } catch (parseError) {
      await log.error("parse", parseError.message, { file_name: fileRecord.file_name });
      await setFailed(supabaseAdmin, file_id, parseError.message, "parsing", STATUS_PROGRESS.parsing);
      throw parseError;
    }

  } catch (err) {
    console.error("[parse-file] Error:", err.message);
    return new Response(
      JSON.stringify({ 
        error: true, 
        message: err.message,
        error_code: 'PARSING_FAILED'
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
