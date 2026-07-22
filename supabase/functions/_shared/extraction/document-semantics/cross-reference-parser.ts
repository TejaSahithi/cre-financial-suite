// @ts-nocheck

import {
  DOCUMENT_SEMANTICS_ALGORITHM_VERSION,
  DOCUMENT_SEMANTICS_SCHEMA_VERSION,
  type CrossReferenceRecord,
  type CrossReferenceType,
  type SemanticBlockLike,
  semanticId,
} from "./types.ts";

const EXPLICIT_PATTERNS: Array<{ type: CrossReferenceType; regex: RegExp }> = [
  { type: "section", regex: /\bSection\s+([0-9A-Za-z.\-]+)/gi },
  { type: "article", regex: /\bArticle\s+([IVXLC0-9A-Za-z.\-]+)/gi },
  { type: "exhibit", regex: /\bExhibit\s+([A-Z0-9.\-]+)/gi },
  { type: "schedule", regex: /\bSchedule\s+([A-Z0-9.\-]+)/gi },
  { type: "amendment", regex: /\b(?:this\s+)?(Amendment|First Amendment|Second Amendment|Third Amendment)\b/gi },
  { type: "document", regex: /\b(the\s+Lease|this\s+Lease|this\s+Amendment)\b/gi },
  { type: "date_clause", regex: /\b(Commencement Date|Expiration Date|Rent Commencement Date)\b/gi },
  { type: "rent_clause", regex: /\b(Base Rent|Minimum Rent|Additional Rent)\b/gi },
  { type: "option_clause", regex: /\b(Renewal Option|Extension Option|Purchase Option)\b/gi },
];

const RELATIVE_PATTERN = /\b(as\s+set\s+forth\s+above|as\s+provided\s+below|the\s+foregoing|the\s+following)\b/gi;
const QUOTED_TERM_PATTERN = /["'\u201c\u201d]([^"'\u201c\u201d]{2,80})["'\u201c\u201d]/g;

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function parseCrossReferences(blocks: SemanticBlockLike[]): CrossReferenceRecord[] {
  const refs: CrossReferenceRecord[] = [];
  for (const block of blocks) {
    const text = clean(block.text);
    if (!text) continue;
    for (const pattern of EXPLICIT_PATTERNS) {
      pattern.regex.lastIndex = 0;
      for (const match of text.matchAll(pattern.regex)) {
        const label = clean(match[0]);
        refs.push({
          id: semanticId("xref", [block.blockId, pattern.type, label, match.index ?? 0]),
          sourceBlockId: block.blockId,
          sourceText: label,
          referenceType: pattern.type,
          targetLabel: label,
          targetDocumentId: null,
          targetBlockId: null,
          targetSectionKey: pattern.type === "section" ? clean(match[1]) : null,
          targetDefinitionId: null,
          resolutionStatus: "unresolved",
          confidence: 0.62,
          reasonCodes: ["reference_detected_unresolved"],
          schemaVersion: DOCUMENT_SEMANTICS_SCHEMA_VERSION,
          algorithmVersion: DOCUMENT_SEMANTICS_ALGORITHM_VERSION,
        });
      }
    }
    RELATIVE_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(RELATIVE_PATTERN)) {
      refs.push({
        id: semanticId("xref", [block.blockId, "relative", match[0], match.index ?? 0]),
        sourceBlockId: block.blockId,
        sourceText: clean(match[0]),
        referenceType: "other",
        targetLabel: clean(match[0]),
        targetDocumentId: null,
        targetBlockId: null,
        targetSectionKey: null,
        targetDefinitionId: null,
        resolutionStatus: "unresolved",
        confidence: 0.35,
        reasonCodes: ["relative_reference_requires_review"],
        schemaVersion: DOCUMENT_SEMANTICS_SCHEMA_VERSION,
        algorithmVersion: DOCUMENT_SEMANTICS_ALGORITHM_VERSION,
      });
    }
    QUOTED_TERM_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(QUOTED_TERM_PATTERN)) {
      if (/means|shall mean/i.test(text)) continue;
      refs.push({
        id: semanticId("xref", [block.blockId, "defined_term", match[1], match.index ?? 0]),
        sourceBlockId: block.blockId,
        sourceText: clean(match[0]),
        referenceType: "defined_term",
        targetLabel: clean(match[1]),
        targetDocumentId: null,
        targetBlockId: null,
        targetSectionKey: null,
        targetDefinitionId: null,
        resolutionStatus: "unresolved",
        confidence: 0.5,
        reasonCodes: ["defined_term_reference_detected"],
        schemaVersion: DOCUMENT_SEMANTICS_SCHEMA_VERSION,
        algorithmVersion: DOCUMENT_SEMANTICS_ALGORITHM_VERSION,
      });
    }
  }
  return dedupeReferences(refs);
}

function dedupeReferences(refs: CrossReferenceRecord[]): CrossReferenceRecord[] {
  const seen = new Set<string>();
  const out: CrossReferenceRecord[] = [];
  for (const ref of refs) {
    const key = [ref.sourceBlockId, ref.referenceType, ref.targetLabel.toLowerCase()].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}