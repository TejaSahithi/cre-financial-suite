// @ts-nocheck
/**
 * evidence-key.ts — P2.4.
 *
 * Evidence identity is deliberately separate from claim identity (P2.1
 * correction #4): file + run + page/span + source_text_hash + block/cell
 * identity. Two claims can share one evidence row; the same evidence
 * content submitted twice (e.g. a retried adapter run) must resolve to the
 * SAME evidence_key so persist_lease_claim_ledger_batch's
 * UNIQUE(org_id, evidence_key) dedup is effective, not a new row each time.
 */

export interface EvidenceKeyInput {
  uploadedFileId: string;
  extractionRunId: string;
  pageStart: number;
  pageEnd?: number | null;
  spanStart?: number | null;
  spanEnd?: number | null;
  sourceTextHash?: string | null;
  blockIds?: string[] | null;
}

function part(value: unknown): string {
  return value === null || value === undefined ? "-" : String(value);
}

export function buildEvidenceKey(input: EvidenceKeyInput): string {
  const blockPart = input.blockIds && input.blockIds.length > 0 ? input.blockIds.join(",") : "-";
  return [
    input.uploadedFileId,
    input.extractionRunId,
    part(input.pageStart),
    part(input.pageEnd),
    part(input.spanStart),
    part(input.spanEnd),
    part(input.sourceTextHash),
    blockPart,
  ].join("|");
}

/** SHA-256 hex digest of source text, for source_text_hash -- never store
 *  raw source text as part of the key itself (keys may end up in logs/URLs
 *  more casually than the evidence row's own protected source_text column). */
export async function hashSourceText(sourceText: string | null | undefined): Promise<string | null> {
  if (!sourceText) return null;
  const bytes = new TextEncoder().encode(sourceText);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
