// @ts-nocheck

import {
  DOCUMENT_SEMANTICS_ALGORITHM_VERSION,
  DOCUMENT_SEMANTICS_SCHEMA_VERSION,
  type DefinitionRecord,
  type DefinitionScopeType,
  type NormalizedDefinedTerm,
  type SemanticBlockLike,
  semanticId,
} from "./types.ts";

const DEFINITION_PATTERNS = [
  /["'\u201c\u201d]([^"'\u201c\u201d]{2,80})["'\u201c\u201d]\s+(?:means|shall mean|shall have the meaning|means and refers to)\s+([^.;]+(?:\.[^\n]*)?)/gi,
  /(?:the\s+term\s+)?([A-Z][A-Za-z0-9\- ]{2,80})\s+(?:means|shall mean)\s+([^.;]+(?:\.[^\n]*)?)/g,
  /([A-Z][A-Za-z0-9\- ]{2,80})\s+has\s+the\s+meaning\s+(?:given|set\s+forth)\s+in\s+(Section\s+[0-9A-Za-z.\-]+)/g,
];

const QUOTE_CHARS = /[\u2018\u2019\u201c\u201d"']/g;
const MATERIAL_WS = /\s+/g;

export function normalizeDefinedTerm(term: unknown): NormalizedDefinedTerm {
  const display = String(term ?? "")
    .replace(QUOTE_CHARS, "")
    .replace(/[,:;.]+$/g, "")
    .replace(MATERIAL_WS, " ")
    .trim();
  let normalized = display
    .toLowerCase()
    .replace(/\bthe\s+/g, "")
    .replace(/[,:;.]+$/g, "")
    .replace(/'s\b/g, "")
    .replace(MATERIAL_WS, " ")
    .trim();
  if (normalized.endsWith("s") && /\b(term|year|month|day|section|article|exhibit|schedule)s$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return { display, normalized };
}

function scopeFor(block: SemanticBlockLike, text: string): { scopeType: DefinitionScopeType; scopeKey: string | null } {
  const section = text.match(/\bSection\s+([0-9A-Za-z.\-]+)/i)?.[1] ?? block.sectionKey ?? null;
  const article = text.match(/\bArticle\s+([IVXLC0-9A-Za-z.\-]+)/i)?.[1] ?? null;
  const exhibit = text.match(/\bExhibit\s+([A-Z0-9.\-]+)/i)?.[1] ?? null;
  const schedule = text.match(/\bSchedule\s+([A-Z0-9.\-]+)/i)?.[1] ?? null;
  if (/\bamendment\b/i.test(text)) return { scopeType: "amendment_only", scopeKey: section };
  if (exhibit) return { scopeType: "exhibit", scopeKey: exhibit };
  if (schedule) return { scopeType: "schedule", scopeKey: schedule };
  if (section) return { scopeType: "section", scopeKey: section };
  if (article) return { scopeType: "article", scopeKey: article };
  return { scopeType: "document_global", scopeKey: null };
}

function normalizeDefinitionText(text: unknown): string {
  return String(text ?? "").replace(MATERIAL_WS, " ").trim().replace(/[.;]+$/g, "");
}

function materiallyEquivalent(a: string, b: string): boolean {
  const left = normalizeDefinitionText(a).toLowerCase();
  const right = normalizeDefinitionText(b).toLowerCase();
  if (left === right) return true;
  if (!left || !right) return false;
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  return shorter.length >= 24 && longer.includes(shorter);
}

export function detectDefinitionCandidates(blocks: SemanticBlockLike[]): DefinitionRecord[] {
  const candidates: DefinitionRecord[] = [];
  for (const block of blocks) {
    const text = String(block?.text ?? "").replace(MATERIAL_WS, " ").trim();
    if (!text) continue;
    for (const pattern of DEFINITION_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const term = normalizeDefinedTerm(match[1]);
        if (!term.normalized || term.normalized.length < 2) continue;
        const definitionText = normalizeDefinitionText(match[2] ?? match[0]);
        const scope = scopeFor(block, text);
        candidates.push({
          id: semanticId("definition", [block.blockId, term.normalized, definitionText]),
          termNormalized: term.normalized,
          termDisplay: term.display,
          definitionText,
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
          sourceBlockIds: [block.blockId].filter(Boolean),
          sourcePageNumbers: typeof block.pageNumber === "number" ? [block.pageNumber] : [],
          evidenceIds: [],
          definitionStatus: "resolved",
          confidence: definitionText ? 0.86 : 0.55,
          schemaVersion: DOCUMENT_SEMANTICS_SCHEMA_VERSION,
          algorithmVersion: DOCUMENT_SEMANTICS_ALGORITHM_VERSION,
        });
      }
    }
  }
  return resolveDuplicateDefinitions(candidates);
}

export function resolveDuplicateDefinitions(records: DefinitionRecord[]): DefinitionRecord[] {
  const grouped = new Map<string, DefinitionRecord[]>();
  for (const record of records) {
    const key = [record.termNormalized, record.scopeType, record.scopeKey ?? ""].join("|");
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  const resolved: DefinitionRecord[] = [];
  for (const group of grouped.values()) {
    if (group.length === 1) {
      resolved.push(group[0]);
      continue;
    }
    const first = group[0];
    const equivalent = group.every((record) => materiallyEquivalent(first.definitionText, record.definitionText));
    if (equivalent) {
      resolved.push({
        ...first,
        sourceBlockIds: [...new Set(group.flatMap((record) => record.sourceBlockIds))],
        sourcePageNumbers: [...new Set(group.flatMap((record) => record.sourcePageNumbers))],
        confidence: Math.max(...group.map((record) => record.confidence ?? 0.7)),
      });
    } else {
      resolved.push(...group.map((record) => ({ ...record, definitionStatus: "conflicting" as const, confidence: Math.min(record.confidence ?? 0.6, 0.64), evidenceIds: record.evidenceIds ?? [] })));
    }
  }
  return resolved.sort((a, b) => a.termNormalized.localeCompare(b.termNormalized) || String(a.scopeKey ?? "").localeCompare(String(b.scopeKey ?? "")) || a.definitionText.localeCompare(b.definitionText));
}

export function detectAsDefinedInReferences(blocks: SemanticBlockLike[], definitions: DefinitionRecord[]): DefinitionRecord[] {
  const existing = new Set(definitions.map((definition) => `${definition.termNormalized}|${definition.scopeType}|${definition.scopeKey ?? ""}`));
  const unresolved: DefinitionRecord[] = [];
  for (const block of blocks) {
    const text = String(block?.text ?? "");
    for (const match of text.matchAll(/(?:["'\u201c\u201d]([^"'\u201c\u201d]{2,80})["'\u201c\u201d]|\b([A-Z][A-Za-z0-9\- ]{2,80}))\s+as\s+defined\s+in\s+(Section\s+[0-9A-Za-z.\-]+)/g)) {
      const term = normalizeDefinedTerm(match[1] ?? match[2]);
      const section = match[3]?.replace(/^Section\s+/i, "") ?? null;
      const key = `${term.normalized}|section|${section ?? ""}`;
      if (existing.has(key)) continue;
      unresolved.push({
        id: semanticId("definition-unresolved", [block.blockId, term.normalized, section]),
        termNormalized: term.normalized,
        termDisplay: term.display,
        definitionText: match[0],
        scopeType: "section",
        scopeKey: section,
        sourceBlockIds: [block.blockId].filter(Boolean),
        sourcePageNumbers: typeof block.pageNumber === "number" ? [block.pageNumber] : [],
        evidenceIds: [],
        definitionStatus: "unresolved",
        confidence: 0.5,
        schemaVersion: DOCUMENT_SEMANTICS_SCHEMA_VERSION,
        algorithmVersion: DOCUMENT_SEMANTICS_ALGORITHM_VERSION,
      });
    }
  }
  return unresolved;
}

export function buildDefinitionRecords(blocks: SemanticBlockLike[]): DefinitionRecord[] {
  const detected = detectDefinitionCandidates(blocks);
  return [...detected, ...detectAsDefinedInReferences(blocks, detected)];
}

export async function persistDefinitionRecords(args: { supabaseAdmin: any; orgId: string; uploadedFileId: string; runId: string; generationId: string; definitions: DefinitionRecord[] }) {
  if (!args.definitions.length) return { count: 0, error: null };
  const rows = args.definitions.map((definition) => ({
    organization_id: args.orgId,
    uploaded_file_id: args.uploadedFileId,
    run_id: args.runId,
    generation_id: args.generationId,
    term_normalized: definition.termNormalized,
    term_display: definition.termDisplay,
    definition_text: definition.definitionText,
    scope_type: definition.scopeType,
    scope_key: definition.scopeKey,
    source_block_ids: definition.sourceBlockIds,
    source_page_numbers: definition.sourcePageNumbers,
    evidence_ids: definition.evidenceIds,
    definition_status: definition.definitionStatus,
    confidence: definition.confidence,
    schema_version: definition.schemaVersion,
    algorithm_version: definition.algorithmVersion,
  }));
  await args.supabaseAdmin.from("document_definitions")
    .delete()
    .eq("organization_id", args.orgId)
    .eq("uploaded_file_id", args.uploadedFileId)
    .eq("run_id", args.runId)
    .eq("generation_id", args.generationId);
  const { error } = await args.supabaseAdmin.from("document_definitions").insert(rows);
  return { count: error ? 0 : rows.length, error: error?.message ?? null };
}