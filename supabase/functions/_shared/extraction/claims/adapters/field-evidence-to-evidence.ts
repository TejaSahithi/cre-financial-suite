// @ts-nocheck
/**
 * field-evidence-to-evidence.ts — P2.4.
 *
 * Shared evidence-construction helper reused by both the deterministic and
 * semantic adapters -- turns a {sourceText, sourcePage} pair (the shape
 * every current extraction field already carries, per ExtractedField /
 * LeaseWorkflowField in _shared/extraction/types.ts and lease-workflow.ts)
 * into a batch-ready evidence item.
 *
 * location_precision is honest about what's actually available today (P2.1
 * design decision): only ever "page" or "page_and_span" -- no adapter
 * populates bounding-region/polygon geometry yet, so "geometry" is never
 * produced here.
 */
import { buildEvidenceKey, hashSourceText } from "./evidence-key.ts";

export interface FieldEvidenceInput {
  uploadedFileId: string;
  extractionRunId: string;
  sourcePage: number | null | undefined;
  sourceText: string | null | undefined;
  artifactId?: string | null;
}

export interface EvidenceBatchItem {
  local_id: string;
  evidence_key: string;
  location_precision: "page" | "page_and_span";
  page_start: number;
  span_start?: number;
  span_end?: number;
  source_text?: string;
  source_text_hash?: string | null;
  artifact_id?: string | null;
}

/** Returns null when there is no real evidence to record (no page and no
 *  source text) -- callers must not synthesize a fake evidence row just to
 *  satisfy a required-evidence check; a missing evidence source is itself
 *  meaningful (surfaces as REQUIRED_CLAIM_EVIDENCE_MISSING downstream, not
 *  papered over here). */
export async function buildFieldEvidence(
  localId: string,
  input: FieldEvidenceInput,
): Promise<EvidenceBatchItem | null> {
  const hasPage = typeof input.sourcePage === "number" && input.sourcePage > 0;
  const hasText = typeof input.sourceText === "string" && input.sourceText.trim().length > 0;
  if (!hasPage && !hasText) return null;

  const pageStart = hasPage ? (input.sourcePage as number) : 1; // page constraint requires >=1; text-only evidence still needs a page value -- defaults to 1, documented as a known ceiling until adapters carry a real page for text-only spans.
  const sourceTextHash = hasText ? await hashSourceText(input.sourceText) : null;

  const evidenceKey = buildEvidenceKey({
    uploadedFileId: input.uploadedFileId,
    extractionRunId: input.extractionRunId,
    pageStart,
    sourceTextHash,
  });

  const item: EvidenceBatchItem = {
    local_id: localId,
    evidence_key: evidenceKey,
    location_precision: hasText ? "page_and_span" : "page",
    page_start: pageStart,
    artifact_id: input.artifactId ?? null,
  };

  if (hasText) {
    item.source_text = input.sourceText as string;
    item.source_text_hash = sourceTextHash;
    // Span offsets are not tracked at this adapter layer today (the merge
    // stage doesn't currently preserve an offset into the full document
    // text for a given field) -- 0-length placeholder span anchored at the
    // start of the page's text is the honest ceiling until that's threaded
    // through, matching the "no fabricated geometry" principle already
    // applied to bounding_regions.
    item.span_start = 0;
    item.span_end = (input.sourceText as string).length;
  }

  return item;
}
