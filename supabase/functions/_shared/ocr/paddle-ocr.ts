/**
 * supabase/functions/_shared/ocr/paddle-ocr.ts
 * 
 * Invokes a local Python script running PaddleOCR to extract text
 * from a scanned PDF or image.
 */

export async function runPaddleOCR(filePath: string): Promise<string> {
  console.log(`[paddle-ocr] Running OCR on: ${filePath}`);

  // Resolve the path to the python script correctly in the edge/local context
  const scriptPath = new URL('./ocr_script.py', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

  // Detect platform correctly to map binary runner specifically for Python 3.12 
  // on local environments vs containerized supabase functions 
  const isWindows = Deno.build.os === "windows";
  const cmd = isWindows ? "py" : "python3";
  const cmdArgs = isWindows ? ["-3.12", scriptPath, filePath] : [scriptPath, filePath];

  const command = new Deno.Command(cmd, {
    args: cmdArgs,
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();
  const errorText = new TextDecoder().decode(stderr);
  
  if (code !== 0) {
    throw new Error(`[paddle-ocr] OCR failed with exit code ${code}: ${errorText}`);
  }

  let extractedText = new TextDecoder().decode(stdout);
  
  return cleanOCRText(extractedText);
}

/**
 * Removes excess whitespace, weird OCR artifacts, and normalizes output.
 */
function cleanOCRText(text: string): string {
  if (!text) return "";
  
  // Replace multiple newlines with a single newline
  let cleaned = text.replace(/\n{3,}/g, '\n\n');
  
  // Replace multiple spaces with a single space
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
  
  // Strip out meaningless noise/symbols if necessary
  cleaned = cleaned.replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '');

  return cleaned.trim();
}
