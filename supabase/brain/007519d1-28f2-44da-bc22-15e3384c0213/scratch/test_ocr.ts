/**
 * Scratch script to test PaddleOCR bridge independently.
 * Run with: deno run --allow-all test_ocr.ts
 */

// Use relative path from the scratch directory to the shared functions
import { runPaddleOCR } from "../../../../../supabase/functions/_shared/ocr/paddle-ocr.ts";

async function test() {
  console.log("Starting PaddleOCR test...");
  
  // path to the image we generated
  const testFile = "test_scanned.png"; 
  
  try {
    const result = await runPaddleOCR(testFile);
    console.log("OCR Result Found Blocks:", result.text_blocks.length);
    console.log("OCR Full Text Snippet:", result.full_text.substring(0, 100));
    console.log("Source Verified:", result.raw_response?.source);
  } catch (err) {
    console.error("Test failed:", err.message);
  }
}

test();
