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
  DoclingPage,
} from "./types.ts";
import { extractDocumentWithVision } from "../ocr/vision-ocr.ts";

// A PDF needs at least this many Docling text blocks to be trusted as
// "digital" (non-scanned). 2 is intentionally low — a simple single-page
// lease amendment may have only 2-3 paragraphs. If Docling returns ≥2
// blocks OR extracts ≥500 meaningful characters we skip the Vision fallback.
const MIN_DIGITAL_BLOCKS = 2;
const SCAN_TEXT_RATIO_THRESHOLD = 0.02; // <2% printable text → scanned
// Minimum extracted chars from Docling to trust as complete even with few blocks
const MIN_DOCLING_TEXT_CHARS = 500;
// Gemini supports 20 MB inline base64. Files above this threshold use a
// signed Supabase Storage URL (fileUri) so the model fetches the bytes
// directly — no base64 memory pressure in the Edge Function.
const MAX_INLINE_VISION_PDF_BYTES = 20 * 1024 * 1024;
// Upper bound for the URI (HTTP fetch) path. Vertex AI can process files
// this large when given a signed URL; beyond this, Docling is required.
const MAX_VERTEX_HTTP_DOCUMENT_BYTES = 50 * 1024 * 1024;
// Native PDF text extraction works well for digital PDFs up to this size.
const MAX_NATIVE_PDF_TEXT_BYTES = 10 * 1024 * 1024;
// Docling structural supplement capped to avoid re-uploading very large files.
const MAX_DOCLING_SUPPLEMENT_BYTES = 20 * 1024 * 1024;
// Minimum chars from native extraction to consider it "complete enough" to
// skip Docling/Vision. Matches MIN_LEASE_TEXT_CHARS in pipeline-contract.ts —
// if native gets >= 500 chars we can run rule/table/LLM extraction on it.
// The old 2500-char threshold caused many digital executed leases to fall
// through to Vision even though native extraction was perfectly sufficient.
const MIN_NATIVE_PDF_TEXT_CHARS = 500;

type Strategy = "docling_only" | "vision_only" | "vision_first" | "parallel";

interface ParseContext {
  fileBytes: Uint8Array;
  fileName: string;
  mimeType: string;
  fileUrl?: string;
  hasDocling: boolean;
  hasVision: boolean;
  strategy: Strategy;
  expectedPageCount?: number | null;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function parseDocument(
  fileBytes: Uint8Array,
  fileName: string,
  mimeType: string = "application/pdf",
  options: { fileUrl?: string } = {},
): Promise<DoclingOutput> {
  const hasDocling = !!Deno.env.get("DOCLING_API_URL");
  const hasVision = !!(
    // Vertex AI service account path
    ((Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID")) &&
     (Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || Deno.env.get("GOOGLE_PRIVATE_KEY"))) ||
    // Gemini Developer API key path
    Deno.env.get("GEMINI_API_KEY") ||
    Deno.env.get("GOOGLE_API_KEY")
  );
  const likelyScannedPdf = mimeType.includes("pdf") && looksLikeScannedPdf(fileBytes);
  const estimatedPageCount = mimeType.includes("pdf") ? estimatePdfPageCount(fileBytes) : null;

  // Always try native PDF text extraction first — even for files that look
  // scanned. Executed leases often have signature images (which make the
  // scan heuristic fire) but their body text is fully digital. If native
  // extraction yields >= MIN_NATIVE_PDF_TEXT_CHARS we skip Vision/Docling
  // entirely, saving cost and eliminating auth-related parse failures.
  if (mimeType.includes("pdf") && fileBytes.length <= MAX_NATIVE_PDF_TEXT_BYTES) {
    const nativePdfOutput = await parseNativePdfText(fileBytes, fileName, mimeType);
    if (nativePdfOutput && (nativePdfOutput.full_text?.trim().length ?? 0) > 20) {
      if (estimatedPageCount) nativePdfOutput.page_count = estimatedPageCount;
      const nativeTextChars = nativePdfOutput.full_text?.trim().length ?? 0;
      const nativeBlockCount = nativePdfOutput.text_blocks?.length ?? 0;
      const nativeLooksComplete =
        nativeTextChars >= MIN_NATIVE_PDF_TEXT_CHARS ||
        // Single-page leases: 400+ chars with 2+ blocks is sufficient.
        (estimatedPageCount === 1 && nativeTextChars >= 400 && nativeBlockCount >= MIN_DIGITAL_BLOCKS);

      if (nativeLooksComplete) {
        console.log(
          `[parser] Native PDF parser extracted ${nativeTextChars} chars ` +
          `across ${estimatedPageCount ?? nativePdfOutput.page_count ?? "?"} page(s) from "${fileName}"` +
          (likelyScannedPdf ? " (classified as scanned but digital text found)" : ""),
        );
        return tag(nativePdfOutput, "pdf_text");
      }

      console.warn(
        `[parser] Native PDF parser extracted only ${nativeTextChars} chars ` +
        `from ${estimatedPageCount ?? "unknown"} page(s) for "${fileName}" — ` +
        (likelyScannedPdf ? "looks scanned, " : "") +
        "continuing to Docling/Vision.",
      );
    }
  }

  const officeOutput = await parseOfficeOpenXml(fileBytes, fileName, mimeType);
  if (officeOutput && (officeOutput.full_text?.trim().length ?? 0) > 20) {
    console.log(
      `[parser] OpenXML parser extracted ${officeOutput.full_text?.length ?? 0} chars from "${fileName}"`,
    );
    return tag(officeOutput, "openxml");
  }

  const strategy = pickStrategy({
    mimeType,
    fileBytes,
    fileUrl: options.fileUrl,
    hasDocling,
    hasVision,
  });
  const ctx: ParseContext = {
    fileBytes,
    fileName,
    mimeType,
    fileUrl: options.fileUrl,
    hasDocling,
    hasVision,
    strategy,
    expectedPageCount: estimatedPageCount,
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
  fileUrl?: string;
  hasDocling: boolean;
  hasVision: boolean;
}): Strategy {
  const { mimeType, fileBytes, fileUrl, hasDocling, hasVision } = args;

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
    // For public files below Vertex's HTTP document limit, prefer Gemini
    // Vision for scanned PDFs without inline base64 memory pressure.
    if (
      fileBytes.length > MAX_INLINE_VISION_PDF_BYTES &&
      fileBytes.length <= MAX_VERTEX_HTTP_DOCUMENT_BYTES &&
      fileUrl &&
      hasVision &&
      looksLikeScannedPdf(fileBytes)
    ) {
      return "vision_first";
    }

    // Inline Gemini Vision sends the full PDF as base64 inside one JSON
    // request. For larger files without a URL path, use Docling first.
    if (fileBytes.length > MAX_INLINE_VISION_PDF_BYTES && hasDocling) {
      return "docling_only";
    }
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
  const imageMarkers = (sampleText.match(/\/(?:Image|XObject|DCTDecode|JPXDecode)/g) ?? []).length;
  const textOperators = (sampleText.match(/\b(?:BT|ET|Tj|TJ|Tf|Td|Tm)\b/g) ?? []).length;

  // Scanned leases are image streams with very few (< 2) text operators.
  // Executed digital leases commonly have signature/logo images (imageMarkers >= 3)
  // but still have abundant digital text — FlateDecode is not a reliable scan signal
  // because most digital PDFs also use FlateDecode for compressed text streams.
  // Require BOTH a very low text operator count AND many image markers.
  return imageMarkers >= 5 && textOperators < 2;
}

function estimatePdfPageCount(bytes: Uint8Array): number | null {
  if (!bytes || bytes.length < 8) return null;
  const sampleText = new TextDecoder("latin1", { fatal: false }).decode(bytes);
  const explicitPages = sampleText.match(/\/Type\s*\/Page\b/g)?.length ?? 0;
  if (explicitPages > 0) return explicitPages;
  const countMatches = [...sampleText.matchAll(/\/Count\s+(\d{1,4})/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0);
  return countMatches.length ? Math.max(...countMatches) : null;
}

// ── Strategy implementations ────────────────────────────────────────────────

async function runDoclingOnly(ctx: ParseContext): Promise<DoclingOutput> {
  const doclingOutput = await callDocling(ctx);
  if (doclingOutput && (
    (doclingOutput.text_blocks?.length ?? 0) >= MIN_DIGITAL_BLOCKS ||
    (doclingOutput.full_text?.trim().length ?? 0) >= MIN_DOCLING_TEXT_CHARS
  )) {
    return tag(doclingOutput, "docling");
  }

  // Docling returned empty/sparse output — promote to vision fallback if we
  // actually have Vision configured. Otherwise return what we have.
  if (
    ctx.hasVision &&
    canVisionHandle(ctx.mimeType) &&
    !(
      ctx.mimeType.includes("pdf") &&
      ctx.fileBytes.length > MAX_INLINE_VISION_PDF_BYTES &&
      !(ctx.fileUrl && ctx.fileBytes.length <= MAX_VERTEX_HTTP_DOCUMENT_BYTES)
    )
  ) {
    console.warn(
      `[parser] Docling returned ${doclingOutput?.text_blocks?.length ?? 0} blocks — ` +
      `promoting to Vision fallback`,
    );
    return await runVisionFirst({ ...ctx, strategy: "vision_first" });
  }

  const output = doclingOutput ?? emptyOutput();
  if (
    ctx.mimeType.includes("pdf") &&
    ctx.fileBytes.length > MAX_INLINE_VISION_PDF_BYTES &&
    !(ctx.fileUrl && ctx.fileBytes.length <= MAX_VERTEX_HTTP_DOCUMENT_BYTES)
  ) {
    output.warnings = [
      ...(output.warnings ?? []),
      "Large PDF was not sent to inline Gemini Vision to avoid Edge Function resource exhaustion.",
    ];
  }
  return tag(output, "docling");
}

async function runVisionOnly(ctx: ParseContext): Promise<DoclingOutput> {
  if (!ctx.hasVision) {
    // No Vision or Docling configured. Try native text extraction as last resort
    // before throwing — this handles executed lease PDFs where we get here because
    // the scan heuristic fired but the native parse was not tried (e.g. the file
    // is larger than MAX_NATIVE_PDF_TEXT_BYTES but still has some digital text).
    if (ctx.mimeType.includes("pdf")) {
      try {
        const nativeFallback = await parseNativePdfText(ctx.fileBytes, ctx.fileName, ctx.mimeType);
        const nativeChars = nativeFallback?.full_text?.trim().length ?? 0;
        if (nativeFallback && nativeChars >= MIN_NATIVE_PDF_TEXT_CHARS) {
          console.warn(`[parser] No Vision/Docling backend — using native PDF text (${nativeChars} chars) as fallback`);
          return tag(nativeFallback, "pdf_text");
        }
      } catch {
        // ignore; throw the backend-unavailable error below
      }
    }
    throw new Error(
      "No parser backend available. Configure DOCLING_API_URL or set VERTEX_PROJECT_ID + " +
      "GOOGLE_SERVICE_ACCOUNT_KEY in Supabase secrets to enable document parsing.",
    );
  }
  try {
    const extracted = await extractDocumentWithVision(ctx.fileBytes, ctx.mimeType, ctx.fileUrl);
    const output = visionExtractionToDocling(extracted, ctx.expectedPageCount);
    return tag(output, "gemini_vision");
  } catch (err) {
    console.warn(`[parser] Vision OCR failed: ${err.message}`);
    if (ctx.hasDocling && canDoclingHandle(ctx.mimeType)) {
      const doclingOutput = await callDocling(ctx);
      if (doclingOutput) {
        return tag(doclingOutput, "docling");
      }
    }
    // Vision and Docling both failed. Try native text as last resort.
    if (ctx.mimeType.includes("pdf")) {
      try {
        const nativeFallback = await parseNativePdfText(ctx.fileBytes, ctx.fileName, ctx.mimeType);
        const nativeChars = nativeFallback?.full_text?.trim().length ?? 0;
        if (nativeFallback && nativeChars >= MIN_NATIVE_PDF_TEXT_CHARS) {
          console.warn(`[parser] Vision failed — using native PDF text (${nativeChars} chars) as fallback`);
          return tag(nativeFallback, "pdf_text");
        }
      } catch {
        // ignore; propagate the Vision error
      }
    }
    throw new Error(`Vision OCR failed: ${err.message}`);
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
    const extracted = await extractDocumentWithVision(ctx.fileBytes, ctx.mimeType, ctx.fileUrl);
    visionOutput = visionExtractionToDocling(extracted, ctx.expectedPageCount);
  } catch (err) {
    console.warn(`[parser] Vision-first OCR failed, falling back to Docling: ${err.message}`);
    if (ctx.hasDocling && canDoclingHandle(ctx.mimeType)) {
      const doclingOutput = await callDocling(ctx);
      if (doclingOutput) return tag(doclingOutput, "docling");
    }
    // Both Vision and Docling failed — propagate the real error
    throw new Error(`Vision OCR failed: ${err.message}`);
  }

  if (!ctx.hasDocling || !canDoclingHandle(ctx.mimeType) || ctx.fileBytes.length > MAX_DOCLING_SUPPLEMENT_BYTES) {
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

/**
 * Parallel: race both backends when we can't tell which is right.
 * Pick the output with the higher combined (text_blocks + tables) count.
 */
async function runParallel(ctx: ParseContext): Promise<DoclingOutput> {
  const [doclingRes, visionRes] = await Promise.allSettled([
    canDoclingHandle(ctx.mimeType) ? callDocling(ctx) : Promise.resolve(null),
    canVisionHandle(ctx.mimeType)
      ? extractDocumentWithVision(ctx.fileBytes, ctx.mimeType, ctx.fileUrl).then((extracted) => {
        return visionExtractionToDocling(extracted, ctx.expectedPageCount);
      })
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

      const response = await fetch(`${doclingUrl}/v1/convert/file`, {
        method: "POST",
        headers,
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        // Guard against oversized Docling responses (e.g. large documents with
        // embedded base64 data) that would OOM the edge function when buffered.
        const MAX_DOCLING_RESPONSE_BYTES = 12 * 1024 * 1024; // 12 MB
        const contentLength = Number(response.headers.get("content-length") ?? 0);
        if (contentLength > MAX_DOCLING_RESPONSE_BYTES) {
          console.warn(
            `[parser] Docling response Content-Length ${contentLength} bytes exceeds limit; ` +
            `discarding and falling back.`,
          );
          await response.body?.cancel().catch(() => undefined);
          return null;
        }
        // Stream the response into a size-capped buffer to prevent OOM when
        // Content-Length is absent (chunked transfer encoding).
        const reader = response.body?.getReader();
        if (!reader) return null;
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        let truncated = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.length;
          if (totalBytes > MAX_DOCLING_RESPONSE_BYTES) {
            truncated = true;
            await reader.cancel().catch(() => undefined);
            break;
          }
          chunks.push(value);
        }
        if (truncated) {
          console.warn(
            `[parser] Docling response exceeded ${MAX_DOCLING_RESPONSE_BYTES / 1024 / 1024} MB ` +
            `mid-stream; discarding and falling back.`,
          );
          return null;
        }
        const combined = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
        const raw = JSON.parse(new TextDecoder().decode(combined));
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
  const rawPages = Array.isArray(raw.pages) ? raw.pages : [];
  const pages: DoclingPage[] = rawPages
    .map((page: any, index: number) => ({
      page: Number.isFinite(Number(page?.page ?? page?.page_number)) && Number(page?.page ?? page?.page_number) > 0
        ? Number(page?.page ?? page?.page_number)
        : index + 1,
      text: String(page?.text ?? page?.content ?? page?.markdown ?? "").trim(),
      fields: Array.isArray(page?.fields)
        ? page.fields.map((field: any) => ({
          key: String(field?.key ?? field?.label ?? "").trim(),
          value: String(field?.value ?? field?.text ?? "").trim(),
          confidence: field?.confidence ?? field?.score ?? undefined,
          page: Number.isFinite(Number(page?.page ?? page?.page_number)) && Number(page?.page ?? page?.page_number) > 0
            ? Number(page?.page ?? page?.page_number)
            : index + 1,
          source_text: String(field?.source_text ?? field?.source ?? "").trim() || undefined,
        })).filter((field: DoclingField) => field.key && field.value)
        : [],
    }))
    .filter((page: DoclingPage) => page.text || (page.fields?.length ?? 0) > 0);

  const rawBlocks = raw.blocks ?? raw.paragraphs ?? raw.elements ?? [];
  let text_blocks: DoclingTextBlock[] = rawBlocks.map((b: any, i: number) => ({
    block_index: i,
    type: b.type ?? b.label ?? "paragraph",
    text: b.text ?? b.content ?? "",
    page: b.page ?? b.page_number ?? undefined,
  }));
  if (text_blocks.length === 0 && pages.length > 0) {
    text_blocks = pages.flatMap((page) =>
      String(page.text || "")
        .split(/\n\s*\n/)
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => ({
          block_index: 0,
          type: "paragraph",
          text,
          page: page.page,
        }))
    ).map((block, index) => ({ ...block, block_index: index }));
  }

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
    source_text: f.source_text ?? f.source ?? undefined,
  })).concat(pages.flatMap((page) => page.fields ?? []));

  const pageText = pages.map((page) => `[[PAGE ${page.page}]]\n${page.text}`).join("\n\n");
  const full_text: string =
    raw.full_text ?? raw.text ?? (pageText || text_blocks.map((b) => b.text).join("\n"));

  return {
    model_version: raw.model_version ?? raw.version,
    page_count: raw.page_count ?? (typeof raw.pages === "number" ? raw.pages : undefined) ?? (pages.length ? Math.max(...pages.map((page) => page.page)) : 1),
    pages,
    text_blocks,
    tables,
    fields,
    full_text,
  };
}

function splitMarkedOcrPages(ocrText: string): DoclingPage[] {
  const text = String(ocrText || "");
  const pageMarker = /^\s*\[\[\s*PAGE\s+(\d+)\s*\]\]\s*$/gim;
  const matches = [...text.matchAll(pageMarker)];
  if (matches.length === 0) return [];

  const pages: DoclingPage[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const marker = matches[i];
    const next = matches[i + 1];
    const pageNumber = Number(marker[1]);
    const start = (marker.index ?? 0) + marker[0].length;
    const end = next?.index ?? text.length;
    const pageText = cleanExtractedPdfText(text.slice(start, end));
    if (!pageText) continue;
    pages.push({
      page: Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : pages.length + 1,
      text: pageText,
      fields: [],
    });
  }
  return pages;
}

function textBlocksFromPages(pages: DoclingPage[]): DoclingTextBlock[] {
  return pages.flatMap((page) =>
    String(page.text || "")
      .split(/\n\s*\n/)
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({
        block_index: 0,
        type: "paragraph",
        text,
        page: page.page,
      }))
  ).map((block, index) => ({ ...block, block_index: index }));
}

function ocrTextToDocling(ocrText: string): DoclingOutput {
  const markedPages = splitMarkedOcrPages(ocrText);
  if (markedPages.length > 0) {
    return {
      pages: markedPages,
      text_blocks: textBlocksFromPages(markedPages),
      tables: [],
      fields: [],
      full_text: markedPages.map((page) => `[[PAGE ${page.page}]]\n${page.text}`).join("\n\n"),
      page_count: Math.max(...markedPages.map((page) => page.page), markedPages.length),
    };
  }

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

function visionExtractionToDocling(
  extracted: {
    text?: string;
    page_count?: number;
    pages?: Array<{
      page: number;
      text: string;
      fields?: Array<{ key: string; value: string; confidence?: number; page?: number; source_text?: string }>;
    }>;
    fields?: Array<{ key: string; value: string; confidence?: number; page?: number; source_text?: string }>;
    warnings?: string[];
  },
  expectedPageCount?: number | null,
): DoclingOutput {
  const pages = Array.isArray(extracted?.pages)
    ? extracted.pages
      .map((page, index) => ({
        page: Number.isFinite(Number(page?.page)) && Number(page.page) > 0 ? Number(page.page) : index + 1,
        text: cleanExtractedPdfText(String(page?.text ?? "")),
        fields: Array.isArray(page?.fields) ? page.fields : [],
      }))
      .filter((page) => page.text || page.fields.length > 0)
    : [];

  if ((expectedPageCount ?? 0) > 1 && pages.length === 0) {
    console.warn(
      `[parser] Gemini Vision returned 0 page-aware items for ${expectedPageCount}-page PDF; ` +
      `using flat text fallback instead of discarding content.`,
    );
    // Fall through to flat-text fallback below rather than discarding all content
  }

  if ((expectedPageCount ?? 0) > 1 && pages.length > 0 && pages.length < Number(expectedPageCount)) {
    console.warn(
      `[parser] Gemini Vision returned ${pages.length} of ${expectedPageCount} estimated pages; ` +
      `using partial result rather than discarding content.`,
    );
    // Use what Vision returned — partial coverage beats nothing
  }

  if (pages.length === 0) {
    const fallback = ocrTextToDocling(String(extracted?.text ?? ""));
    fallback.fields = (extracted?.fields ?? []).map((field) => ({
      key: String(field.key ?? ""),
      value: String(field.value ?? ""),
      confidence: field.confidence,
      page: field.page,
      source_text: field.source_text,
    }));
    fallback.warnings = extracted?.warnings ?? [];
    fallback.page_count = Math.max(
      Number(expectedPageCount) || 0,
      Number(extracted?.page_count) || 0,
      Number(fallback.page_count) || 0,
      Array.isArray(fallback.pages) && fallback.pages.length
        ? Math.max(...fallback.pages.map((page) => Number(page.page) || 0))
        : 0,
    ) || fallback.page_count;
    return fallback;
  }

  const textBlocks: DoclingTextBlock[] = [];
  const fields: DoclingField[] = [];
  for (const page of pages) {
    const pageText = cleanExtractedPdfText(page.text);
    if (pageText) {
      const blocks = pageText
        .split(/\n\s*\n/)
        .map((block) => block.trim())
        .filter(Boolean);
      for (const block of blocks) {
        textBlocks.push({
          block_index: textBlocks.length,
          type: "paragraph",
          text: block,
          page: page.page,
        });
      }
    }

    for (const field of page.fields ?? []) {
      const key = String(field?.key ?? "").trim();
      const value = String(field?.value ?? "").trim();
      if (!key || !value) continue;
      fields.push({
        key,
        value,
        confidence: field.confidence,
        page: page.page,
        source_text: String(field?.source_text ?? "").trim() || undefined,
      });
    }
  }

  const fullText = cleanExtractedPdfText(
    pages.map((page) => `[[PAGE ${page.page}]]\n${page.text}`).join("\n\n"),
  );
  const pageCount = Math.max(
    Number(extracted?.page_count) || 0,
    expectedPageCount || 0,
    ...pages.map((page) => page.page),
    pages.length,
  );

  return {
    pages: pages.map((page): DoclingPage => ({
      page: page.page,
      text: page.text,
      fields: page.fields?.map((field) => ({
        key: String(field?.key ?? "").trim(),
        value: String(field?.value ?? "").trim(),
        confidence: field.confidence,
        page: page.page,
        source_text: String(field?.source_text ?? "").trim() || undefined,
      })).filter((field) => field.key && field.value),
    })),
    text_blocks: textBlocks,
    tables: [],
    fields,
    full_text: fullText || cleanExtractedPdfText(String(extracted?.text ?? "")),
    page_count: pageCount || undefined,
    warnings: extracted?.warnings ?? [],
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

// Maximum compressed stream size to attempt decompression on — large streams
// are almost always binary content (fonts, images) rather than text operators.
// Decompressing them can spike memory 5-10x and is the primary cause of 546.
const MAX_STREAM_DECOMPRESS_BYTES = 128 * 1024; // 128 KB compressed
// Stop processing streams once we've collected enough text.
const MAX_NATIVE_EXTRACTED_CHARS = 50_000;
// Hard limit on how many FlateDecode streams to attempt so a pathological
// PDF with thousands of tiny streams can't exhaust the memory budget.
const MAX_STREAM_ITERATIONS = 60;

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

    let streamCount = 0;
    let totalExtracted = textParts[0].length;

    for (const streamMatch of rawPdf.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      if (totalExtracted >= MAX_NATIVE_EXTRACTED_CHARS) break;
      if (streamCount >= MAX_STREAM_ITERATIONS) break;

      const streamText = streamMatch[1] ?? "";
      // Skip binary-only streams — they don't contain PDF text operators.
      if (streamText.length > MAX_STREAM_DECOMPRESS_BYTES) continue;

      // Locate the object header (up to 1 KB before the stream keyword) to check
      // for FlateDecode without capturing it in the regex match itself.
      const streamKeywordPos = streamMatch.index ?? 0;
      const headerStart = Math.max(0, streamKeywordPos - 1024);
      const headerSnippet = rawPdf.slice(headerStart, streamKeywordPos);
      if (!/\/FlateDecode\b/i.test(headerSnippet)) continue;

      streamCount++;
      // Calculate exact byte offset of stream content.
      // The full match starts with "stream" then \r\n or \n.
      const newlineLen = streamMatch[0][6] === "\r" ? 2 : 1;
      const streamStart = streamMatch.index! + 6 + newlineLen; // "stream".length = 6
      const encoded = fileBytes.slice(streamStart, streamStart + streamText.length);
      const decodedStream = await decodePdfStream(encoded, headerSnippet);
      if (!decodedStream) continue;

      const extracted = extractPdfOperatorText(decoder.decode(decodedStream));
      if (extracted.length > 0) {
        textParts.push(extracted);
        totalExtracted += extracted.length;
      }
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

// Max characters to extract per call so we never accumulate unbounded output.
const MAX_OPERATOR_EXTRACT_CHARS = 30_000;

function extractPdfOperatorText(pdfText: string): string {
  const chunks: string[] = [];
  let totalChars = 0;

  // Use the matchAll iterator lazily (no spread) so BT/ET sections are
  // processed one at a time without holding all match objects simultaneously.
  let hasBtSections = false;
  for (const btMatch of pdfText.matchAll(/BT([\s\S]*?)ET/g)) {
    if (totalChars >= MAX_OPERATOR_EXTRACT_CHARS) break;
    hasBtSections = true;
    const source = btMatch[1];

    for (const match of source.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) {
      const decoded = decodePdfLiteral(match[0].replace(/\s*Tj\s*$/, ""));
      if (decoded) { chunks.push(decoded); totalChars += decoded.length; }
      if (totalChars >= MAX_OPERATOR_EXTRACT_CHARS) break;
    }
    for (const match of source.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      for (const stringMatch of match[1].matchAll(/\((?:\\.|[^\\)])*\)/g)) {
        const decoded = decodePdfLiteral(stringMatch[0]);
        if (decoded) { chunks.push(decoded); totalChars += decoded.length; }
        if (totalChars >= MAX_OPERATOR_EXTRACT_CHARS) break;
      }
      if (totalChars >= MAX_OPERATOR_EXTRACT_CHARS) break;
    }
    for (const match of source.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
      const decoded = decodePdfHex(match[1]);
      if (decoded) { chunks.push(decoded); totalChars += decoded.length; }
      if (totalChars >= MAX_OPERATOR_EXTRACT_CHARS) break;
    }
  }

  // Fallback: scan the whole text when no BT/ET markers found (rare).
  if (!hasBtSections) {
    for (const match of pdfText.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) {
      if (totalChars >= MAX_OPERATOR_EXTRACT_CHARS) break;
      const decoded = decodePdfLiteral(match[0].replace(/\s*Tj\s*$/, ""));
      if (decoded) { chunks.push(decoded); totalChars += decoded.length; }
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
  const paragraphParts: string[] = [];
  const tables: DoclingTable[] = [];
  const wanted = [
    "word/document.xml",
    ...[...entries.keys()].filter((name) =>
      /^word\/(?:header|footer)\d+\.xml$/i.test(name)
    ),
  ];

  for (const name of wanted) {
    const data = entries.get(name);
    if (data) {
      const xml = decoder.decode(data);
      paragraphParts.push(...extractWordParagraphs(xml));
      tables.push(...extractWordTables(xml, tables.length));
    }
  }

  const filteredTables = tables.filter((table) => !isLikelyLeaseAuxiliaryWordTable(table));
  const semanticFields = dedupeDocxFields([
    ...extractLeaseDocxFieldsFromParagraphs(paragraphParts),
    ...extractLeaseDocxFieldsFromTables(filteredTables),
  ]);
  const relevantTableText = filteredTables.flatMap((table) => tableToRelevantText(table));
  const text = cleanExtractedXmlText([...paragraphParts, ...relevantTableText].join("\n\n"));
  return {
    ...textToDocling(text),
    tables: filteredTables,
    fields: semanticFields,
  };
}

const DOCX_LEASE_FIELD_ALIASES: Record<string, string> = {
  tenant: "tenant_name",
  tenant_name: "tenant_name",
  tenant_1: "tenant_name",
  lessee: "tenant_name",
  landlord: "landlord_name",
  landlord_name: "landlord_name",
  lessor: "landlord_name",
  landlord_management_company: "landlord_name",
  apartment_community: "property_name",
  property_name: "property_name",
  premises_location: "property_address",
  property_address: "property_address",
  premises: "property_address",
  lease_start_date: "start_date",
  commencement_date: "start_date",
  start_date: "start_date",
  lease_end_date: "end_date",
  expiration_date: "end_date",
  end_date: "end_date",
  unit: "unit_number",
  unit_number: "unit_number",
  suite: "unit_number",
  monthly_rent: "monthly_rent",
  base_rent: "monthly_rent",
  annual_rent: "annual_rent",
  rent_per_sf: "rent_per_sf",
  square_footage: "square_footage",
  lease_term: "lease_term_months",
  lease_term_months: "lease_term_months",
  security_deposit: "security_deposit",
  lease_type: "lease_type",
  cam: "cam_amount",
  cam_amount: "cam_amount",
  water_sewer_reimbursement_charge: "water_sewer_reimbursement_amount",
  utility_reimbursement_charge: "utility_reimbursement_amount",
  parking_fee: "parking_fee_amount",
  pet_rent: "pet_rent_amount",
  pet_fee: "pet_fee_amount",
  late_fee: "late_fee_amount",
  returned_payment_fee: "returned_payment_fee_amount",
  application_fee: "application_fee_amount",
  administrative_fee: "administrative_fee_amount",
  electric_responsibility: "electric_responsibility",
  water_sewer_responsibility: "water_sewer_responsibility",
};

function normalizeDocxToken(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[#%]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function extractWordParagraphs(xml: string): string[] {
  const paragraphs: string[] = [];
  for (const paragraphMatch of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const text = cleanExtractedXmlText(xmlToText(paragraphMatch[0]));
    if (!text) continue;
    if (isIgnorableLeaseParagraph(text)) continue;
    paragraphs.push(text);
  }
  return paragraphs;
}

function isIgnorableLeaseParagraph(text: string): boolean {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return true;
  if (/^https?:\/\//.test(normalized) || /^www\./.test(normalized)) return true;
  if (/^signature\s*:/.test(normalized) || /^date\s*:/.test(normalized)) return true;
  if (/^_+$/.test(normalized)) return true;
  if (/completed sample for demonstration purposes/.test(normalized)) return true;
  if (/move[\s-]*in inspection|inspection checklist|tenant initials|landlord initials|authorized agent/.test(normalized)) {
    return true;
  }
  return false;
}

function isLikelyLeaseAuxiliaryWordTable(table: DoclingTable): boolean {
  const headerText = table.headers.map(normalizeDocxToken).join(" ");
  if (/^landlord_authorized_agent tenant$/.test(headerText)) return true;
  if (/^area condition notes tenant_initials$/.test(headerText)) return true;

  const flattened = [table.headers.join(" "), ...table.rows.map((row) => row.join(" "))]
    .join(" ")
    .toLowerCase();

  if (/move[\s-]*in inspection|inspection checklist|tenant initials|landlord initials/.test(flattened)) {
    return true;
  }
  if (/signature|authorized agent/.test(flattened) && table.rows.length <= 4) {
    return true;
  }

  return false;
}

function resolveDocxLeaseField(rawKey: string): string | null {
  const normalized = normalizeDocxToken(rawKey);
  if (!normalized) return null;
  if (DOCX_LEASE_FIELD_ALIASES[normalized]) return DOCX_LEASE_FIELD_ALIASES[normalized];
  const withoutOrdinal = normalized.replace(/_\d+$/, "");
  return DOCX_LEASE_FIELD_ALIASES[withoutOrdinal] || null;
}

function extractLeaseDocxFieldsFromParagraphs(paragraphs: string[]): DoclingField[] {
  const fields: DoclingField[] = [];
  for (const paragraph of paragraphs) {
    const match = paragraph.match(/^\s*([A-Za-z][A-Za-z0-9 /&().#-]{2,64})\s*:\s*(.{1,200})$/);
    if (!match) continue;
    const fieldName = resolveDocxLeaseField(match[1]);
    if (!fieldName) continue;
    const value = match[2].trim();
    if (!value) continue;
    fields.push({
      key: fieldName,
      value,
      confidence: 0.96,
    });
    const derivedUnit = extractUnitFromPremises(value);
    if (fieldName === "property_address" && derivedUnit) {
      fields.push({
        key: "unit_number",
        value: derivedUnit,
        confidence: 0.94,
      });
    }
  }
  return fields;
}

function extractLeaseDocxFieldsFromTables(tables: DoclingTable[]): DoclingField[] {
  const fields: DoclingField[] = [];
  for (const table of tables) {
    for (const row of table.rows) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const rawKey = String(row[0] ?? "").trim();
      const rawValue = row.slice(1).join(" ").trim();
      if (!rawKey || !rawValue) continue;
      const fieldName = resolveDocxLeaseField(rawKey);
      if (!fieldName) continue;
      fields.push({
        key: fieldName,
        value: rawValue,
        confidence: 0.97,
      });
      const derivedUnit = extractUnitFromPremises(rawValue);
      if (fieldName === "property_address" && derivedUnit) {
        fields.push({
          key: "unit_number",
          value: derivedUnit,
          confidence: 0.95,
        });
      }
    }
  }
  return fields;
}

function dedupeDocxFields(fields: DoclingField[]): DoclingField[] {
  const byKey = new Map<string, DoclingField>();
  for (const field of fields) {
    const key = normalizeDocxToken(field.key);
    if (!key || !field.value) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...field, key });
      continue;
    }

    const existingScore = (existing.confidence ?? 0) + String(existing.value || "").length / 500;
    const nextScore = (field.confidence ?? 0) + String(field.value || "").length / 500;
    if (nextScore > existingScore) {
      byKey.set(key, { ...field, key });
    }
  }
  return [...byKey.values()];
}

function tableToRelevantText(table: DoclingTable): string[] {
  return table.rows
    .map((row) => row.filter(Boolean).join(": ").trim())
    .filter((line) => line.length > 0 && !isIgnorableLeaseParagraph(line));
}

function extractUnitFromPremises(value: string): string | null {
  const match = String(value || "").match(/\b(?:unit|suite|space|apt\.?|apartment)\s+([A-Za-z0-9-]+)/i);
  return match?.[1]?.trim() || null;
}

function extractWordTables(xml: string, startIndex = 0): DoclingTable[] {
  const tables: DoclingTable[] = [];
  for (const tableMatch of xml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)) {
    const tableXml = tableMatch[0];
    const rows: string[][] = [];

    for (const rowMatch of tableXml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
      const rowXml = rowMatch[0];
      const cells: string[] = [];
      for (const cellMatch of rowXml.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)) {
        const value = cleanExtractedXmlText(xmlToText(cellMatch[0]));
        cells.push(value);
      }
      if (cells.some((cell) => cell.trim())) rows.push(cells);
    }

    if (rows.length < 2) continue;
    const width = Math.max(...rows.map((row) => row.length));
    const paddedRows = rows.map((row) => [
      ...row,
      ...Array(Math.max(0, width - row.length)).fill(""),
    ]);
    const headers = paddedRows[0].map((header) => header.trim());
    const dataRows = paddedRows.slice(1);

    tables.push({
      table_index: startIndex + tables.length,
      headers,
      rows: dataRows,
      markdown: paddedRows.map((row) => row.join("\t")).join("\n"),
    });
  }
  return tables;
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

export const __test__ = {
  estimatePdfPageCount,
  visionExtractionToDocling,
};
