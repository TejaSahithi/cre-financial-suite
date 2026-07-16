// @ts-nocheck
// Phase 3B: warning-code vocabulary guard.
//
// Cross-cutting concern spanning the validator (canonical-layout.ts), the
// Azure adapter (azure-to-canonical-layout.ts), and the resolver
// (canonical-layout-resolver.ts) -- doesn't belong to any one of their
// existing test files.
//
// Every warning/error `code` string emitted anywhere in these three modules
// is classified into exactly one scope:
//   - adapter_input:       provider-specific names are permitted (the code
//                           describes an adapter-specific input contract or
//                           envelope, e.g. "the Azure response had no
//                           content").
//   - canonical_structure: provider names are forbidden (the code
//                           describes a structural invariant of the
//                           provider-neutral canonical contract).
//   - resolver_policy:     provider names are forbidden (the code
//                           describes a resolver-level decision, which must
//                           stay provider-neutral even though today the
//                           resolver only compares two specific sources).
//
// This is deliberately NOT a blunt "no provider name in any code" rule --
// that would incorrectly reject legitimate adapter-local codes like
// "missing_analyze_result".
//
// Run: deno test --allow-env --allow-read --no-lock canonical-warning-vocabulary.test.ts

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { azureAnalyzeResultToCanonicalLayout } from "../_shared/extraction/azure/azure-to-canonical-layout.ts";

const VALIDATOR_PATH = new URL("../_shared/extraction/document-intelligence-v3/canonical-layout.ts", import.meta.url);
const ADAPTER_PATH = new URL("../_shared/extraction/azure/azure-to-canonical-layout.ts", import.meta.url);
const RESOLVER_PATH = new URL("../_shared/extraction/document-intelligence-v3/canonical-layout-resolver.ts", import.meta.url);

type WarningScope = "adapter_input" | "canonical_structure" | "resolver_policy";

// ── Hand-maintained classification (Task B: "may live in test code") ────────
// Every code known to exist as of Phase 3B. The completeness guard below
// fails if source ever drifts from this list in either direction.
const WARNING_CODE_SCOPES: Record<string, WarningScope> = {
  // canonical_structure -- validator invariants (some also emitted by the
  // adapter for the identical structural concept, e.g. duplicate_page_number).
  bounding_region_unknown_page: "canonical_structure",
  duplicate_block_id: "canonical_structure",
  duplicate_cell_id: "canonical_structure",
  duplicate_page_number: "canonical_structure",
  duplicate_reading_order_index: "canonical_structure",
  duplicate_table_id: "canonical_structure",
  invalid_span: "canonical_structure",
  malformed_polygon: "canonical_structure",
  missing_content: "canonical_structure",
  missing_layout: "canonical_structure",
  missing_schema_version: "canonical_structure",
  overlapping_spans: "canonical_structure",
  page_count_mismatch: "canonical_structure",
  table_dimensions_conflict: "canonical_structure",

  // adapter_input -- Azure adapter's own input/envelope concerns; provider
  // names are expected and allowed here.
  empty_content: "adapter_input",
  missing_analyze_result: "adapter_input",
  page_synthesized_from_content: "adapter_input",
  page_text_from_lines_fallback: "adapter_input",
  paragraph_missing_bounding_region: "adapter_input",
  table_missing_bounding_region: "adapter_input",
  table_spans_multiple_pages: "adapter_input",

  // resolver_policy -- resolver's own precedence/conflict/schema decisions.
  canonical_layout_schema_version_missing: "resolver_policy",
  canonical_layout_schema_version_too_new: "resolver_policy",
  canonical_layout_schema_version_too_old: "resolver_policy",
  canonical_layout_structurally_invalid: "resolver_policy",
  canonical_layout_superseded_by_newer_source: "resolver_policy",
  canonical_source_authority_undetermined: "resolver_policy",
};

// ── Token-aware provider-name denylist ───────────────────────────────────────
// Matched against `_`-separated tokens, never as a raw substring, so an
// innocent code containing e.g. "document" or "ai" alone is never flagged.
const SINGLE_TOKEN_DENYLIST = new Set(["azure", "docling", "gemini", "vertex", "textract"]);
const MULTI_TOKEN_DENYLIST: string[][] = [["google", "document", "ai"]];

function codeTokens(code: string): string[] {
  return code.split("_");
}

function containsDenylistedProviderName(code: string): boolean {
  const tokens = codeTokens(code);
  if (tokens.some((t) => SINGLE_TOKEN_DENYLIST.has(t))) return true;
  for (const sequence of MULTI_TOKEN_DENYLIST) {
    for (let i = 0; i <= tokens.length - sequence.length; i++) {
      if (sequence.every((t, j) => tokens[i + j] === t)) return true;
    }
  }
  return false;
}

// ── Source-scanning completeness guard ───────────────────────────────────────
// Extracts every emitted `code` string directly from source text, so this
// test fails if a new code is ever added without a matching classification
// entry (or vice versa) -- not just a one-way allowlist.

function extractObjectLiteralCodes(flattenedSource: string): string[] {
  const codes: string[] = [];
  const re = /code:\s*"([a-z_]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(flattenedSource)) !== null) codes.push(match[1]);
  return codes;
}

function extractPushWarningCodes(flattenedSource: string): string[] {
  const codes: string[] = [];
  const re = /pushWarning\(\s*\w+,\s*"([a-z_]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(flattenedSource)) !== null) codes.push(match[1]);
  return codes;
}

async function discoverAllEmittedCodes(): Promise<Set<string>> {
  const validatorText = (await Deno.readTextFile(VALIDATOR_PATH)).replace(/\s+/g, " ");
  const adapterText = (await Deno.readTextFile(ADAPTER_PATH)).replace(/\s+/g, " ");
  const resolverText = (await Deno.readTextFile(RESOLVER_PATH)).replace(/\s+/g, " ");

  const codes = [
    ...extractObjectLiteralCodes(validatorText),
    ...extractObjectLiteralCodes(adapterText),
    ...extractPushWarningCodes(resolverText),
  ];
  return new Set(codes);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

Deno.test("warning vocabulary: every code emitted in source is classified exactly once (two-way completeness/drift guard)", async () => {
  const discovered = await discoverAllEmittedCodes();
  const classified = new Set(Object.keys(WARNING_CODE_SCOPES));

  const missingFromMap = [...discovered].filter((c) => !classified.has(c));
  const staleInMap = [...classified].filter((c) => !discovered.has(c));

  assertEquals(missingFromMap, [], `code(s) emitted in source but not classified in WARNING_CODE_SCOPES: ${missingFromMap.join(", ")}`);
  assertEquals(staleInMap, [], `code(s) classified in WARNING_CODE_SCOPES but no longer emitted anywhere in source: ${staleInMap.join(", ")}`);
});

Deno.test("warning vocabulary: every canonical_structure code is provider-neutral", () => {
  const violations = Object.entries(WARNING_CODE_SCOPES)
    .filter(([, scope]) => scope === "canonical_structure")
    .filter(([code]) => containsDenylistedProviderName(code));
  assertEquals(violations.map(([code]) => code), []);
});

Deno.test("warning vocabulary: every resolver_policy code is provider-neutral", () => {
  const violations = Object.entries(WARNING_CODE_SCOPES)
    .filter(([, scope]) => scope === "resolver_policy")
    .filter(([code]) => containsDenylistedProviderName(code));
  assertEquals(violations.map(([code]) => code), []);
});

Deno.test("warning vocabulary: adapter_input codes are exempt from the provider-neutrality rule", () => {
  const adapterInputCodes = Object.entries(WARNING_CODE_SCOPES).filter(([, scope]) => scope === "adapter_input").map(([code]) => code);
  assert(adapterInputCodes.length > 0, "expected at least one adapter_input code to exist");
  // Not asserting they're free of provider names -- they're explicitly permitted to have them.
});

Deno.test("warning vocabulary: duplicate_page_number is classified canonical_structure", () => {
  assertEquals(WARNING_CODE_SCOPES["duplicate_page_number"], "canonical_structure");
});

Deno.test("warning vocabulary: missing_analyze_result remains allowed as adapter_input", () => {
  assertEquals(WARNING_CODE_SCOPES["missing_analyze_result"], "adapter_input");
  assertFalse(containsDenylistedProviderName("missing_analyze_result")); // no provider token in this one anyway
});

Deno.test("warning vocabulary: token-aware matching does not flag innocent codes containing 'document' or 'ai' alone", () => {
  assertFalse(containsDenylistedProviderName("missing_analyze_result")); // contains no denylisted token
  assertFalse(containsDenylistedProviderName("page_synthesized_from_content")); // no denylisted token
  assertFalse(containsDenylistedProviderName("table_missing_bounding_region")); // no denylisted token
  // Sanity check the detector actually fires on real provider tokens.
  assert(containsDenylistedProviderName("duplicate_azure_page_number"));
  assert(containsDenylistedProviderName("some_docling_specific_code"));
  assert(containsDenylistedProviderName("some_google_document_ai_code"));
  assertFalse(containsDenylistedProviderName("some_document_code")); // "document" alone must not trigger the multi-token rule
  assertFalse(containsDenylistedProviderName("some_ai_code")); // "ai" alone must not trigger the multi-token rule
});

// ── Regression: the renamed adapter code actually fires as expected ─────────

Deno.test("azureAnalyzeResultToCanonicalLayout: a duplicate Azure pageNumber emits code='duplicate_page_number' (regression for the Phase 3B rename)", () => {
  const analyzeResult = {
    content: "Hello world.",
    pages: [
      { pageNumber: 1, spans: [{ offset: 0, length: 12 }] },
      { pageNumber: 1, spans: [{ offset: 0, length: 12 }] }, // duplicate
    ],
    paragraphs: [],
    tables: [],
  };

  const layout = azureAnalyzeResultToCanonicalLayout(analyzeResult, { uploadedFileId: "uf-1" });
  const warning = layout.warnings.find((w) => w.code === "duplicate_page_number");
  assert(warning, "expected a duplicate_page_number warning");
  assertEquals(warning.severity, "recoverable");
});
