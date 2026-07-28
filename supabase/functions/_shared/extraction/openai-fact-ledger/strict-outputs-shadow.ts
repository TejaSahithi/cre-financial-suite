// @ts-nocheck
/**
 * Strict Structured Outputs pilot — shadow call orchestration + evidence-
 * aware diffing, expenses_and_cam only (Phase 1).
 *
 * Called from adaptive-extractor.ts's domain loop AFTER the authoritative
 * schema-aware mapping call for expenses_and_cam has already completed and
 * succeeded. Never blocks, never retries, never feeds back into the
 * authoritative result -- a non-"success" StructuredLlmStatus is recorded
 * here (metrics.status) and otherwise ignored by the caller.
 *
 * The diff intentionally compares against `primaryResult.assignments`
 * (adaptive-extractor.ts's own per-field FieldAssignment map for this exact
 * domain call), not the fully cross-domain-merged UI fields -- that keeps
 * the shadow call and the diff scoped to the same evidence text and the
 * same field set, with no dependency on merge/mapper timing.
 *
 * sourceNodeIds is part of the pilot schema's envelope (matching the
 * reviewed spec) but is NOT populated by this phase -- there is no
 * document-node graph yet (that is a later, explicitly-deferred phase). The
 * shadow prompt tells the model to leave it empty, and evidence comparison
 * here relies on sourceQuote, not sourceNodeIds.
 */

import { callLLMStructuredWithProvenance } from "../provenance/transport/openai.ts";
import type { ProvenanceContext } from "../provenance/types.ts";
import { getExpensesAndCamStrictSchema } from "../schemas/domains/expenses-and-cam.v1.schema.ts";
import type { StrictExtractedField, StrictFieldStatus } from "../schemas/schema-registry.ts";
import type { StructuredLlmStatus } from "../../llm.ts";
import { shouldRunStrictOutputsShadow } from "./llm-strict-outputs-mode.ts";
import type { ModuleType } from "../types.ts";
import type { FieldDef } from "../schemas.ts";

interface AuthoritativeAssignment {
  value: unknown;
  sourceText: string | null;
}

export interface FieldDiff {
  fieldCode: string;
  /** The schema-aware mapper's OWN proposal, captured at shadow-call time --
   *  BEFORE the self-consistency verifier runs. Comparing strict output
   *  against this alone is misleading: a field the verifier later nulls (or
   *  a field a downstream bug drops before it ever reaches the UI) would
   *  wrongly read as a "disagreement" with strict output, when in fact the
   *  authoritative pipeline never actually published that value either. */
  rawMapperValue: unknown;
  /** The SAME field's value after applyValidationCorrections() has run
   *  (orchestrator.ts, post-verification) -- populated by
   *  enrichFieldDiffsWithPostVerification(), null until that runs. This is
   *  the correct "extraction comparison" baseline: what the authoritative
   *  pipeline actually concluded, not its first draft. */
  postVerificationValue: unknown;
  strictValue: unknown;
  /** rawMapperValue vs strictValue -- kept for backward-compatible shadow
   *  diagnostics, but NOT the comparison that should drive any accuracy
   *  conclusion; see strictVsVerifiedAgreement. */
  sameValue: boolean;
  /** strictValue vs postVerificationValue -- the real "did strict output
   *  agree with what the authoritative pipeline actually concluded" signal.
   *  Null until enrichFieldDiffsWithPostVerification() runs. */
  strictVsVerifiedAgreement: boolean | null;
  /** True when the mapper proposed a real value (rawMapperValue != null) but
   *  it did not survive to postVerificationValue for a reason OTHER than an
   *  explicit verifier "null" decision -- i.e. it was silently dropped
   *  somewhere between the mapper and verification finishing, a production
   *  correctness defect distinct from any extraction-quality question this
   *  pilot is trying to measure. Null until enriched. */
  authoritativeDroppedDownstream: boolean | null;
  rawMapperHasEvidence: boolean;
  strictHasEvidence: boolean;
  rawMapperStatus: string | null;
  strictStatus: StrictFieldStatus | null;
}

export interface StrictOutputsShadowMetrics {
  domain: "expenses_and_cam";
  schemaVersion: string;
  status: StructuredLlmStatus;
  schemaCompliant: boolean;
  authoritativeFieldCount: number;
  strictFieldCount: number;
  authoritativeEvidenceCount: number;
  strictEvidenceCount: number;
  valueAgreementCount: number;
  valueDisagreementCount: number;
  /** Authoritative populated a value that strict abstained (not_found) on. */
  authoritativeNonNullStrictNull: number;
  /** Strict found a value authoritative missed entirely. */
  authoritativeNullStrictNonNull: number;
  strictAmbiguousCount: number;
  strictConflictingCount: number;
  strictNotFoundCount: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Populated by mergePostVerificationMetrics() after
   *  enrichFieldDiffsWithPostVerification() runs; null beforehand. This is
   *  the real "did strict output agree with what the authoritative pipeline
   *  actually concluded" signal -- valueAgreementCount/valueDisagreementCount
   *  above compare against the mapper's pre-verification first draft instead. */
  strictVsVerifiedAgreementCount: number | null;
  strictVsVerifiedDisagreementCount: number | null;
  /** Count of fields the mapper proposed a real value for that did not
   *  survive to the post-verification authoritative state for any reason
   *  OTHER than an explicit verifier "null" decision -- a production
   *  correctness defect, not an extraction-quality signal. Should be 0 on a
   *  healthy pipeline; see lease-truth-assembly.ts's
   *  findAlreadyReviewedFallback for one confirmed, fixed source of this. */
  authoritativeDroppedDownstreamCount: number | null;
}

export interface StrictOutputsShadowRecord {
  metrics: StrictOutputsShadowMetrics;
  fieldDiffs: FieldDiff[];
  errorMessage: string | null;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export function computeFieldDiffs(
  fieldKeys: string[],
  authoritative: Record<string, AuthoritativeAssignment | undefined>,
  strict: Record<string, StrictExtractedField | undefined>,
): FieldDiff[] {
  return fieldKeys.map((fieldCode) => {
    const current = authoritative[fieldCode];
    const strictField = strict[fieldCode];
    const rawMapperValue = current?.value ?? null;
    const strictValue =
      strictField && strictField.status !== "not_found" && strictField.status !== "illegible"
        ? strictField.value ?? null
        : null;
    return {
      fieldCode,
      rawMapperValue,
      // Populated later by enrichFieldDiffsWithPostVerification() -- not
      // knowable at shadow-call time, since verification hasn't run yet.
      postVerificationValue: null,
      strictValue,
      sameValue: valuesEqual(rawMapperValue, strictValue),
      strictVsVerifiedAgreement: null,
      authoritativeDroppedDownstream: null,
      rawMapperHasEvidence: !!current?.sourceText,
      strictHasEvidence: !!(strictField?.sourceQuote || (strictField?.sourceNodeIds?.length ?? 0) > 0),
      rawMapperStatus: current ? "assigned" : "not_assigned",
      strictStatus: strictField?.status ?? null,
    };
  });
}

/**
 * Second-pass enrichment: call AFTER applyValidationCorrections() has run
 * (orchestrator.ts) with the SAME record's post-verification fields, so
 * each diff also carries what the authoritative pipeline actually
 * concluded -- not just its pre-verification first draft. Pure and
 * side-effect-free; returns new objects rather than mutating fieldDiffs.
 *
 * authoritativeDroppedDownstream deliberately does NOT fire when the
 * verifier explicitly nulled the field (that is a real, intentional
 * decision, not a defect) -- it only fires when a real proposed value
 * disappears WITHOUT an explicit uncertain/null verifier decision reaching
 * this field, which is the actual signature of the propagation bug this
 * was built to catch.
 */
export function enrichFieldDiffsWithPostVerification(
  fieldDiffs: FieldDiff[],
  postVerificationFields: Record<string, { value: unknown } | undefined>,
  /** Field keys the self-consistency verifier explicitly decided "null" on
   *  (applyValidationCorrections' "null" branch, llm-field-validator.ts) --
   *  a real, intentional decision, never counted as a drop. Everything else
   *  a real proposed value fails to survive into is either an explicit
   *  "uncertain" (value kept, just flagged -- postVerificationValue will be
   *  non-null so this never even applies) or a genuine, unexplained
   *  disappearance -- which is exactly what authoritativeDroppedDownstream
   *  exists to surface. */
  explicitlyNulledFields: ReadonlySet<string> = new Set(),
): FieldDiff[] {
  return fieldDiffs.map((diff) => {
    const postField = postVerificationFields[diff.fieldCode];
    const postVerificationValue = postField ? postField.value ?? null : null;
    const droppedWithoutExplanation =
      diff.rawMapperValue != null && postVerificationValue == null && !explicitlyNulledFields.has(diff.fieldCode);
    return {
      ...diff,
      postVerificationValue,
      strictVsVerifiedAgreement: valuesEqual(postVerificationValue, diff.strictValue),
      authoritativeDroppedDownstream: droppedWithoutExplanation,
    };
  });
}

export function computeShadowMetrics(args: {
  schemaVersion: string;
  status: StructuredLlmStatus;
  fieldDiffs: FieldDiff[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}): StrictOutputsShadowMetrics {
  const { fieldDiffs } = args;
  let authoritativeFieldCount = 0;
  let strictFieldCount = 0;
  let authoritativeEvidenceCount = 0;
  let strictEvidenceCount = 0;
  let valueAgreementCount = 0;
  let valueDisagreementCount = 0;
  let authoritativeNonNullStrictNull = 0;
  let authoritativeNullStrictNonNull = 0;
  let strictAmbiguousCount = 0;
  let strictConflictingCount = 0;
  let strictNotFoundCount = 0;

  for (const diff of fieldDiffs) {
    if (diff.rawMapperValue != null) authoritativeFieldCount++;
    if (diff.strictValue != null) strictFieldCount++;
    if (diff.rawMapperHasEvidence) authoritativeEvidenceCount++;
    if (diff.strictHasEvidence) strictEvidenceCount++;
    if (diff.rawMapperValue != null && diff.strictValue != null) {
      if (diff.sameValue) valueAgreementCount++;
      else valueDisagreementCount++;
    }
    if (diff.rawMapperValue != null && diff.strictValue == null) authoritativeNonNullStrictNull++;
    if (diff.rawMapperValue == null && diff.strictValue != null) authoritativeNullStrictNonNull++;
    if (diff.strictStatus === "ambiguous") strictAmbiguousCount++;
    if (diff.strictStatus === "conflicting") strictConflictingCount++;
    if (diff.strictStatus === "not_found") strictNotFoundCount++;
  }

  return {
    domain: "expenses_and_cam",
    schemaVersion: args.schemaVersion,
    status: args.status,
    schemaCompliant: args.status === "success",
    authoritativeFieldCount,
    strictFieldCount,
    authoritativeEvidenceCount,
    strictEvidenceCount,
    valueAgreementCount,
    valueDisagreementCount,
    authoritativeNonNullStrictNull,
    authoritativeNullStrictNonNull,
    strictAmbiguousCount,
    strictConflictingCount,
    strictNotFoundCount,
    latencyMs: args.latencyMs,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    strictVsVerifiedAgreementCount: null,
    strictVsVerifiedDisagreementCount: null,
    authoritativeDroppedDownstreamCount: null,
  };
}

/**
 * Second-pass companion to enrichFieldDiffsWithPostVerification() -- call
 * with the SAME enriched fieldDiffs to fold the post-verification counts
 * into a metrics object. Returns a new object; does not mutate.
 */
export function mergePostVerificationMetrics(
  metrics: StrictOutputsShadowMetrics,
  enrichedFieldDiffs: FieldDiff[],
): StrictOutputsShadowMetrics {
  let strictVsVerifiedAgreementCount = 0;
  let strictVsVerifiedDisagreementCount = 0;
  let authoritativeDroppedDownstreamCount = 0;
  for (const diff of enrichedFieldDiffs) {
    if (diff.postVerificationValue != null && diff.strictValue != null) {
      if (diff.strictVsVerifiedAgreement) strictVsVerifiedAgreementCount++;
      else strictVsVerifiedDisagreementCount++;
    }
    if (diff.authoritativeDroppedDownstream) authoritativeDroppedDownstreamCount++;
  }
  return { ...metrics, strictVsVerifiedAgreementCount, strictVsVerifiedDisagreementCount, authoritativeDroppedDownstreamCount };
}

function emptyMetrics(schemaVersion: string, status: StructuredLlmStatus, latencyMs: number, inputTokens: number, outputTokens: number): StrictOutputsShadowMetrics {
  return {
    domain: "expenses_and_cam",
    schemaVersion,
    status,
    schemaCompliant: false,
    authoritativeFieldCount: 0,
    strictFieldCount: 0,
    authoritativeEvidenceCount: 0,
    strictEvidenceCount: 0,
    valueAgreementCount: 0,
    valueDisagreementCount: 0,
    authoritativeNonNullStrictNull: 0,
    authoritativeNullStrictNonNull: 0,
    strictAmbiguousCount: 0,
    strictConflictingCount: 0,
    strictNotFoundCount: 0,
    latencyMs,
    inputTokens,
    outputTokens,
    strictVsVerifiedAgreementCount: null,
    strictVsVerifiedDisagreementCount: null,
    authoritativeDroppedDownstreamCount: null,
  };
}

function buildShadowSystemPrompt(fields: Array<[string, FieldDef]>): string {
  const fieldList = fields
    .map(([key, def]) => {
      let line = `- ${key} (${def.type}): ${def.description}`;
      if (def.type === "enum" && def.enumValues) line += ` [enum: ${def.enumValues.join(", ")}]`;
      return line;
    })
    .join("\n");

  return `You are a commercial real estate lease data extraction tool, operating in STRICT schema mode for the expense recovery / CAM / taxes / insurance / utility-reimbursement topic area.

For EACH field listed below, return a structured evidence envelope, never a bare value:
  - "status": one of "explicit" (the excerpt directly states this), "derived" (computed/implied from other stated facts -- explain how in uncertaintyReason), "not_found" (the excerpt does not address this field -- this is a correct, expected outcome, not a failure), "ambiguous" (more than one plausible reading exists), "conflicting" (the excerpt states two different values for this concept), "illegible" (the source text for this appears garbled/unreadable).
  - "value": the short atomic answer, or null when status is "not_found" or "illegible".
  - "rawValue": the exact verbatim source fragment the value was read from, or null.
  - "sourceQuote": a complete verbatim sentence, table row, or "Label: value" line supporting this field, or null when status is "not_found".
  - "sourceNodeIds": always an empty array -- not used in this phase.
  - "uncertaintyReason": a brief explanation when status is "derived"/"ambiguous"/"conflicting"/"illegible", otherwise null.

RULES:
1. "not_found" is the correct, expected answer whenever the excerpt is genuinely silent on a field -- never guess, infer, or fabricate a value to avoid an empty field.
2. Never populate "value" without a supporting "sourceQuote" (the only exceptions are "not_found" and "illegible").
3. Do not extract a field's value from a sentence discussing a different concept that merely uses similar words (e.g. a maintenance surcharge "added to" the rent is not the rent itself).
4. Every field listed below MUST appear as a key in your response, using the envelope shape above.

FIELDS:
${fieldList}`;
}

export interface RunStrictOutputsShadowArgs {
  orgId: string;
  generationId: string;
  moduleType: ModuleType;
  evidenceText: string;
  domainFieldDefs: Array<[string, FieldDef]>;
  authoritativeAssignments: Record<string, AuthoritativeAssignment | undefined>;
  provenance?: { supabaseAdmin: any; context: ProvenanceContext };
}

/**
 * Returns null when the canary gate says skip (flag off, org/sample-rate
 * miss) or when there is no provenance identity to attach the call to --
 * there is no orgId/generationId source in scope for the canary decision
 * without it, and no point running an unrecorded shadow call whose whole
 * purpose is to be inspected afterward.
 */
export async function runExpensesAndCamStrictOutputsShadow(
  args: RunStrictOutputsShadowArgs,
): Promise<StrictOutputsShadowRecord | null> {
  if (!args.provenance) return null;
  if (!shouldRunStrictOutputsShadow({ orgId: args.orgId, generationId: args.generationId })) return null;

  const schemaDef = getExpensesAndCamStrictSchema(args.moduleType);
  const startedAt = Date.now();
  const result = await callLLMStructuredWithProvenance(
    args.provenance.supabaseAdmin,
    { ...args.provenance.context, operation: "strict_outputs_shadow_expenses_and_cam" },
    {
      systemPrompt: buildShadowSystemPrompt(args.domainFieldDefs),
      userPrompt: args.evidenceText,
      temperature: 0,
      promptVersion: schemaDef.schemaVersion,
      schemaName: schemaDef.schemaName,
      schema: schemaDef.jsonSchema,
    },
  );
  const latencyMs = Date.now() - startedAt;

  if (result.status !== "success") {
    return {
      metrics: emptyMetrics(schemaDef.schemaVersion, result.status, latencyMs, result.inputTokens ?? 0, result.outputTokens ?? 0),
      fieldDiffs: [],
      errorMessage: result.errorMessage ?? result.refusalReason ?? `Shadow call returned status=${result.status}`,
    };
  }

  const fieldKeys = args.domainFieldDefs.map(([key]) => key);
  const strictFields =
    result.data && typeof result.data === "object" ? (result.data as Record<string, StrictExtractedField>) : {};
  const fieldDiffs = computeFieldDiffs(fieldKeys, args.authoritativeAssignments, strictFields);
  const metrics = computeShadowMetrics({
    schemaVersion: schemaDef.schemaVersion,
    status: "success",
    fieldDiffs,
    latencyMs,
    inputTokens: result.inputTokens ?? 0,
    outputTokens: result.outputTokens ?? 0,
  });

  return { metrics, fieldDiffs, errorMessage: null };
}
