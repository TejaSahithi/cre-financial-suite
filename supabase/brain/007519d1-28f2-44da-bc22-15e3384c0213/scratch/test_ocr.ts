/**
 * Scratch script to test Gemini Vision OCR bridge independently.
 * Run with: deno run --allow-all --allow-env test_ocr.ts
 */

// Use relative path from the scratch directory to the shared functions
import { runPaddleOCR } from "../../../../../supabase/functions/_shared/ocr/paddle-ocr.ts";

async function test() {
  console.log("Starting Gemini Vision OCR test...");

  // Read a test image file
  const testFile = "test_scanned.png";

  try {
    const fileBytes = await Deno.readFile(testFile);
    const result = await runPaddleOCR(fileBytes, "image/png");
    console.log("OCR Result Length:", result.length, "chars");
    console.log("OCR Text Snippet:", result.substring(0, 200));
  } catch (err) {
    console.error("Test failed:", (err as Error).message);
  }
}

test();
