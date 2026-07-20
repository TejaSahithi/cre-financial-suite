// @ts-nocheck
/**
 * Canonical Document Layout resolver (Phase 3 of the Azure + OpenAI
 * canonical pipeline migration).
 *
 * A single, provider-neutral entry point for obtaining a
 * `CanonicalDocumentLayout` from whichever inputs a caller has available --
 * an already-resolved layout, a raw Azure `analyzeResult`, or a legacy
 * `docling_raw` object -- with explicit provenance, fidelity, and conflict
 * handling. This module is introduced but **not wired into any runtime
 * consumer in Phase 3**; no existing caller imports or uses it yet.
 *
 * Architecture: this is the one place precedence between a persisted layout
 * (a future Phase 6 concept, not built yet), the lossless Azure-native
 * adapter, and the lossy legacy docling_raw builder is decided. It is not a
 * naive first-non-null helper -- see resolveCanonicalDocumentLayout()'s
 * doc comment for the exact rules.
 *
 * Purity: pure, deterministic, no network, no `Deno.env`, no database, no
 * global cache, no runtime memoization. Declared `async` uniformly because
 * `legacyDoclingToCanonicalLayout` is inherently async (its `content_hash`
 * uses Web Crypto's `crypto.subtle.digest`) -- the Azure-native and
 * no-source paths complete synchronously internally, but the function
 * returns a single consistent `Promise<...>` signature regardless of which
 * internal path is taken, rather than a caller having to detect a
 * conditional sync/async return type.
 */

import {
  CANONICAL_LAYOUT_SCHEMA_VERSION,
  MINIMUM_SUPPORTED_SCHEMA_VERSION,
  legacyDoclingToCanonicalLayout,
  validateCanonicalLayout,
  type CanonicalDocumentLayout,
  type CanonicalLayoutValidationResult,
  type CanonicalWarning,
} from "./canonical-layout.ts";
import { azureAnalyzeResultToCanonicalLayout, type AzureAnalyzeResultLike } from "../azure/azure-to-canonical-layout.ts";

// ── Input / result contracts (Task A) ────────────────────────────────────────

export interface CanonicalLayoutSourceMetadata {
  /** A hash of the raw source payload (e.g. the Azure analyzeResult or
   *  docling_raw object) being supplied in *this* call, used to detect
   *  whether a supplied `canonicalLayout` was generated from the same
   *  underlying document payload. Not the same thing as the layout's own
   *  `content_hash`, though they should match when they describe the same
   *  generation. */
  sourcePayloadHash?: string | null;
  /** ISO-8601 timestamp describing when the *newly supplied* source
   *  (azureAnalyzeResult/doclingRaw) was generated -- compared against
   *  `canonicalLayout.metadata.generated_at` (a freeform field on the
   *  existing Phase 1 `metadata` bag) when hash comparison isn't possible. */
  generatedAt?: string | null;
  provider?: string | null;
  providerModelId?: string | null;
  providerApiVersion?: string | null;
}

export interface ResolveCanonicalDocumentLayoutInput {
  canonicalLayout?: CanonicalDocumentLayout | null;
  azureAnalyzeResult?: AzureAnalyzeResultLike | null;
  doclingRaw?: unknown;
  sourceMetadata?: CanonicalLayoutSourceMetadata;
}

export type CanonicalLayoutResolutionSource =
  | "provided_canonical_layout"
  | "azure_analyze_result"
  | "legacy_docling_raw"
  | "none";

export type CanonicalLayoutResolutionFidelity = "lossless" | "legacy_lossy" | "unknown";

export interface CanonicalLayoutResolutionProvenance {
  provider?: string | null;
  providerModelId?: string | null;
  providerApiVersion?: string | null;
  sourcePayloadHash?: string | null;
  generatedAt?: string | null;
}

export interface CanonicalLayoutResolutionResult {
  layout: CanonicalDocumentLayout | null;
  source: CanonicalLayoutResolutionSource;
  fidelity: CanonicalLayoutResolutionFidelity;
  validation: CanonicalLayoutValidationResult | null;
  warnings: CanonicalWarning[];
  provenance: CanonicalLayoutResolutionProvenance;
}

// ── Schema-version classification (Task C) ───────────────────────────────────

type SchemaVersionStatus = "current" | "older_supported" | "missing" | "too_old" | "too_new";

function classifySchemaVersion(version: number | null | undefined): SchemaVersionStatus {
  if (version == null) return "missing";
  if (version === CANONICAL_LAYOUT_SCHEMA_VERSION) return "current";
  if (version > CANONICAL_LAYOUT_SCHEMA_VERSION) return "too_new";
  if (version < MINIMUM_SUPPORTED_SCHEMA_VERSION) return "too_old";
  return "older_supported";
}

function fidelityForProvidedLayout(layout: CanonicalDocumentLayout, schemaStatus: SchemaVersionStatus): CanonicalLayoutResolutionFidelity {
  // A historical layout with no schema_version cannot be trusted to have
  // accurate provenance fields either (they were added in the same schema
  // revision) -- force "unknown" rather than believing a possibly-stale
  // `provider` field (Task C: "may be accepted only with explicit
  // legacy/unknown provenance").
  if (schemaStatus === "missing") return "unknown";
  if (layout.provider === "azure_document_intelligence") return "lossless";
  if (layout.provider === "legacy_docling_compatibility") return "legacy_lossy";
  return "unknown";
}

// ── Provenance comparison for conflict detection (Task B.5) ─────────────────

type ProvenanceComparison = "same_generation" | "new_source_newer" | "undetermined";

/**
 * Compares a supplied `canonicalLayout`'s own provenance against metadata
 * describing a newly-supplied source (Azure/docling), to decide whether
 * they represent the same document generation. Two independent signals are
 * tried, in order of reliability; if neither can be evaluated, the result
 * is "undetermined" rather than a guess (Task B.5: "if authority cannot be
 * determined safely, return a conflict result or warning rather than
 * guessing").
 */
function compareProvidedLayoutAgainstNewSource(
  layout: CanonicalDocumentLayout,
  sourceMetadata: CanonicalLayoutSourceMetadata | undefined,
): ProvenanceComparison {
  const layoutHash = layout.content_hash ?? null;
  const suppliedHash = sourceMetadata?.sourcePayloadHash ?? null;
  if (layoutHash && suppliedHash) {
    return layoutHash === suppliedHash ? "same_generation" : "new_source_newer";
  }

  const layoutGeneratedAtRaw = layout.metadata?.generated_at;
  const layoutGeneratedAt = typeof layoutGeneratedAtRaw === "string" ? Date.parse(layoutGeneratedAtRaw) : NaN;
  const suppliedGeneratedAt = sourceMetadata?.generatedAt ? Date.parse(sourceMetadata.generatedAt) : NaN;
  if (!Number.isNaN(layoutGeneratedAt) && !Number.isNaN(suppliedGeneratedAt)) {
    if (suppliedGeneratedAt > layoutGeneratedAt) return "new_source_newer";
    if (suppliedGeneratedAt === layoutGeneratedAt) return "same_generation";
    // The newly-supplied source claims to be OLDER than the canonical
    // layout on hand -- that's not grounds to trust the canonical layout
    // either (the timestamp itself is caller-supplied, unverified); surface
    // as undetermined rather than picking a side.
    return "undetermined";
  }

  return "undetermined";
}

function pushWarning(warnings: CanonicalWarning[], code: string, message: string, severity: "recoverable" | "fatal", path?: string): void {
  warnings.push({ code, message, severity, ...(path ? { path } : {}) });
}

function provenanceFromLayout(layout: CanonicalDocumentLayout, sourceMetadata: CanonicalLayoutSourceMetadata | undefined): CanonicalLayoutResolutionProvenance {
  return {
    provider: layout.provider ?? sourceMetadata?.provider ?? null,
    providerModelId: layout.provider_model_id ?? sourceMetadata?.providerModelId ?? null,
    providerApiVersion: layout.provider_api_version ?? sourceMetadata?.providerApiVersion ?? null,
    sourcePayloadHash: sourceMetadata?.sourcePayloadHash ?? null,
    generatedAt: sourceMetadata?.generatedAt ?? null,
  };
}

// ── Per-source resolution (Task B.2-B.4) ─────────────────────────────────────

interface ProvidedLayoutEvaluation {
  validation: CanonicalLayoutValidationResult;
  schemaStatus: SchemaVersionStatus;
  fidelity: CanonicalLayoutResolutionFidelity;
  /** True only when the layout is schema-compatible AND structurally valid
   *  -- i.e. safe to return as the winning, authoritative source without
   *  further caveats beyond its own warnings. */
  usable: boolean;
}

function evaluateProvidedLayout(layout: CanonicalDocumentLayout): ProvidedLayoutEvaluation {
  const schemaStatus = classifySchemaVersion(layout.schema_version);
  const validation = validateCanonicalLayout(layout);
  const fidelity = fidelityForProvidedLayout(layout, schemaStatus);

  // validateCanonicalLayout() itself treats a missing schema_version as a
  // fatal "missing_schema_version" error (schema_version is a required
  // invariant on every newly-built layout, per Phase 1). Task C's
  // resolver-level policy deliberately overrides that for *historical*
  // version-absent layouts specifically -- they're still accepted, just
  // downgraded to unknown fidelity with an explicit warning -- so that one
  // error code is excluded from this resolver's own usability gate. Every
  // other fatal error still blocks usability exactly as the validator
  // reports it; `validation` itself is returned unmodified so a caller
  // still sees the raw, honest validator result (Task B.7: fatal validation
  // must be visible).
  const structuralErrors = validation.errors.filter((e) => e.code !== "missing_schema_version");
  const structurallyUsable = structuralErrors.length === 0;

  const schemaCompatible = schemaStatus === "current" || schemaStatus === "older_supported" || schemaStatus === "missing";
  return { validation, schemaStatus, fidelity, usable: structurallyUsable && schemaCompatible };
}

function resolveFromAzureResult(
  azureAnalyzeResult: AzureAnalyzeResultLike,
  sourceMetadata: CanonicalLayoutSourceMetadata | undefined,
  priorWarnings: CanonicalWarning[],
): CanonicalLayoutResolutionResult {
  const layout = azureAnalyzeResultToCanonicalLayout(azureAnalyzeResult, {
    modelId: sourceMetadata?.providerModelId ?? undefined,
    apiVersion: sourceMetadata?.providerApiVersion ?? undefined,
  });
  const validation = validateCanonicalLayout(layout);
  return {
    layout,
    source: "azure_analyze_result",
    fidelity: "lossless",
    validation,
    warnings: [...priorWarnings, ...(layout.warnings ?? [])],
    provenance: provenanceFromLayout(layout, sourceMetadata),
  };
}

async function resolveFromDoclingRaw(
  doclingRaw: unknown,
  sourceMetadata: CanonicalLayoutSourceMetadata | undefined,
  priorWarnings: CanonicalWarning[],
): Promise<CanonicalLayoutResolutionResult> {
  const layout = await legacyDoclingToCanonicalLayout(doclingRaw as Record<string, unknown> | null | undefined, {});
  const validation = validateCanonicalLayout(layout);
  return {
    layout,
    source: "legacy_docling_raw",
    fidelity: "legacy_lossy",
    validation,
    warnings: [...priorWarnings],
    provenance: provenanceFromLayout(layout, sourceMetadata),
  };
}

// ── Main resolver (Task B) ────────────────────────────────────────────────────

/**
 * Resolves a `CanonicalDocumentLayout` from whichever of `canonicalLayout`,
 * `azureAnalyzeResult`, or `doclingRaw` are supplied. Not a first-non-null
 * helper -- exact rules:
 *
 * 1. Zero sources supplied -> `{ layout: null, source: "none", fidelity:
 *    "unknown" }`. Never throws for this ordinary case.
 *
 * 2. Exactly one source supplied -> resolved directly via that source's
 *    rule below. No conflict is possible with a single source.
 *
 * 3. `canonicalLayout` supplied: schema-version-classified (Task C) and
 *    structurally validated. A schema version outside
 *    [MINIMUM_SUPPORTED_SCHEMA_VERSION, CANONICAL_LAYOUT_SCHEMA_VERSION] or
 *    a structurally invalid layout is never silently accepted as the
 *    winning source -- the resolver falls back to the next available
 *    source (azureAnalyzeResult, then doclingRaw), with a warning
 *    recording exactly why the supplied layout was passed over. If it is
 *    the *only* source available, it is still returned (data is never
 *    discarded) but with `validation.valid === false` and the relevant
 *    warnings fully visible -- "do not silently accept" means "do not
 *    silently accept as trustworthy," not "discard the data."
 *
 * 4. `azureAnalyzeResult` supplied (and not superseded by a usable,
 *    same-generation `canonicalLayout`): converted via
 *    `azureAnalyzeResultToCanonicalLayout()`, validated, reported with
 *    `fidelity: "lossless"`.
 *
 * 5. `doclingRaw` supplied (and no `canonicalLayout`/`azureAnalyzeResult`
 *    won precedence): converted via `legacyDoclingToCanonicalLayout()`,
 *    validated, reported with `fidelity: "legacy_lossy"` explicitly --
 *    this is never mislabeled as lossless.
 *
 * 6. When both `canonicalLayout` and `azureAnalyzeResult` are supplied and
 *    the provided layout is schema-compatible and structurally valid, the
 *    resolver compares provenance (`content_hash` first, then
 *    `metadata.generated_at`, per `compareProvidedLayoutAgainstNewSource`):
 *      - same generation -> the provided `canonicalLayout` wins (avoids
 *        redundant recomputation of a source already known equivalent).
 *      - the new source is demonstrably newer -> the Azure result wins;
 *        the stale canonical layout is never silently preferred.
 *      - undetermined (missing hash and missing/unparseable timestamps on
 *        either side) -> the Azure result wins as the safer,
 *        freshly-supplied default, but a loud `severity: "recoverable"`
 *        conflict warning is always attached (`canonical_source_authority_undetermined`)
 *        so a caller can investigate rather than the ambiguity being
 *        invisible.
 *
 * 7. Never throws for ordinary missing-input or unresolvable-authority
 *    cases -- always returns a `CanonicalLayoutResolutionResult`, with
 *    problems surfaced via `validation`/`warnings`, never via an exception.
 */
export async function resolveCanonicalDocumentLayout(
  input: ResolveCanonicalDocumentLayoutInput = {},
): Promise<CanonicalLayoutResolutionResult> {
  const hasCanonical = input.canonicalLayout != null;
  const hasAzure = input.azureAnalyzeResult != null;
  const hasDocling = input.doclingRaw != null;

  if (!hasCanonical && !hasAzure && !hasDocling) {
    return { layout: null, source: "none", fidelity: "unknown", validation: null, warnings: [], provenance: {} };
  }

  const canonicalEvaluation = hasCanonical ? evaluateProvidedLayout(input.canonicalLayout!) : null;

  if (hasCanonical && canonicalEvaluation!.usable && hasAzure) {
    const comparison = compareProvidedLayoutAgainstNewSource(input.canonicalLayout!, input.sourceMetadata);

    if (comparison === "same_generation") {
      const warnings = [...canonicalEvaluation!.validation.warnings];
      if (canonicalEvaluation!.schemaStatus === "missing") {
        pushWarning(warnings, "canonical_layout_schema_version_missing", "Provided canonicalLayout has no schema_version; accepted with unknown fidelity per legacy/unknown provenance policy", "recoverable", "schema_version");
      }
      return {
        layout: input.canonicalLayout!,
        source: "provided_canonical_layout",
        fidelity: canonicalEvaluation!.fidelity,
        validation: canonicalEvaluation!.validation,
        warnings,
        provenance: provenanceFromLayout(input.canonicalLayout!, input.sourceMetadata),
      };
    }

    if (comparison === "new_source_newer") {
      const warnings: CanonicalWarning[] = [];
      pushWarning(
        warnings,
        "canonical_layout_superseded_by_newer_source",
        "Provided canonicalLayout's provenance (content_hash or metadata.generated_at) indicates it predates the newly supplied Azure analyzeResult; the Azure result was used instead of the stale canonical layout",
        "recoverable",
      );
      return resolveFromAzureResult(input.azureAnalyzeResult!, input.sourceMetadata, warnings);
    }

    // comparison === "undetermined"
    const warnings: CanonicalWarning[] = [];
    pushWarning(
      warnings,
      "canonical_source_authority_undetermined",
      "Both canonicalLayout and azureAnalyzeResult were supplied, but authority between them could not be established (no matching/comparable content_hash or generated_at metadata); the Azure result was used as the safer freshly-supplied default -- this conflict should be investigated by the caller",
      "recoverable",
    );
    return resolveFromAzureResult(input.azureAnalyzeResult!, input.sourceMetadata, warnings);
  }

  if (hasCanonical && canonicalEvaluation!.usable) {
    // Only canonicalLayout supplied (or supplied alongside doclingRaw,
    // which never outranks a usable canonicalLayout).
    const warnings = [...canonicalEvaluation!.validation.warnings];
    if (canonicalEvaluation!.schemaStatus === "missing") {
      pushWarning(warnings, "canonical_layout_schema_version_missing", "Provided canonicalLayout has no schema_version; accepted with unknown fidelity per legacy/unknown provenance policy", "recoverable", "schema_version");
    }
    return {
      layout: input.canonicalLayout!,
      source: "provided_canonical_layout",
      fidelity: canonicalEvaluation!.fidelity,
      validation: canonicalEvaluation!.validation,
      warnings,
      provenance: provenanceFromLayout(input.canonicalLayout!, input.sourceMetadata),
    };
  }

  if (hasCanonical && !canonicalEvaluation!.usable) {
    // The supplied layout is schema-incompatible and/or structurally
    // invalid. Never silently accepted -- fall back to the next source if
    // one exists; the rejection itself is always surfaced as a warning.
    const rejectionWarnings: CanonicalWarning[] = [];
    if (canonicalEvaluation!.schemaStatus === "too_old") {
      pushWarning(rejectionWarnings, "canonical_layout_schema_version_too_old", `Provided canonicalLayout.schema_version is below MINIMUM_SUPPORTED_SCHEMA_VERSION (${MINIMUM_SUPPORTED_SCHEMA_VERSION}); not accepted as authoritative`, "fatal", "schema_version");
    } else if (canonicalEvaluation!.schemaStatus === "too_new") {
      pushWarning(rejectionWarnings, "canonical_layout_schema_version_too_new", `Provided canonicalLayout.schema_version is newer than CANONICAL_LAYOUT_SCHEMA_VERSION (${CANONICAL_LAYOUT_SCHEMA_VERSION}) this resolver understands; not accepted as authoritative`, "fatal", "schema_version");
    }
    if (!canonicalEvaluation!.validation.valid) {
      pushWarning(rejectionWarnings, "canonical_layout_structurally_invalid", "Provided canonicalLayout failed validateCanonicalLayout(); not accepted as authoritative", "fatal");
    }

    if (hasAzure) {
      return resolveFromAzureResult(input.azureAnalyzeResult!, input.sourceMetadata, rejectionWarnings);
    }
    if (hasDocling) {
      return await resolveFromDoclingRaw(input.doclingRaw, input.sourceMetadata, rejectionWarnings);
    }

    // No fallback source available -- return the flawed layout anyway
    // (never discard data), with the problem fully visible.
    return {
      layout: input.canonicalLayout!,
      source: "provided_canonical_layout",
      fidelity: canonicalEvaluation!.fidelity,
      validation: canonicalEvaluation!.validation,
      warnings: [...canonicalEvaluation!.validation.warnings, ...rejectionWarnings],
      provenance: provenanceFromLayout(input.canonicalLayout!, input.sourceMetadata),
    };
  }

  if (hasAzure) {
    return resolveFromAzureResult(input.azureAnalyzeResult!, input.sourceMetadata, []);
  }

  return await resolveFromDoclingRaw(input.doclingRaw, input.sourceMetadata, []);
}
