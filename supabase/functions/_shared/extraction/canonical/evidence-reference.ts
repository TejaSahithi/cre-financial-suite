// @ts-nocheck
/**
 * Canonical Claim/Evidence Layer (Phase 2) — EvidenceReference.
 *
 * nodeId/polygon/ocrConfidence are forward-compatible placeholders for the
 * real Azure document-node graph -- that graph does NOT exist yet
 * (section-router.ts's own docstring: "deliberately does NOT introduce a
 * second document graph"; the strict-outputs pilot's sourceNodeIds is the
 * same honest placeholder for the same reason). Every EvidenceReference
 * built by claim-converters.ts today sets these three fields to null and
 * relies on `quote` + `pageNumber` instead, verified against the real
 * document via claim-validation.ts's verifyClaimEvidence (which reuses
 * evidence-index.ts's existing resolveVerifiedSourcePage). Building the
 * real node graph is a separate, later phase -- do not populate these
 * fields with fabricated values in the meantime.
 */

export type EvidenceRole = "direct" | "definition" | "corroborating" | "amending" | "conflicting";

export interface EvidenceReference {
  documentId: string;
  pageNumber: number | null;
  /** Always null until the real document-node graph exists. */
  nodeId: string | null;

  quote: string;
  /** Always null until the real document-node graph exists. */
  polygon: number[] | null;
  /** Always null -- no OCR-confidence signal is available at this layer today. */
  ocrConfidence: number | null;

  role: EvidenceRole;
}
