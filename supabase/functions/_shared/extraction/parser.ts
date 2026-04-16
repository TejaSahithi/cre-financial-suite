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
import { runPaddleOCR } from "../ocr/paddle-ocr.ts";

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
  return ratio < SCAN_TEXT_RATIO_THRESHOLD;
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
  const ocrText = await runPaddleOCR(ctx.fileBytes, ctx.mimeType);
  return tag(ocrTextToDocling(ocrText), "gemini_vision");
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

  const ocrText = await runPaddleOCR(ctx.fileBytes, ctx.mimeType);
  const visionOutput = ocrTextToDocling(ocrText);

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
  const maxRetries = 2;

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
      const timeoutId = setTimeout(() => controller.abort(), 60000);

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
