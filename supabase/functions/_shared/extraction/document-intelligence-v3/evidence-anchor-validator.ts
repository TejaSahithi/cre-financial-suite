// @ts-nocheck

import type { CanonicalDocumentLayout } from "./canonical-layout.ts";
import type { DocumentIntelligenceV3ClaimEvidenceRow } from "./fact-mapper.ts";
import { isValidPolygon } from "./layout-provenance.ts";

export type AnchorValidationFindingCode =
  | "orphan_block_id"
  | "orphan_table_id"
  | "orphan_cell_id"
  | "page_out_of_range"
  | "page_mismatch"
  | "empty_polygon_on_azure_native"
  | "invalid_polygon_coordinates";

export interface AnchorValidationFinding {
  code: AnchorValidationFindingCode;
  claimId: string;
  evidenceId?: string;
  blockId?: string;
  pageNumber?: number | null;
  severity: "warning" | "material";
  message: string;
}

export interface AnchorValidationResult {
  sanitizedEvidence: DocumentIntelligenceV3ClaimEvidenceRow[];
  findings: AnchorValidationFinding[];
}

export function validateEvidenceAnchors(args: {
  evidence: DocumentIntelligenceV3ClaimEvidenceRow[];
  layout: CanonicalDocumentLayout | null | undefined;
  azureNative?: boolean;
}): AnchorValidationResult {
  const layout = args.layout ?? null;
  if (!layout || !Array.isArray(args.evidence) || args.evidence.length === 0) {
    return { sanitizedEvidence: args.evidence ?? [], findings: [] };
  }

  const pages = new Set((layout.pages ?? []).map((p) => p.page_number));
  const blocks = new Map<string, { pageNumber: number; polygon: number[] }>();
  for (const page of layout.pages ?? []) {
    for (const block of page.blocks ?? []) {
      blocks.set(block.block_id, { pageNumber: block.page_number, polygon: block.polygon ?? [] });
    }
  }

  const findings: AnchorValidationFinding[] = [];
  const sanitizedEvidence = args.evidence.map((row) => {
    const next = { ...row, block_ids: [...(row.block_ids ?? [])], polygon: [...(row.polygon ?? [])] };
    if (next.page != null && !pages.has(next.page)) {
      findings.push({
        code: "page_out_of_range",
        claimId: next.claim_id,
        pageNumber: next.page,
        severity: "material",
        message: `Evidence references page ${next.page}, which does not exist in the canonical layout.`,
      });
    }

    const retainedBlockIds: string[] = [];
    for (const blockId of next.block_ids ?? []) {
      const block = blocks.get(blockId);
      if (!block) {
        findings.push({
          code: "orphan_block_id",
          claimId: next.claim_id,
          blockId,
          pageNumber: next.page ?? null,
          severity: "material",
          message: `Evidence references unknown block_id ${blockId}.`,
        });
        continue;
      }
      retainedBlockIds.push(blockId);
      if (next.page != null && block.pageNumber !== next.page) {
        findings.push({
          code: "page_mismatch",
          claimId: next.claim_id,
          blockId,
          pageNumber: next.page,
          severity: "material",
          message: `Evidence page ${next.page} does not match block ${blockId} page ${block.pageNumber}.`,
        });
      }
      if (args.azureNative && !isValidPolygon(block.polygon)) {
        findings.push({
          code: "empty_polygon_on_azure_native",
          claimId: next.claim_id,
          blockId,
          pageNumber: block.pageNumber,
          severity: "warning",
          message: `Azure-native evidence block ${blockId} has no usable polygon.`,
        });
      }
    }
    next.block_ids = retainedBlockIds;

    if (next.polygon.length > 0 && !isValidPolygon(next.polygon)) {
      findings.push({
        code: "invalid_polygon_coordinates",
        claimId: next.claim_id,
        pageNumber: next.page ?? null,
        severity: "warning",
        message: "Evidence polygon is malformed or contains non-finite coordinates.",
      });
      next.polygon = [];
    }

    return next;
  });

  return { sanitizedEvidence, findings };
}