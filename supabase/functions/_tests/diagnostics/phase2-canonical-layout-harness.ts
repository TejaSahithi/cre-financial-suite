// @ts-nocheck
/**
 * Phase 2 transient diagnostic harness (Azure + Vertex canonical pipeline
 * migration). Measures cost/size/correctness of building a
 * CanonicalDocumentLayout, purely locally, against synthetic fixtures --
 * to inform (not presuppose) the transient-vs-persisted decision.
 *
 * Deliberately offline and read/write-scoped: no --allow-net, no --allow-env.
 * Run:
 *   deno run \
 *     --allow-read=supabase/functions/_tests/fixtures,supabase/functions/_shared,supabase/functions/_tests \
 *     --allow-write=scratch/root-artifacts \
 *     supabase/functions/_tests/diagnostics/phase2-canonical-layout-harness.ts [gitCommit]
 *
 * Writes one versioned JSON artifact to
 * scratch/root-artifacts/phase2-canonical-layout-measurements.json (already
 * gitignored) and does not touch any other file or any database/network
 * resource. No production or customer data is used anywhere in this file --
 * every input is a synthetic fixture built by build-fixtures.ts.
 */

import {
  legacyDoclingToCanonicalLayout,
  validateCanonicalLayout,
  type CanonicalDocumentLayout,
} from "../../_shared/extraction/document-intelligence-v3/canonical-layout.ts";
import { azureAnalyzeResultToCanonicalLayout } from "../../_shared/extraction/azure/azure-to-canonical-layout.ts";

const FIXTURES_DIR = new URL("../fixtures/phase2-harness/", import.meta.url);
const ARTIFACT_PATH = new URL("../../../../scratch/root-artifacts/phase2-canonical-layout-measurements.json", import.meta.url);
const WARM_ITERATIONS = 20;
const MEMORY_LOOP_ITERATIONS = 50;
const MEMORY_LOOP_CHECKPOINTS = [10, 20, 30, 40, 50];

// Manually maintained against document-intelligence-v3/canonical-layout.ts's
// validateCanonicalLayout() -- if a future edit stops emitting one of these
// codes under the poison layout below, the self-audit fails loudly rather
// than the check silently vanishing.
const EXPECTED_VALIDATOR_CODES = [
  "page_count_mismatch",
  "duplicate_page_number",
  "duplicate_block_id",
  "duplicate_reading_order_index",
  "invalid_span",
  "overlapping_spans",
  "bounding_region_unknown_page",
  "duplicate_table_id",
  "duplicate_cell_id",
  "table_dimensions_conflict",
  "missing_content",
  "missing_schema_version",
  "malformed_polygon",
];

// ── Small local timing/size helpers (no external deps, offline) ─────────────

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function gzipByteLength(text: string): Promise<number> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return buffer.byteLength;
}

function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}
function median(values: number[]): number {
  const s = sorted(values);
  if (s.length === 0) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function p95(values: number[]): number {
  const s = sorted(values);
  if (s.length === 0) return 0;
  const idx = Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1);
  return s[Math.max(0, idx)];
}

function estimateGeometryBytes(layout: CanonicalDocumentLayout): number {
  let total = 0;
  for (const page of layout.pages) {
    if (page.spans) total += byteLength(page.spans);
    if (page.bounding_regions) total += byteLength(page.bounding_regions);
    for (const block of page.blocks) {
      total += byteLength(block.polygon);
      if (block.spans) total += byteLength(block.spans);
      if (block.bounding_regions) total += byteLength(block.bounding_regions);
    }
    for (const table of page.tables) {
      total += byteLength(table.polygon);
      if (table.bounding_regions) total += byteLength(table.bounding_regions);
      for (const cell of table.cells) {
        total += byteLength(cell.polygon);
        if (cell.bounding_regions) total += byteLength(cell.bounding_regions);
      }
    }
  }
  return total;
}

function estimateTextBytes(layout: CanonicalDocumentLayout): number {
  let total = byteLength(layout.text_projection ?? "");
  for (const page of layout.pages) total += byteLength(page.plain_text ?? "");
  return total;
}

function countBlocks(layout: CanonicalDocumentLayout): number {
  return layout.pages.reduce((sum, p) => sum + p.blocks.length, 0);
}
function countTables(layout: CanonicalDocumentLayout): number {
  return layout.pages.reduce((sum, p) => sum + p.tables.length, 0);
}
function countCells(layout: CanonicalDocumentLayout): number {
  return layout.pages.reduce((sum, p) => sum + p.tables.reduce((s, t) => s + t.cells.length, 0), 0);
}

function warningStats(layout: CanonicalDocumentLayout) {
  const warnings = layout.warnings ?? [];
  const byCode: Record<string, number> = {};
  for (const w of warnings) byCode[w.code] = (byCode[w.code] ?? 0) + 1;
  const pageCount = layout.pages.length || 1;
  return {
    warning_count: warnings.length,
    warnings_per_document: warnings.length,
    warnings_per_page: Number((warnings.length / pageCount).toFixed(4)),
    warning_types: byCode,
    fatal_warning_count: warnings.filter((w) => w.severity === "fatal").length,
  };
}

// ── Canonical fidelity (input counts vs. output counts) ─────────────────────

function fidelityForAzureInput(input: any, layout: CanonicalDocumentLayout) {
  const inputBlockCount = (input.paragraphs?.length ?? 0) > 0
    ? input.paragraphs.length
    : (input.pages ?? []).reduce((sum: number, p: any) => sum + (p.lines?.length ?? 0), 0);
  return {
    input_page_count: input.pages?.length ?? 0,
    output_page_count: layout.pages.length,
    input_table_count: input.tables?.length ?? 0,
    output_table_count: countTables(layout),
    input_block_count: inputBlockCount,
    output_block_count: countBlocks(layout),
  };
}

function fidelityForDoclingInput(input: any, layout: CanonicalDocumentLayout) {
  return {
    input_page_count: input.pages?.length ?? 0,
    output_page_count: layout.pages.length,
    input_table_count: input.tables?.length ?? 0,
    output_table_count: countTables(layout),
    input_block_count: input.text_blocks?.length ?? 0,
    output_block_count: countBlocks(layout),
  };
}

// ── Correctness checks beyond validateCanonicalLayout ────────────────────────

function checkUniqueIds(layout: CanonicalDocumentLayout): { blockIdsUnique: boolean; tableIdsUnique: boolean; cellIdsUnique: boolean } {
  const blockIds = new Set<string>();
  const tableIds = new Set<string>();
  const cellIds = new Set<string>();
  let blockIdsUnique = true;
  let tableIdsUnique = true;
  let cellIdsUnique = true;
  for (const page of layout.pages) {
    for (const block of page.blocks) {
      if (blockIds.has(block.block_id)) blockIdsUnique = false;
      blockIds.add(block.block_id);
    }
    for (const table of page.tables) {
      if (tableIds.has(table.table_id)) tableIdsUnique = false;
      tableIds.add(table.table_id);
      for (const cell of table.cells) {
        if (cellIds.has(cell.cell_id)) cellIdsUnique = false;
        cellIds.add(cell.cell_id);
      }
    }
  }
  return { blockIdsUnique, tableIdsUnique, cellIdsUnique };
}

// ── Per-fixture measurement ───────────────────────────────────────────────────

interface FixtureRunResult {
  name: string;
  kind: "azure_analyze_result" | "docling_raw_legacy";
  fixture_read_ms: number;
  json_parse_ms: number;
  input_json_bytes: number;
  cold_run_duration_ms: number;
  warm: {
    adapter_duration_ms: { min: number; median: number; p95: number };
    validation_duration_ms: { min: number; median: number; p95: number };
  };
  serialization_duration_ms: number;
  canonical_json_bytes: number;
  text_bytes: number;
  geometry_bytes_estimate: number;
  compression: { raw_json_bytes: number; gzip_bytes: number; compression_ratio: number };
  counts: { page_count: number; block_count: number; table_count: number; cell_count: number };
  fidelity: ReturnType<typeof fidelityForAzureInput>;
  correctness: {
    validation_valid: boolean;
    validator_failures: number;
    validator_warnings: number;
    deterministic_hash_stable: boolean;
    canonical_hash: string;
    block_ids_unique: boolean;
    table_ids_unique: boolean;
    cell_ids_unique: boolean;
    fidelity_matches: boolean;
  };
  warnings: ReturnType<typeof warningStats>;
}

async function measureFixture(
  name: string,
  kind: FixtureRunResult["kind"],
  buildLayout: (input: any) => CanonicalDocumentLayout | Promise<CanonicalDocumentLayout>,
): Promise<FixtureRunResult> {
  const path = new URL(name, FIXTURES_DIR);

  const readStart = performance.now();
  const rawText = await Deno.readTextFile(path);
  const fixture_read_ms = performance.now() - readStart;

  const parseStart = performance.now();
  const input = JSON.parse(rawText);
  const json_parse_ms = performance.now() - parseStart;

  const input_json_bytes = byteLength(input);

  // Cold run: first-ever call for this fixture in this process (adapter + validation combined).
  const coldStart = performance.now();
  const coldLayout = await buildLayout(input);
  const coldValidation = validateCanonicalLayout(coldLayout);
  const cold_run_duration_ms = performance.now() - coldStart;
  void coldValidation;

  // Warm iterations: adapter and validation timed separately.
  const adapterTimes: number[] = [];
  const validationTimes: number[] = [];
  let lastLayout: CanonicalDocumentLayout = coldLayout;
  let lastValidation = coldValidation;
  const hashes = new Set<string>();

  for (let i = 0; i < WARM_ITERATIONS; i++) {
    const t0 = performance.now();
    const layout = await buildLayout(input);
    const t1 = performance.now();
    const validation = validateCanonicalLayout(layout);
    const t2 = performance.now();

    adapterTimes.push(t1 - t0);
    validationTimes.push(t2 - t1);
    lastLayout = layout;
    lastValidation = validation;
    hashes.add(await sha256Hex(JSON.stringify(layout)));
  }

  const serializeStart = performance.now();
  const canonicalJson = JSON.stringify(lastLayout);
  const serialization_duration_ms = performance.now() - serializeStart;

  const canonical_json_bytes = new TextEncoder().encode(canonicalJson).byteLength;
  const raw_json_bytes = canonical_json_bytes;
  const gzip_bytes = await gzipByteLength(canonicalJson);

  const fidelity = kind === "azure_analyze_result" ? fidelityForAzureInput(input, lastLayout) : fidelityForDoclingInput(input, lastLayout);
  const idChecks = checkUniqueIds(lastLayout);
  const canonical_hash = await sha256Hex(canonicalJson);

  return {
    name,
    kind,
    fixture_read_ms: Number(fixture_read_ms.toFixed(3)),
    json_parse_ms: Number(json_parse_ms.toFixed(3)),
    input_json_bytes,
    cold_run_duration_ms: Number(cold_run_duration_ms.toFixed(3)),
    warm: {
      adapter_duration_ms: { min: Number(Math.min(...adapterTimes).toFixed(3)), median: Number(median(adapterTimes).toFixed(3)), p95: Number(p95(adapterTimes).toFixed(3)) },
      validation_duration_ms: { min: Number(Math.min(...validationTimes).toFixed(3)), median: Number(median(validationTimes).toFixed(3)), p95: Number(p95(validationTimes).toFixed(3)) },
    },
    serialization_duration_ms: Number(serialization_duration_ms.toFixed(3)),
    canonical_json_bytes,
    text_bytes: estimateTextBytes(lastLayout),
    geometry_bytes_estimate: estimateGeometryBytes(lastLayout),
    compression: { raw_json_bytes, gzip_bytes, compression_ratio: Number((raw_json_bytes / gzip_bytes).toFixed(3)) },
    counts: {
      page_count: lastLayout.pages.length,
      block_count: countBlocks(lastLayout),
      table_count: countTables(lastLayout),
      cell_count: countCells(lastLayout),
    },
    fidelity,
    correctness: {
      validation_valid: lastValidation.valid,
      validator_failures: lastValidation.errors.length,
      validator_warnings: lastValidation.warnings.length,
      deterministic_hash_stable: hashes.size === 1,
      canonical_hash,
      block_ids_unique: idChecks.blockIdsUnique,
      table_ids_unique: idChecks.tableIdsUnique,
      cell_ids_unique: idChecks.cellIdsUnique,
      fidelity_matches:
        fidelity.input_page_count === fidelity.output_page_count &&
        fidelity.input_table_count === fidelity.output_table_count &&
        fidelity.input_block_count === fidelity.output_block_count,
    },
    warnings: warningStats(lastLayout),
  };
}

// ── Memory-growth loop (approximate only) ────────────────────────────────────

async function measureMemoryGrowth(input: any, buildLayout: (input: any) => CanonicalDocumentLayout | Promise<CanonicalDocumentLayout>) {
  const checkpoints: Array<{ iterations: number; heap_used_bytes: number | null }> = [];
  let iterations = 0;
  for (const checkpoint of MEMORY_LOOP_CHECKPOINTS) {
    while (iterations < checkpoint) {
      await buildLayout(input);
      iterations++;
    }
    const usage = typeof Deno.memoryUsage === "function" ? Deno.memoryUsage() : null;
    checkpoints.push({ iterations, heap_used_bytes: usage ? usage.heapUsed : null });
  }
  const first = checkpoints[0]?.heap_used_bytes ?? null;
  const last = checkpoints[checkpoints.length - 1]?.heap_used_bytes ?? null;
  const monotonically_increasing_beyond_50pct = first != null && last != null ? last > first * 1.5 : null;
  return { note: "approximate only, not an acceptance gate (GC/runtime noise)", checkpoints, monotonically_increasing_beyond_50pct };
}

// ── Validator self-audit (once, not per fixture) ─────────────────────────────

function buildPoisonLayout(): CanonicalDocumentLayout {
  const sharedId = "dup-id";
  return {
    document_id: "poison",
    uploaded_file_id: null,
    org_id: null,
    content_hash: null,
    layout_provider: "azure_document_intelligence",
    layout_api_version: null,
    page_count: 99, // mismatches actual pages.length below -> page_count_mismatch
    full_text_chars: 0,
    text_projection: "", // combined with no page text -> missing_content
    pages: [
      {
        page_number: 1,
        plain_text: "",
        blocks: [
          {
            block_id: sharedId,
            page_number: 1,
            kind: "paragraph",
            text: "x",
            span_start: null,
            span_end: null,
            polygon: [1, 2, 3], // odd length -> malformed_polygon
            confidence: null,
            spans: [{ offset: 0, length: 999 }], // exceeds content length -> invalid_span
            reading_order_index: 0,
            bounding_regions: [{ page_number: 999, polygon: [] }], // -> bounding_region_unknown_page
          },
          {
            block_id: sharedId, // -> duplicate_block_id
            page_number: 1,
            kind: "paragraph",
            text: "y",
            span_start: null,
            span_end: null,
            polygon: [],
            confidence: null,
            reading_order_index: 0, // duplicate on same page -> duplicate_reading_order_index
          },
        ],
        tables: [
          {
            table_id: "t1",
            page_number: 1,
            rows: 1,
            cells: [
              { cell_id: "c1", row_index: 5, column_index: 0, text: "a", polygon: [] },
              { cell_id: "c1", row_index: 0, column_index: 0, text: "b", polygon: [] }, // -> duplicate_cell_id
            ],
            polygon: [],
            caption: null,
            row_count: 1, // smaller than max row_index(5)+1 -> table_dimensions_conflict
          },
          { table_id: "t1", page_number: 1, rows: 0, cells: [], polygon: [], caption: null }, // -> duplicate_table_id
        ],
        figures: [],
        signature_regions: [],
        selection_marks: [],
        page_width: null,
        page_height: null,
      },
      {
        page_number: 1, // -> duplicate_page_number
        plain_text: "",
        blocks: [],
        tables: [],
        figures: [],
        signature_regions: [],
        selection_marks: [],
        page_width: null,
        page_height: null,
      },
    ],
    assets: [],
    metadata: {},
    // schema_version intentionally omitted -> missing_schema_version
  } as unknown as CanonicalDocumentLayout;
}

/**
 * A second, small, well-formed-except-for-one-thing layout: buildPoisonLayout()
 * sets text_projection to "" specifically to trigger missing_content, but
 * that makes every non-empty span "invalid_span" (exceeds content length),
 * which masks overlapping_spans (two spans can share a validity failure
 * without ever reaching the overlap comparison meaningfully distinct from
 * it). This second layout has real, non-empty content sized to hold two
 * spans that are individually valid but overlap each other.
 */
function buildOverlappingSpansPoisonLayout(): CanonicalDocumentLayout {
  const content = "x".repeat(20);
  return {
    document_id: "poison-overlap",
    uploaded_file_id: null,
    org_id: null,
    content_hash: null,
    layout_provider: "azure_document_intelligence",
    layout_api_version: null,
    page_count: 1,
    full_text_chars: content.length,
    text_projection: content,
    pages: [
      {
        page_number: 1,
        plain_text: content,
        blocks: [
          {
            block_id: "overlap-block",
            page_number: 1,
            kind: "paragraph",
            text: content,
            span_start: null,
            span_end: null,
            polygon: [],
            confidence: null,
            spans: [{ offset: 0, length: 10 }, { offset: 5, length: 10 }], // overlap at [5,10)
          },
        ],
        tables: [],
        figures: [],
        signature_regions: [],
        selection_marks: [],
        page_width: null,
        page_height: null,
      },
    ],
    assets: [],
    metadata: {},
    schema_version: 1,
  } as unknown as CanonicalDocumentLayout;
}

function runValidatorSelfAudit() {
  const resultA = validateCanonicalLayout(buildPoisonLayout());
  const resultB = validateCanonicalLayout(buildOverlappingSpansPoisonLayout());
  const observedCodes = new Set([...resultA.errors, ...resultA.warnings, ...resultB.errors, ...resultB.warnings].map((w) => w.code));
  const missing = EXPECTED_VALIDATOR_CODES.filter((code) => !observedCodes.has(code));
  return {
    expected_checks: EXPECTED_VALIDATOR_CODES.length,
    observed_checks: EXPECTED_VALIDATOR_CODES.length - missing.length,
    missing_codes: missing,
    self_audit_passed: missing.length === 0,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const gitCommit = Deno.args[0] ?? "unknown";

  console.log("Running validator self-audit...");
  const validatorSelfAudit = runValidatorSelfAudit();
  console.log(`  self-audit passed: ${validatorSelfAudit.self_audit_passed} (${validatorSelfAudit.observed_checks}/${validatorSelfAudit.expected_checks} expected codes observed)`);
  if (!validatorSelfAudit.self_audit_passed) {
    console.warn(`  MISSING codes: ${validatorSelfAudit.missing_codes.join(", ")}`);
  }

  const azureFixtures = [
    "assignment-scale-synthetic.json",
    "base-lease-scale-synthetic.json",
    "cam-table-scale-synthetic.json",
    "large-lease-scale-synthetic.json",
  ];

  const results: FixtureRunResult[] = [];
  for (const name of azureFixtures) {
    console.log(`Measuring ${name}...`);
    const result = await measureFixture(name, "azure_analyze_result", (input) => azureAnalyzeResultToCanonicalLayout(input, { uploadedFileId: "phase2-harness" }));
    results.push(result);
    console.log(
      `  cold=${result.cold_run_duration_ms}ms adapter(median)=${result.warm.adapter_duration_ms.median}ms ` +
        `validation(median)=${result.warm.validation_duration_ms.median}ms bytes=${result.canonical_json_bytes} ` +
        `valid=${result.correctness.validation_valid} fidelity_matches=${result.correctness.fidelity_matches} hash_stable=${result.correctness.deterministic_hash_stable}`,
    );
  }

  console.log("Measuring current-persisted-docling-raw-azure-shape.json (legacy path)...");
  const legacyResult = await measureFixture(
    "current-persisted-docling-raw-azure-shape.json",
    "docling_raw_legacy",
    (input) => legacyDoclingToCanonicalLayout(input, { uploadedFileId: "phase2-harness" }),
  );
  results.push(legacyResult);
  console.log(
    `  cold=${legacyResult.cold_run_duration_ms}ms adapter(median)=${legacyResult.warm.adapter_duration_ms.median}ms ` +
      `bytes=${legacyResult.canonical_json_bytes} valid=${legacyResult.correctness.validation_valid}`,
  );

  console.log("Measuring memory growth over repeated conversions (large-lease-scale fixture)...");
  const largeLeaseFixture = JSON.parse(await Deno.readTextFile(new URL("large-lease-scale-synthetic.json", FIXTURES_DIR)));
  const memoryGrowth = await measureMemoryGrowth(largeLeaseFixture, (input) => azureAnalyzeResultToCanonicalLayout(input, { uploadedFileId: "phase2-harness-memory" }));
  console.log(`  memory growth checkpoints: ${JSON.stringify(memoryGrowth.checkpoints)}`);

  const artifact = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    git_commit: gitCommit,
    deno_version: Deno.version.deno,
    platform: `${Deno.build.os}-${Deno.build.arch}`,
    warm_iterations: WARM_ITERATIONS,
    validator_self_audit: validatorSelfAudit,
    memory_growth: memoryGrowth,
    fixtures: results,
  };

  await Deno.mkdir(new URL(".", ARTIFACT_PATH), { recursive: true });
  await Deno.writeTextFile(ARTIFACT_PATH, JSON.stringify(artifact, null, 2));
  console.log(`\nWrote measurements to ${ARTIFACT_PATH.pathname}`);
}

if (import.meta.main) {
  await main();
}
