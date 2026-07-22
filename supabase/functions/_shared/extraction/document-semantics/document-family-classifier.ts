// @ts-nocheck

import type { DocumentFamilyClassification, DocumentFamilyMemberSummary, DocumentRole, SemanticBlockLike } from "./types.ts";

function textOf(input: { filename?: string | null; title?: string | null; blocks?: SemanticBlockLike[] }): string {
  return [input.title, ...(input.blocks ?? []).slice(0, 12).map((block) => block.text), input.filename]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

function bodyTextOf(input: { title?: string | null; blocks?: SemanticBlockLike[] }): string {
  return [input.title, ...(input.blocks ?? []).slice(0, 12).map((block) => block.text)]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}
function firstDate(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return normalizeDate(match[1]);
  }
  return null;
}

function normalizeDate(value: string): string | null {
  const raw = String(value ?? "").trim();
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const year = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
    return `${year.padStart(4, "0")}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  }
  return null;
}

function detectRole(text: string, filenameText: string): { role: DocumentRole; reasonCodes: string[] } {
  const body = text.toLowerCase();
  const filename = filenameText.toLowerCase();
  const reasons: string[] = [];
  if (/\b(first|second|third|fourth|fifth)?\s*amendment\b/.test(body)) return { role: "amendment", reasonCodes: ["explicit_amendment_language"] };
  if (/\baddendum\b/.test(body)) return { role: "addendum", reasonCodes: ["explicit_addendum_language"] };
  if (/commencement certificate/.test(body)) return { role: "commencement_certificate", reasonCodes: ["explicit_commencement_certificate_language"] };
  if (/\bestoppel\b/.test(body)) return { role: "estoppel", reasonCodes: ["explicit_estoppel_language"] };
  if (/\bassignment\b/.test(body)) return { role: "assignment", reasonCodes: ["explicit_assignment_language"] };
  if (/\bguaranty\b|\bguarantee\b/.test(body)) return { role: "guaranty", reasonCodes: ["explicit_guaranty_language"] };
  if (/\bexhibit\b/.test(body) && !/lease agreement/.test(body)) return { role: "exhibit", reasonCodes: ["explicit_exhibit_language"] };
  if (/\bschedule\b/.test(body) && !/lease agreement/.test(body)) return { role: "schedule", reasonCodes: ["explicit_schedule_language"] };
  if (/\blease agreement\b|\blandlord\b.*\btenant\b|\bdemise\b/.test(body)) return { role: "base_lease", reasonCodes: ["base_lease_clause_language"] };
  if (/amendment|addendum|lease/.test(filename)) reasons.push("filename_only_signal_rejected");
  return { role: "unknown", reasonCodes: reasons.length ? reasons : ["insufficient_role_signals"] };
}

function sequenceNumber(text: string): number | null {
  const explicit = text.match(/\b(?:amendment\s+no\.?|no\.)\s*(\d+)\b/i)?.[1];
  if (explicit) return Number(explicit);
  if (/\bfirst amendment\b/i.test(text)) return 1;
  if (/\bsecond amendment\b/i.test(text)) return 2;
  if (/\bthird amendment\b/i.test(text)) return 3;
  if (/\bfourth amendment\b/i.test(text)) return 4;
  return null;
}

export function classifyDocumentFamily(args: {
  filename?: string | null;
  title?: string | null;
  blocks?: SemanticBlockLike[];
  existingMembers?: DocumentFamilyMemberSummary[];
  candidateFamilyIds?: string[];
  partyOverlap?: number | null;
  premisesOverlap?: number | null;
  propertyMatch?: boolean | null;
}): DocumentFamilyClassification {
  const text = bodyTextOf(args);
  const filename = String(args.filename ?? "");
  const role = detectRole(text, filename);
  const referencedBaseLeaseDate = firstDate(text, [/lease\s+dated\s+([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i]);
  const effectiveDate = firstDate(text, [/effective\s+(?:as\s+of\s+)?(?:date\s+)?([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i]);
  const executionDate = firstDate(text, [/(?:executed|made|entered\s+into)\s+(?:as\s+of\s+)?([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i]);
  const reasons = [...role.reasonCodes];
  let confidence = role.role === "unknown" ? 0.25 : 0.6;
  if (referencedBaseLeaseDate) { confidence += 0.12; reasons.push("referenced_base_lease_date"); }
  if ((args.partyOverlap ?? 0) >= 0.5) { confidence += 0.1; reasons.push("party_overlap"); }
  if ((args.premisesOverlap ?? 0) >= 0.5) { confidence += 0.1; reasons.push("premises_overlap"); }
  if (args.propertyMatch) { confidence += 0.08; reasons.push("property_match"); }
  if ((args.candidateFamilyIds ?? []).length > 1) { confidence = Math.min(confidence, 0.62); reasons.push("ambiguous_family_candidates"); }
  if (role.reasonCodes.includes("filename_only_signal_rejected")) confidence = Math.min(confidence, 0.3);
  return {
    documentRole: role.role,
    referencedBaseLeaseDate,
    effectiveDate,
    executionDate,
    sequenceNumber: sequenceNumber(text),
    candidateFamilyIds: args.candidateFamilyIds ?? [],
    confidence: Math.round(Math.min(confidence, 0.95) * 100) / 100,
    reasonCodes: [...new Set(reasons)],
  };
}