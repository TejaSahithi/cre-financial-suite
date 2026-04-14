/**
 * Scratch script to test PaddleOCR bridge independently.
 * Run with: deno run --allow-all test_ocr.ts
 */

import { runPaddleOCR } from "./supabase/functions/_shared/ocr/paddle-ocr.ts";

async function test() {
  console.log("Starting PaddleOCR test...");
  
  // We need a sample file. If none exists, we'll hit an error but verify the bridge logic.
  const testFile = "sample_scanned.png"; 
  
  try {
    const result = await runPaddleOCR(testFile);
    console.log("OCR Result:", result);
  } catch (err) {
    console.error("Test failed as expected or unexpected:", err.message);
  }
}

test();
