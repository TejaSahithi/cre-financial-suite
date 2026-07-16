// @ts-nocheck
/**
 * Document Intelligence v3 — Fact Mapper (Phase 2, extended in Phase 7 to
 * consume the evidence_anchors Phase 6 computes when the canonical-layout
 * document index ran -- see buildEvidenceAnchorIndex()/resolveEvidenceAnchor()
 * below).
 *
 * Maps the vertex_fact_ledger provider's already-computed output (per
 * docs/document-intelligence-v3-baseline.md Section 5) into v3
 * document_claims / document_claim_evidence / document_validation_drops /
 * document_canonical_field_projections row shapes.
 *
 * This module does NOT call vertex_fact_ledger, does not reimplement its
 * fact extraction or field mapping, and does not invent a second claim
 * shape -- it is a pure, read-only transform over
 * result.metadata.extractionDebug (the exact contract every extraction
 * provider, legacy_hybrid included, already returns per pipeline.ts's
 * snapshotFieldMap()). Per Phase 2 Task B: if vertex_fact_ledger did not
 * run for this row, every function here returns zero claims -- it never
 * fabricates a claim from legacy_hybrid output.
 *
 * Two claim sources, both genuinely vertex_fact_ledger-derived data:
 *   1. Mapped canonical fields (validated_field_values / merged_field_sources)
 *      -- one claim per field the fact-field-mapper successfully mapped.
 *   2. Dynamic items (vertex_fact_ledger.dynamic_items) -- one claim per
 *      fact the fact-field-mapper could NOT map, already reshaped by
 *      dynamic-fact-surfacer.ts's createDocumentItem() call, which is the
 *      real per-fact detail (category/value/sourceText/sourcePage/confidence)
 *      still available downstream of the orchestrator.
 */

export interface DocumentIntelligenceV3ClaimRow {
  id: string;
  org_id: string;
  uploaded_file_id: string;
  lease_id: string | null;
  claim_type: string;
  subject: Record<string, unknown>;
  predicate: string;
  object: Record<string, unknown>;
  conditions: unknown[];
  effective_from: string | null;
  effective_to: string | null;
  extraction_mode: string;
  confidence: Record<string, unknown>;
  canonical_field_candidates: string[];
  validation_status: "pending" | "passed" | "failed";
  evidence_sufficiency: "strong" | "partial" | "weak" | "none";
  validation_rules: string[];
  importance: number | null;
}

export interface DocumentIntelligenceV3ClaimEvidenceRow {
  claim_id: string;
  org_id: string;
  document_id: string | null;
  uploaded_file_id: string | null;
  page: number | null;
  source_text: string | null;
  block_ids: string[];
  polygon: number[];
  support_type: string;
}

export interface DocumentIntelligenceV3ValidationDropRow {
  org_id: string;
  uploaded_file_id: string;
  claim_id: string | null;
  field_key: string | null;
  bad_value: unknown;
  reason: string;
  source_text: string | null;
  action: "dropped" | "flagged";
}

export interface DocumentIntelligenceV3CanonicalFieldProjectionRow {
  org_id: string;
  uploaded_file_id: string;
  lease_id: string | null;
  field_key: string;
  value: unknown;
  normalized_value: unknown;
  status: "missing" | "auto_populated" | "needs_review" | "reviewer_confirmed" | "reviewer_edited";
  source_claim_ids: string[];
  source_page: number | null;
  source_text: string | null;
  confidence: number | null;
  extraction_mode: string | null;
  validation_status: "pending" | "passed" | "failed";
  canonical_tab: string | null;
  profile_relevance: "required" | "advisory" | "not_applicable";
}

function newId(): string {
  return crypto.randomUUID();
}

function inferExtractionMode(source: unknown): string {
  return source === "calculated" ? "calculated" : "explicit";
}

function readVertexFactLedgerDebug(result: any): Record<string, unknown> | null {
  const debug = result?.metadata?.extractionDebug;
  const vfl = debug?.vertex_fact_ledger;
  return vfl && typeof vfl === "object" ? vfl : null;
}

function readFieldSnapshot(result: any): Record<string, any> {
  const debug = result?.metadata?.extractionDebug ?? {};
  const snapshot = debug.validated_field_values ?? debug.merged_field_sources;
  return snapshot && typeof snapshot === "object" ? snapshot : {};
}

function fieldHasValidationError(result: any, fieldKey: string): boolean {
  const errors = Array.isArray(result?.validationErrors) ? result.validationErrors : [];
  return errors.some((e: any) => e?.field === fieldKey);
}

const DEFAULT_EVIDENCE_ANCHOR: { blockIds: string[]; polygon: number[]; supportType: string } = {
  blockIds: [],
  polygon: [],
  supportType: "direct_quote",
};

/**
 * Phase 7 Task B: indexes vertex_fact_ledger's evidence_anchors (Phase 6,
 * orchestrator.ts) by source_text so real block_ids/polygon/support_type
 * can be attached to a claim's evidence row when available. Never invents
 * an anchor -- an empty/missing evidence_anchors array (legacy_evidence_index
 * ran, or vertex_fact_ledger predates Phase 6) simply yields an empty index,
 * and every lookup then falls through to DEFAULT_EVIDENCE_ANCHOR, which is
 * byte-identical to Phase 2's original hardcoded evidence shape.
 */
function buildEvidenceAnchorIndex(vfl: Record<string, unknown> | null): Map<string, typeof DEFAULT_EVIDENCE_ANCHOR> {
  const index = new Map<string, typeof DEFAULT_EVIDENCE_ANCHOR>();
  const anchors = Array.isArray(vfl?.evidence_anchors) ? (vfl!.evidence_anchors as any[]) : [];
  for (const anchor of anchors) {
    const sourceText = typeof anchor?.source_text === "string" ? anchor.source_text.trim() : "";
    if (!sourceText || index.has(sourceText)) continue;
    index.set(sourceText, {
      blockIds: Array.isArray(anchor.block_ids) ? anchor.block_ids : [],
      polygon: Array.isArray(anchor.polygon) ? anchor.polygon : [],
      // support_type is a NOT NULL, CHECK-constrained column on
      // document_claim_evidence -- a null/missing support_type (Phase 6's
      // enrichFactWithBlockEvidence reports null when no block matched)
      // must still coerce to a valid default, never persist as null.
      supportType: typeof anchor.support_type === "string" ? anchor.support_type : DEFAULT_EVIDENCE_ANCHOR.supportType,
    });
  }
  return index;
}

function resolveEvidenceAnchor(
  index: Map<string, typeof DEFAULT_EVIDENCE_ANCHOR>,
  sourceText: string | null,
): typeof DEFAULT_EVIDENCE_ANCHOR {
  if (!sourceText) return DEFAULT_EVIDENCE_ANCHOR;
  return index.get(sourceText.trim()) ?? DEFAULT_EVIDENCE_ANCHOR;
}

/**
 * True whenever vertex_fact_ledger ran for this row, regardless of whether
 * it found any facts -- callers use this to decide whether to still create
 * a v3 run record (Task B: "still create a v3 run record if useful, mark
 * claim count = 0").
 */
export function vertexFactLedgerRan(result: any): boolean {
  return readVertexFactLedgerDebug(result) !== null;
}

export interface ExtractClaimsInput {
  result: any;
  orgId: string;
  uploadedFileId: string;
  leaseId: string | null;
}

export interface ExtractClaimsOutput {
  factsPresent: boolean;
  claims: DocumentIntelligenceV3ClaimRow[];
  evidence: DocumentIntelligenceV3ClaimEvidenceRow[];
}

/**
 * Builds claim + evidence rows strictly from vertex_fact_ledger's own
 * already-computed output. Returns empty arrays (never throws, never
 * fabricates) when vertex_fact_ledger did not run or found nothing.
 */
export function extractVertexFactLedgerClaims(input: ExtractClaimsInput): ExtractClaimsOutput {
  const { result, orgId, uploadedFileId, leaseId } = input;
  const vfl = readVertexFactLedgerDebug(result);
  if (!vfl) {
    return { factsPresent: false, claims: [], evidence: [] };
  }

  const claims: DocumentIntelligenceV3ClaimRow[] = [];
  const evidence: DocumentIntelligenceV3ClaimEvidenceRow[] = [];
  const anchorIndex = buildEvidenceAnchorIndex(vfl);

  // ── 1. Mapped canonical fields ─────────────────────────────────────────
  const snapshot = readFieldSnapshot(result);
  for (const [fieldKey, entry] of Object.entries(snapshot)) {
    if (entry == null || typeof entry !== "object") continue;
    if ((entry as any).value == null) continue;

    const claimId = newId();
    const sourceText = typeof (entry as any).source_text === "string" ? (entry as any).source_text : null;

    claims.push({
      id: claimId,
      org_id: orgId,
      uploaded_file_id: uploadedFileId,
      lease_id: leaseId,
      claim_type: "canonical_field",
      subject: {},
      predicate: "has_value",
      object: { field_key: fieldKey, value: (entry as any).value },
      conditions: [],
      effective_from: null,
      effective_to: null,
      extraction_mode: inferExtractionMode((entry as any).source),
      confidence: { composite: Number((entry as any).confidence) || 0 },
      canonical_field_candidates: [fieldKey],
      validation_status: fieldHasValidationError(result, fieldKey) ? "failed" : "passed",
      evidence_sufficiency: sourceText ? "strong" : "none",
      validation_rules: [],
      importance: null,
    });

    if (sourceText) {
      const anchor = resolveEvidenceAnchor(anchorIndex, sourceText);
      evidence.push({
        claim_id: claimId,
        org_id: orgId,
        document_id: null,
        uploaded_file_id: uploadedFileId,
        page: typeof (entry as any).source_page === "number" ? (entry as any).source_page : null,
        source_text: sourceText,
        block_ids: anchor.blockIds,
        polygon: anchor.polygon,
        support_type: anchor.supportType,
      });
    }
  }

  // ── 2. Dynamic items (unmapped facts, already Fact-derived) ────────────
  const dynamicItems = Array.isArray(vfl.dynamic_items) ? vfl.dynamic_items : [];
  for (const item of dynamicItems) {
    if (!item || typeof item !== "object") continue;

    const claimId = newId();
    const sourceText = typeof item.source_text === "string" ? item.source_text : null;

    claims.push({
      id: claimId,
      org_id: orgId,
      uploaded_file_id: uploadedFileId,
      lease_id: leaseId,
      claim_type: String(item.item_type || "unknown"),
      subject: {},
      predicate: "mentions",
      object: { value: item.value ?? null, label: item.label ?? null },
      conditions: [],
      effective_from: null,
      effective_to: null,
      extraction_mode: "explicit",
      confidence: { composite: Number(item.confidence) || 0 },
      canonical_field_candidates: item.field_key ? [String(item.field_key)] : [],
      validation_status: "pending",
      evidence_sufficiency: sourceText ? "strong" : "none",
      validation_rules: [],
      importance: null,
    });

    if (sourceText) {
      const anchor = resolveEvidenceAnchor(anchorIndex, sourceText);
      evidence.push({
        claim_id: claimId,
        org_id: orgId,
        document_id: item.document_id ?? null,
        uploaded_file_id: uploadedFileId,
        page: typeof item.source_page === "number" ? item.source_page : null,
        source_text: sourceText,
        block_ids: anchor.blockIds,
        polygon: anchor.polygon,
        support_type: anchor.supportType,
      });
    }
  }

  const factsPresent = Number(vfl.facts_extracted_count) > 0 || claims.length > 0;
  return { factsPresent, claims, evidence };
}

/**
 * Maps result.validationErrors (the same ValidationError[] every provider
 * returns, per types.ts) into document_validation_drops rows. Not gated on
 * vertex_fact_ledger having run -- validation errors are a property of the
 * extraction result itself, whichever provider produced it.
 */
export function extractValidationDrops(input: {
  result: any;
  orgId: string;
  uploadedFileId: string;
}): DocumentIntelligenceV3ValidationDropRow[] {
  const { result, orgId, uploadedFileId } = input;
  const errors = Array.isArray(result?.validationErrors) ? result.validationErrors : [];
  return errors.map((e: any) => ({
    org_id: orgId,
    uploaded_file_id: uploadedFileId,
    claim_id: null,
    field_key: e?.field ?? null,
    bad_value: e?.receivedValue ?? null,
    reason: e?.message ?? "Validation failed",
    source_text: null,
    action: "dropped" as const,
  }));
}

/**
 * Maps vertex_fact_ledger's field-level snapshot into
 * document_canonical_field_projections rows -- one row per field key the
 * mapper attempted (present with a value, or present-but-rejected to null).
 * Only produced when vertex_fact_ledger ran, matching the claims source.
 *
 * `claims` (optional): the same claim rows extractVertexFactLedgerClaims()
 * just built for this run. When supplied, each projection's
 * source_claim_ids is populated by matching the canonical_field claim whose
 * object.field_key equals this projection's field_key -- this is what lets
 * Phase 3's readiness evaluator resolve a field's evidence via
 * document_claim_evidence instead of guessing. Omitting `claims` (e.g. an
 * older caller) degrades to source_claim_ids: [], same as before this was
 * added.
 */
export function extractCanonicalFieldProjections(input: {
  result: any;
  orgId: string;
  uploadedFileId: string;
  leaseId: string | null;
  claims?: DocumentIntelligenceV3ClaimRow[];
}): DocumentIntelligenceV3CanonicalFieldProjectionRow[] {
  const { result, orgId, uploadedFileId, leaseId, claims } = input;
  if (!vertexFactLedgerRan(result)) return [];

  const snapshot = readFieldSnapshot(result);
  const rows: DocumentIntelligenceV3CanonicalFieldProjectionRow[] = [];

  const claimIdsByFieldKey = new Map<string, string[]>();
  for (const claim of claims ?? []) {
    if (claim.claim_type !== "canonical_field") continue;
    const fieldKey = (claim.object as any)?.field_key;
    if (typeof fieldKey !== "string") continue;
    const existing = claimIdsByFieldKey.get(fieldKey) ?? [];
    existing.push(claim.id);
    claimIdsByFieldKey.set(fieldKey, existing);
  }

  for (const [fieldKey, entry] of Object.entries(snapshot)) {
    if (entry == null || typeof entry !== "object") continue;
    const value = (entry as any).value ?? null;
    const sourceText = typeof (entry as any).source_text === "string" ? (entry as any).source_text : null;

    rows.push({
      org_id: orgId,
      uploaded_file_id: uploadedFileId,
      lease_id: leaseId,
      field_key: fieldKey,
      value,
      normalized_value: value,
      status: value != null ? "auto_populated" : "missing",
      source_claim_ids: claimIdsByFieldKey.get(fieldKey) ?? [],
      source_page: typeof (entry as any).source_page === "number" ? (entry as any).source_page : null,
      source_text: sourceText,
      confidence: typeof (entry as any).confidence === "number" ? (entry as any).confidence : null,
      extraction_mode: value != null ? inferExtractionMode((entry as any).source) : null,
      validation_status: fieldHasValidationError(result, fieldKey) ? "failed" : "passed",
      canonical_tab: null,
      profile_relevance: "advisory",
    });
  }

  return rows;
}
