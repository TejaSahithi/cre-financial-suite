// @ts-nocheck
// Phase 4D: diagnostics/readiness review. Two structural architecture-guard
// tests. Their names deliberately say "architecture guard" -- they prove a
// source-level absence (no import/call of a specific symbol), NOT runtime
// authorization, NOT RLS enforcement, and NOT full behavioral correctness.
// See docs/lease-extraction-architecture-audit-2026-07-29.md
// for the full investigation these guards were derived from, including the
// (separately, manually traced -- not test-covered) authorization findings
// that these source-scans do not and cannot prove anything about.
//
// Pure-function tests only -- no DB, no network.
// Run: deno test --allow-env --allow-read --no-lock diagnostics-readiness-layout-ownership.test.ts

import { assert, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";

const LAYOUT_CONSTRUCTION_SYMBOLS = [
  "resolveCanonicalDocumentLayout",
  "legacyDoclingToCanonicalLayout",
  "buildCanonicalLayoutFromAzureLikeOutput",
  "azureAnalyzeResultToCanonicalLayout",
];

const V3_ADVISORY_MODULE_NAMES = ["readiness.ts", "approval-advisory.ts", "advisory-audit.ts", "advisory-audit-batch.ts"];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const READINESS_SURFACE_FILES = [
  "../_shared/extraction/document-intelligence-v3/readiness.ts",
  "../document-intelligence-v3-readiness/index.ts",
  "../document-intelligence-v3-advisory-audit/index.ts",
  "../document-intelligence-v3-advisory-audit-batch/index.ts",
  "../document-intelligence-v3-approval-advisory/index.ts",
];

Deno.test("D4 architecture guard: readiness diagnostics do not construct layout", async () => {
  for (const relativePath of READINESS_SURFACE_FILES) {
    const url = new URL(relativePath, import.meta.url);
    const source = stripComments(await Deno.readTextFile(url));
    for (const symbol of LAYOUT_CONSTRUCTION_SYMBOLS) {
      assertFalse(
        source.includes(symbol),
        `${relativePath} must never reference ${symbol} -- readiness/diagnostics must only read durable document_intelligence_runs/document_claims/document_claim_evidence/document_validation_drops/document_canonical_field_projections rows (and Phase 4B's already-persisted layout_summary), never construct or resolve a layout itself`,
      );
    }
  }
});

const APPROVAL_SURFACE_FILES = [
  "../approve-lease-workflow/index.ts",
  "../review-approve/index.ts",
];

Deno.test("D4 architecture guard: V3 advisory modules do not gate approval", async () => {
  for (const relativePath of APPROVAL_SURFACE_FILES) {
    const url = new URL(relativePath, import.meta.url);
    const source = stripComments(await Deno.readTextFile(url));
    // Only real import statements count -- a bare mention of a filename in
    // prose (e.g. a comment describing unrelated legacy UI concepts) is not
    // a functional dependency. Comments are already stripped above; this
    // additionally restricts the check to lines that look like imports.
    const importLines = source.split("\n").filter((line) => line.trim().startsWith("import"));
    const importText = importLines.join("\n");
    for (const moduleName of V3_ADVISORY_MODULE_NAMES) {
      assertFalse(
        importText.includes(moduleName),
        `${relativePath} must never import ${moduleName} -- V3 readiness/advisory diagnostics are advisory-only and must never become a load-bearing dependency of the approval path (recommendation remains No Gate)`,
      );
    }
  }
});
