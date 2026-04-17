// @ts-nocheck
/**
 * Canonical document parser — `parseDocument()`
 *
 * ONE entry point, used by every edge function that needs structured
 * parsing output (parse-pdf-docling, normalize-pdf-output, the retry
 * path, future review-approve refreshes). No other function may call
 * Docling or Gemini Vision directly.
 *
 * §4 Strategy matrix (from the principal engineer review):
 *
 *   ┌──────────────────────┬─────────────────────────────────────────┐
 *   │ Input profile        │ Strategy                                │
 *   ├──────────────────────┼─────────────────────────────────────────┤
 *   │ Digital PDF (text)   │ Docling only. Skip Vision.              │
 *   │ Scanned PDF / image  │ Vision first. Docling afterwards if it  │
 *   │                      │ adds structured tables.                 │
 *   │ DOCX / native office │ Docling only. Vision not useful.        │
 *   │ Unknown / mixed      │ Parallel Docling + Vision, merge best.  │
 *   │ Docling unreachable  │ Vision only (auto-fallback).            │
 *   │ Vision unavailable   │ Docling only (graceful degrade).        │
 *   └──────────────────────┴─────────────────────────────────────────┘
 *
 * "Scanned" is detected by a quick heuristic on the downloaded bytes
 * (PDF text stream ratio) and also as a post-hoc check if Docling
 * returns fewer than MIN_DIGITAL_BLOCKS text blocks.
 */

import type {
  DoclingOutput,
  DoclingTextBlock,
  DoclingTable,
  DoclingField,
} from "./types.ts";
import { extractVisibleKeyValues, runPaddleOCR } from "../ocr/paddle-ocr.ts";

const MIN_DIGITAL_BLOCKS = 5;       // below this, a PDF is treated as scanned
const SCAN_TEXT_RATIO_THRESHOLD = 0.02; // <2% printable text → scanned

type Strategy = "docling_only" | "vision_only" | "vision_first" | "parallel";

interface ParseContext {
  fileBytes: Uint8Array;
  fileName: string;
  mimeType: string;
  hasDocling: boolean;
  hasVision: boolean;
  strategy: Strategy;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function parseDocument(
  fileBytes: Uint8Array,
  fileName: string,
  mimeType: string = "application/pdf",
): Promise<DoclingOutput> {
  const nativePdfOutput = await parseNativePdfText(fileBytes, fileName, mimeType);
  if (nativePdfOutput && (nativePdfOutput.full_text?.trim().length ?? 0) > 20) {
    console.log(
      `[parser] Native PDF parser extracted ${nativePdfOutput.full_text?.length ?? 0} chars from "${fileName}"`,
    );
    return tag(nativePdfOutput, "pdf_text");
  }

  const officeOutput = await parseOfficeOpenXml(fileBytes, fileName, mimeType);
  if (officeOutput && (officeOutput.full_text?.trim().length ?? 0) > 20) {
    console.log(
      `[parser] OpenXML parser extracted ${officeOutput.full_text?.length ?? 0} chars from "${fileName}"`,
    );
    return tag(officeOutput, "openxml");
  }

  const hasDocling = !!Deno.env.get("DOCLING_API_URL");
  const hasVision = !!(
    (Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID")) &&
    (Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || Deno.env.get("GOOGLE_PRIVATE_KEY"))
  );

  const strategy = pickStrategy({ mimeType, fileBytes, hasDocling, hasVision });
  const ctx: ParseContext = {
    fileBytes,
    fileName,
    mimeType,
    hasDocling,
    hasVision,
    strategy,
  };

  console.log(
    `[parser] file="${fileName}" mime=${mimeType} ` +
    `hasDocling=${hasDocling} hasVision=${hasVision} strategy=${strategy}`,
  );

  switch (strategy) {
    case "docling_only":  return await runDoclingOnly(ctx);
    case "vision_only":   return await runVisionOnly(ctx);
    case "vision_first":  return await runVisionFirst(ctx);
    case "parallel":      return await runParallel(ctx);
  }
}

// ── Strategy selection ──────────────────────────────────────────────────────

function pickStrategy(args: {
  mimeType: string;
  fileBytes: Uint8Array;
  hasDocling: boolean;
  hasVision: boolean;
}): Strategy {
  const { mimeType, fileBytes, hasDocling, hasVision } = args;

  // 0. Hard availability constraints
  if (!hasDocling && !hasVision) {
    // Neither backend available — still return vision_only so the
    // downstream code produces a clear error rather than mock data.
    return "vision_only";
  }
  if (!hasDocling) return "vision_only";
  if (!hasVision)  return "docling_only";

  // 1. Images — Vision handles these natively; Docling rarely helps.
  if (mimeType.startsWith("image/")) return "vision_only";

  // 2. Native office formats — digital; Vision adds no value.
  if (
    mimeType.includes("word") ||
    mimeType.includes("officedocument.wordprocessingml") ||
    mimeType.includes("officedocument.spreadsheetml") ||
    mimeType.includes("vnd.ms-excel") ||
    mimeType === "text/plain" ||
    mimeType === "text/csv"
  ) {
    return "docling_only";
  }

  // 3. PDFs — look at the bytes to decide
  if (mimeType.includes("pdf")) {
    return looksLikeScannedPdf(fileBytes) ? "vision_first" : "docling_only";
  }

  // 4. Unknown — race both, take the better result
  return "parallel";
}

/**
 * Lightweight heuristic on raw PDF bytes. A digitally-authored PDF has
 * streams containing a significant proportion of printable ASCII text
 * (Tj / TJ operators write literal characters). A scanned PDF is mostly
 * image streams and binary xref data, so the printable ratio drops to
 * a few per cent.
 *
 * This runs on the whole file (usually ≤ 50 MB per upload-handler limit)
 * but only reads bytes, no parsing — linear, allocates nothing.
 */
function looksLikeScannedPdf(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length === 0) return false;
  // Sample at most the first 256 KB for speed on large files.
  const sampleLen = Math.min(bytes.length, 256 * 1024);
  let printable = 0;
  for (let i = 0; i < sampleLen; i++) {
    const b = bytes[i];
    // tab, LF, CR, printable ASCII
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) printable++;
  }
  const ratio = printable / sampleLen;
  if (ratio < SCAN_TEXT_RATIO_THRESHOLD) return true;

  const sampleText = new TextDecoder("latin1", { fatal: false })
    .decode(bytes.slice(0, sampleLen));
  const imageMarkers = (sampleText.match(/\/(?:Image|XObject|DCTDecode|JPXDecode|FlateDecode)/g) ?? []).length;
  const textOperators = (sampleText.match(/\b(?:BT|ET|Tj|TJ|Tf|Td|Tm)\b/g) ?? []).length;

  // Scanned leases are usually image streams wrapped in a PDF shell.
  // They can still have a high printable ratio because PDF syntax itself is
  // printable, so use image-vs-text structure as the stronger signal.
  return imageMarkers >= 3 && textOperators < 5;
}

// ── Strategy implementations ────────────────────────────────────────────────

async function runDoclingOnly(ctx: ParseContext): Promise<DoclingOutput> {
  const doclingOutput = await callDocling(ctx);
  if (doclingOutput && (doclingOutput.text_blocks?.length ?? 0) >= MIN_DIGITAL_BLOCKS) {
    return tag(doclingOutput, "docling");
  }

  // Docling returned empty/sparse output — promote to vision fallback if we
  // actually have Vision configured. Otherwise return what we have.
  if (ctx.hasVision && canVisionHandle(ctx.mimeType)) {
    console.warn(
      `[parser] Docling returned ${doclingOutput?.text_blocks?.length ?? 0} blocks — ` +
      `promoting to Vision fallback`,
    );
    return await runVisionFirst({ ...ctx, strategy: "vision_first" });
  }

  return tag(doclingOutput ?? emptyOutput(), "docling");
}

async function runVisionOnly(ctx: ParseContext): Promise<DoclingOutput> {
  if (!ctx.hasVision) {
    return tag(emptyOutput([
      "No parser backend available. Set DOCLING_API_URL or Vertex AI credentials.",
    ]), "none");
  }
  try {
    const ocrText = await runPaddleOCR(ctx.fileBytes, ctx.mimeType);
    const output = ocrTextToDocling(ocrText);
    output.fields = await safeExtractVisibleFields(ctx);
    return tag(output, "gemini_vision");
  } catch (err) {
    console.warn(`[parser] Vision OCR failed: ${err.message}`);
    if (ctx.hasDocling && canDoclingHandle(ctx.mimeType)) {
      const doclingOutput = await callDocling(ctx);
      if (doclingOutput) {
        return tag(doclingOutput, "docling");
      }
    }
    return tag(emptyOutput([`Vision OCR failed: ${err.message}`]), "none");
  }
}

/**
 * Vision-first: run OCR to capture all text (including stamps / handwriting
 * / low-contrast scans), then *if Docling is available* also run it to
 * pick up any structured tables. Merge: Vision's text_blocks + Docling's
 * tables whenever Docling returns ≥1 table.
 */
async function runVisionFirst(ctx: ParseContext): Promise<DoclingOutput> {
  if (!ctx.hasVision) {
    return await runDoclingOnly(ctx);
  }

  let visionOutput: DoclingOutput | null = null;
  try {
    const ocrText = await runPaddleOCR(ctx.fileBytes, ctx.mimeType);
    visionOutput = ocrTextToDocling(ocrText);
    visionOutput.fields = await safeExtractVisibleFields(ctx);
  } catch (err) {
    console.warn(`[parser] Vision-first OCR failed, falling back to Docling: ${err.message}`);
    if (ctx.hasDocling && canDoclingHandle(ctx.mimeType)) {
      const doclingOutput = await callDocling(ctx);
      if (doclingOutput) return tag(doclingOutput, "docling");
    }
    return tag(emptyOutput([`Vision OCR failed: ${err.message}`]), "none");
  }

  if (!ctx.hasDocling || !canDoclingHandle(ctx.mimeType)) {
    return tag(visionOutput, "gemini_vision");
  }

  // Try Docling as a structural supplement. Failure is non-fatal.
  let doclingOutput: DoclingOutput | null = null;
  try {
    doclingOutput = await callDocling(ctx);
  } catch (err) {
    console.warn(`[parser] Docling supplement failed: ${err.message}`);
  }

  if (doclingOutput && (doclingOutput.tables?.length ?? 0) > 0) {
    return tag({
      ...visionOutput,
      tables: doclingOutput.tables,
      fields: doclingOutput.fields?.length
        ? doclingOutput.fields
        : visionOutput.fields,
    }, "hybrid");
  }

  return tag(visionOutput, "gemini_vision");
}

async function safeExtractVisibleFields(ctx: ParseContext): Promise<DoclingField[]> {
  try {
    const fields = await extractVisibleKeyValues(ctx.fileBytes, ctx.mimeType);
    return fields.map((field) => ({
      key: field.key,
      value: field.value,
      confidence: field.confidence,
      page: field.page,
    }));
  } catch (err) {
    console.warn(`[parser] Vision key-value extraction failed: ${err.message}`);
    return [];
  }
}

/**
 * Parallel: race both backends when we can't tell which is right.
 * Pick the output with the higher combined (text_blocks + tables) count.
 */
async function runParallel(ctx: ParseContext): Promise<DoclingOutput> {
  const [doclingRes, visionRes] = await Promise.allSettled([
    canDoclingHandle(ctx.mimeType) ? callDocling(ctx) : Promise.resolve(null),
    canVisionHandle(ctx.mimeType)
      ? runPaddleOCR(ctx.fileBytes, ctx.mimeType).then(ocrTextToDocling)
      : Promise.resolve(null),
  ]);

  const doclingOut = doclingRes.status === "fulfilled" ? doclingRes.value : null;
  const visionOut = visionRes.status === "fulfilled" ? visionRes.value : null;

  const doclingScore = scoreOutput(doclingOut);
  const visionScore = scoreOutput(visionOut);

  console.log(
    `[parser] parallel scores: docling=${doclingScore} vision=${visionScore}`,
  );

  if (doclingScore >= visionScore && doclingOut) return tag(doclingOut, "docling");
  if (visionOut) return tag(visionOut, "gemini_vision");
  if (doclingOut) return tag(doclingOut, "docling");
  return tag(emptyOutput(["Parallel parse failed on both backends."]), "none");
}

// ── Backend call helpers ────────────────────────────────────────────────────

function canDoclingHandle(mimeType: string): boolean {
  if (!mimeType) return false;
  if (mimeType.startsWith("image/")) return false; // images go to Vision
  return true;
}

function canVisionHandle(mimeType: string): boolean {
  if (!mimeType) return true; // best-effort
  // Vision handles PDFs and images well. It can also do text/plain, but
  // native parsing is faster and cheaper there.
  if (mimeType === "text/plain" || mimeType === "text/csv") return false;
  return true;
}

async function callDocling(ctx: ParseContext): Promise<DoclingOutput | null> {
  const doclingUrl = Deno.env.get("DOCLING_API_URL");
  if (!doclingUrl) return null;
  if (!canDoclingHandle(ctx.mimeType)) return null;

  const apiKey = Deno.env.get("DOCLING_API_KEY");
  const maxRetries = 1;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `[parser] Docling attempt ${attempt}/${maxRetries} for "${ctx.fileName}"`,
      );

      const formData = new FormData();
      formData.append(
        "file",
        new Blob([ctx.fileBytes], { type: ctx.mimeType }),
        ctx.fileName,
      );
      formData.append("output_formats", "text,tables,fields");

      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);

      const response = await fetch(`${doclingUrl}/api/v1/convert`, {
        method: "POST",
        headers,
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const raw = await response.json();
        return normaliseDoclingResponse(raw, ctx.fileName);
      }

      const errText = await response.text().catch(() => "unknown error");
      console.warn(`[parser] Docling HTTP ${response.status}: ${errText}`);

      // 4xx are deterministic — no point retrying
      if (response.status >= 400 && response.status < 500) return null;

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
    } catch (err) {
      console.warn(`[parser] Docling error (attempt ${attempt}): ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
    }
  }
  return null;
}

// ── Normalisation ───────────────────────────────────────────────────────────

function normaliseDoclingResponse(raw: any, fileName: string): DoclingOutput {
  const rawBlocks = raw.blocks ?? raw.paragraphs ?? raw.elements ?? [];
  const text_blocks: DoclingTextBlock[] = rawBlocks.map((b: any, i: number) => ({
    block_index: i,
    type: b.type ?? b.label ?? "paragraph",
    text: b.text ?? b.content ?? "",
    page: b.page ?? b.page_number ?? undefined,
  }));

  const rawTables = raw.tables ?? [];
  const tables: DoclingTable[] = rawTables.map((t: any, i: number) => {
    const rows: string[][] = (t.data ?? t.rows ?? []).map((row: any) =>
      Array.isArray(row) ? row.map(String) : Object.values(row).map(String),
    );
    const headers: string[] = t.headers ?? (rows.length > 0 ? rows[0] : []);
    const dataRows = t.headers ? rows : rows.slice(1);
    return {
      table_index: i,
      headers,
      rows: dataRows,
      markdown: t.markdown ?? t.md ?? undefined,
    };
  });

  const rawFields = raw.fields ?? raw.key_value_pairs ?? [];
  const fields: DoclingField[] = rawFields.map((f: any) => ({
    key: f.key ?? f.label ?? "",
    value: f.value ?? f.text ?? "",
    confidence: f.confidence ?? f.score ?? undefined,
    page: f.page ?? undefined,
  }));

  const full_text: string =
    raw.full_text ?? raw.text ?? text_blocks.map((b) => b.text).join("\n");

  return {
    model_version: raw.model_version ?? raw.version,
    page_count: raw.page_count ?? raw.pages ?? 1,
    text_blocks,
    tables,
    fields,
    full_text,
  };
}

function ocrTextToDocling(ocrText: string): DoclingOutput {
  const paragraphs = (ocrText || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return {
    text_blocks: paragraphs.map((text, i) => ({
      block_index: i,
      type: "paragraph",
      text,
      page: 1,
    })),
    tables: [],
    fields: [],
    full_text: ocrText,
    page_count: 1,
  };
}

function emptyOutput(warnings: string[] = []): DoclingOutput {
  return {
    text_blocks: [],
    tables: [],
    fields: [],
    full_text: "",
    page_count: 1,
    warnings,
  };
}

function scoreOutput(out: DoclingOutput | null): number {
  if (!out) return 0;
  const blocks = out.text_blocks?.length ?? 0;
  const tables = out.tables?.length ?? 0;
  const fields = out.fields?.length ?? 0;
  const textLen = out.full_text?.length ?? 0;
  // Structure-weighted score — tables are the hardest to get right.
  return blocks + tables * 5 + fields * 2 + Math.floor(textLen / 500);
}

function tag(out: DoclingOutput, method: string): DoclingOutput {
  out.extraction_method = method;
  return out;
}

async function parseNativePdfText(
  fileBytes: Uint8Array,
  fileName: string,
  mimeType: string,
): Promise<DoclingOutput | null> {
  const lowerName = fileName.toLowerCase();
  if (!mimeType.includes("pdf") && !lowerName.endsWith(".pdf")) return null;

  try {
    const decoder = new TextDecoder("latin1", { fatal: false });
    const rawPdf = decoder.decode(fileBytes);
    const textParts: string[] = [];

    textParts.push(extractPdfOperatorText(rawPdf));

    for (const streamMatch of rawPdf.matchAll(/<<(?:.|\n|\r)*?>>\s*stream\r?\n?([\s\S]*?)\r?\n?endstream/g)) {
      const objectText = streamMatch[0];
      const streamText = streamMatch[1] ?? "";
      if (!/\/FlateDecode\b/i.test(objectText)) continue;

      const streamStart = streamMatch.index! + objectText.indexOf(streamText);
      const encoded = fileBytes.slice(streamStart, streamStart + streamText.length);
      const decodedStream = await decodePdfStream(encoded, objectText);
      if (!decodedStream) continue;
      textParts.push(extractPdfOperatorText(decoder.decode(decodedStream)));
    }

    const text = cleanExtractedPdfText(textParts.join("\n"));
    return text.trim().length > 0 ? textToDocling(text) : null;
  } catch (err) {
    console.warn(`[parser] Native PDF text parse failed for "${fileName}": ${err.message}`);
    return null;
  }
}

async function decodePdfStream(
  bytes: Uint8Array,
  objectText: string,
): Promise<Uint8Array | null> {
  let current = trimPdfStreamBytes(bytes);

  // ReportLab and several office/PDF generators wrap content as
  // /ASCII85Decode then /FlateDecode. Decode filters in stream order before
  // pulling text operators from BT/ET sections.
  const filters = [...objectText.matchAll(/\/([A-Za-z0-9]+Decode)\b/g)].map((match) =>
    match[1].toLowerCase()
  );

  for (const filter of filters) {
    if (filter === "ascii85decode") {
      current = decodeAscii85(current);
      continue;
    }

    if (filter === "asciihexdecode") {
      current = decodeAsciiHex(current);
      continue;
    }

    if (filter === "flatedecode") {
      const inflated = await inflatePdfStream(current);
      if (!inflated) return null;
      current = inflated;
    }
  }

  return current;
}

async function inflatePdfStream(bytes: Uint8Array): Promise<Uint8Array | null> {
  const trimmed = trimPdfStreamBytes(bytes);
  for (const format of ["deflate", "deflate-raw"] as const) {
    try {
      const stream = new Blob([trimmed]).stream().pipeThrough(
        new DecompressionStream(format),
      );
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // Try the next deflate wrapper.
    }
  }
  return null;
}

function trimPdfStreamBytes(bytes: Uint8Array): Uint8Array {
  let start = 0;
  let end = bytes.length;
  while (start < end && (bytes[start] === 10 || bytes[start] === 13 || bytes[start] === 32)) start++;
  while (end > start && (bytes[end - 1] === 10 || bytes[end - 1] === 13 || bytes[end - 1] === 32)) end--;
  return bytes.slice(start, end);
}

function decodeAscii85(bytes: Uint8Array): Uint8Array {
  let text = new TextDecoder("latin1", { fatal: false }).decode(bytes).trim();
  if (text.startsWith("<~")) text = text.slice(2);
  const terminator = text.indexOf("~>");
  if (terminator >= 0) text = text.slice(0, terminator);
  text = text.replace(/\s+/g, "");

  const out: number[] = [];
  let group: number[] = [];

  for (const char of text) {
    if (char === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }

    const code = char.charCodeAt(0);
    if (code < 33 || code > 117) continue;
    group.push(code - 33);

    if (group.length === 5) {
      let value = 0;
      for (const digit of group) value = value * 85 + digit;
      out.push(
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
      );
      group = [];
    }
  }

  if (group.length > 0) {
    const originalLength = group.length;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const decoded = [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
    out.push(...decoded.slice(0, originalLength - 1));
  }

  return new Uint8Array(out);
}

function decodeAsciiHex(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder("latin1", { fatal: false })
    .decode(bytes)
    .replace(/>.*/, "")
    .replace(/[^0-9A-Fa-f]/g, "");
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 2) {
    out.push(parseInt(text.slice(i, i + 2).padEnd(2, "0"), 16));
  }
  return new Uint8Array(out.filter((byte) => !Number.isNaN(byte)));
}

function extractPdfOperatorText(pdfText: string): string {
  const chunks: string[] = [];
  const sections = [...pdfText.matchAll(/BT([\s\S]*?)ET/g)].map((match) => match[1]);
  const sources = sections.length > 0 ? sections : [pdfText];

  for (const source of sources) {
    for (const match of source.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) {
      chunks.push(decodePdfLiteral(match[0].replace(/\s*Tj\s*$/, "")));
    }
    for (const match of source.matchAll(/\[((?:.|\n|\r)*?)\]\s*TJ/g)) {
      for (const stringMatch of match[1].matchAll(/\((?:\\.|[^\\)])*\)/g)) {
        chunks.push(decodePdfLiteral(stringMatch[0]));
      }
    }
    for (const match of source.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
      chunks.push(decodePdfHex(match[1]));
    }
  }

  return chunks.join("\n");
}

function decodePdfLiteral(value: string): string {
  let text = value.replace(/^\(/, "").replace(/\)$/, "");
  text = text
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  return text;
}

function decodePdfHex(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    const byte = parseInt(clean.slice(i, i + 2).padEnd(2, "0"), 16);
    if (!Number.isNaN(byte)) bytes.push(byte);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

function cleanExtractedPdfText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

// OpenXML (.docx / .xlsx) parser. This is intentionally small and local:
// these files are ZIP containers, so extracting text from their XML is much
// more reliable than sending them through OCR.
async function parseOfficeOpenXml(
  fileBytes: Uint8Array,
  fileName: string,
  mimeType: string,
): Promise<DoclingOutput | null> {
  const lowerName = fileName.toLowerCase();
  const isDocx =
    lowerName.endsWith(".docx") ||
    mimeType.includes("officedocument.wordprocessingml");
  const isXlsx =
    lowerName.endsWith(".xlsx") ||
    mimeType.includes("officedocument.spreadsheetml");

  if (!isDocx && !isXlsx) return null;

  try {
    const entries = await readZipEntries(fileBytes);
    return isDocx
      ? buildDocxOutput(entries)
      : buildXlsxOutput(entries);
  } catch (err) {
    console.warn(`[parser] OpenXML parse failed for "${fileName}": ${err.message}`);
    return null;
  }
}

async function readZipEntries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const entries = new Map<string, Uint8Array>();
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) throw new Error("ZIP end-of-central-directory not found");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  let offset = centralDirOffset;

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameBytes = bytes.slice(offset + 46, offset + 46 + fileNameLength);
    const entryName = new TextDecoder().decode(nameBytes);

    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    const data = await inflateZipEntry(compressed, method);
    entries.set(entryName, data);

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const min = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      return i;
    }
  }
  return -1;
}

async function inflateZipEntry(compressed: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return compressed;
  if (method !== 8) return new Uint8Array(0);

  const stream = new Blob([compressed]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function buildDocxOutput(entries: Map<string, Uint8Array>): DoclingOutput {
  const decoder = new TextDecoder("utf-8");
  const xmlParts: string[] = [];
  const wanted = [
    "word/document.xml",
    ...[...entries.keys()].filter((name) =>
      /^word\/(?:header|footer)\d+\.xml$/i.test(name)
    ),
  ];

  for (const name of wanted) {
    const data = entries.get(name);
    if (data) xmlParts.push(decoder.decode(data));
  }

  const text = cleanExtractedXmlText(xmlParts.map(xmlToText).join("\n\n"));
  return textToDocling(text);
}

function buildXlsxOutput(entries: Map<string, Uint8Array>): DoclingOutput {
  const decoder = new TextDecoder("utf-8");
  const sharedStrings = parseSharedStrings(
    entries.get("xl/sharedStrings.xml")
      ? decoder.decode(entries.get("xl/sharedStrings.xml")!)
      : "",
  );
  const sheetNames = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort();
  const tables: DoclingTable[] = [];
  const textParts: string[] = [];

  for (const sheetName of sheetNames) {
    const xml = decoder.decode(entries.get(sheetName)!);
    const rows = parseSheetRows(xml, sharedStrings);
    if (rows.length === 0) continue;
    const headers = rows[0];
    const dataRows = rows.slice(1);
    tables.push({
      table_index: tables.length,
      headers,
      rows: dataRows,
      markdown: rows.map((row) => row.join("\t")).join("\n"),
    });
    textParts.push(rows.map((row) => row.join("\t")).join("\n"));
  }

  return {
    ...textToDocling(cleanExtractedXmlText(textParts.join("\n\n"))),
    tables,
  };
}

function parseSharedStrings(xml: string): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    cleanExtractedXmlText(xmlToText(match[1])),
  );
}

function parseSheetRows(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const cellXml = cellMatch[2];
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? "";
      const rawValue = cellXml.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] ??
        cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ??
        "";
      const value = type === "s"
        ? sharedStrings[Number(rawValue)] ?? ""
        : decodeXmlEntities(rawValue);
      cells.push(value.trim());
    }
    if (cells.some((cell) => cell.length > 0)) rows.push(cells);
  }
  return rows;
}

function xmlToText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\s*\/>/g, "\t")
      .replace(/<w:br\s*\/>|<w:cr\s*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<[^>]+>/g, ""),
  );
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function cleanExtractedXmlText(text: string): string {
  return text
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function textToDocling(text: string): DoclingOutput {
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  return {
    text_blocks: blocks.map((block, index) => ({
      block_index: index,
      type: "paragraph",
      text: block,
      page: 1,
    })),
    tables: [],
    fields: [],
    full_text: text,
    page_count: 1,
  };
}
