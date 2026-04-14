/**
 * scratch/verify_extraction_e2e.ts
 * 
 * Direct test for the extraction pipeline using local PaddleOCR and Vertex AI.
 * Bypasses the UI to verify the backend logic.
 */

import { parseDocument } from "../supabase/functions/_shared/extraction/parser.ts";
import { runExtractionPipeline } from "../supabase/functions/_shared/extraction/pipeline.ts";
import { ExtractionInput, ExtractionOptions } from "../supabase/functions/_shared/extraction/types.ts";

const TEST_FILE = "test_scanned.png";

async function runTest() {
  console.log("--- Extraction E2E Verification ---");
  
  try {
    // 1. Load test file
    console.log(`[test] Reading ${TEST_FILE}...`);
    const fileBytes = await Deno.readFile(TEST_FILE);
    
    // 2. Parse (should trigger PaddleOCR since it's an image)
    console.log("[test] Calling parseDocument...");
    const parsed = await parseDocument(fileBytes, TEST_FILE, "image/png");
    
    console.log("\n--- Parsing Result ---");
    console.log(`Method: ${parsed.extraction_method}`);
    console.log(`Text Length: ${parsed.full_text?.length ?? 0} characters`);
    if (parsed.warnings && parsed.warnings.length > 0) {
      console.warn("Warnings:", parsed.warnings);
    }
    
    if (!parsed.full_text || parsed.full_text.length < 10) {
      console.error("FAILED: OCR extracted no meaningful text.");
      return;
    }

    // 3. Run Extraction Pipeline
    console.log("\n[test] Running Extraction Pipeline (LLM Step)...");
    const input: ExtractionInput = {
      docling: parsed,
      fileName: TEST_FILE,
      moduleType: "lease"
    };
    
    const options: ExtractionOptions = {
      skipLLM: false,
      confidenceThreshold: 0.1 // lower threshold for testing
    };

    const result = await runExtractionPipeline(input, options);

    console.log("\n--- Extraction Result ---");
    console.log(`Final Method: ${result.method}`);
    console.log(`Total Rows: ${result.rows.length}`);
    
    if (result.rows.length > 0) {
      console.log("Sample Row Fields:", Object.keys(result.rows[0]));
      console.log("JSON Preview:", JSON.stringify(result.rows[0], null, 2));
    } else {
      console.warn("WARNING: No rows extracted.");
    }

    if (result.warnings && result.warnings.length > 0) {
      console.warn("\nPipeline Warnings:", result.warnings);
    }

  } catch (err) {
    console.error("\nERROR during test:", err.message);
  }
}

runTest();
