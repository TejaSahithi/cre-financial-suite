// @ts-nocheck

import type { DefinitionRecord, DefinitionResolution } from "./types.ts";
import { normalizeDefinedTerm } from "./definitions.ts";

function scopeRank(scopeType: string): number {
  switch (scopeType) {
    case "section": return 0;
    case "article": return 1;
    case "exhibit": return 2;
    case "schedule": return 3;
    case "amendment_only": return 4;
    case "document_family": return 5;
    case "document_global": return 6;
    default: return 9;
  }
}

export function resolveDefinedTermUsage(args: {
  term?: string | null;
  scopeKey?: string | null;
  sourceDocumentId?: string | null;
  definitions: DefinitionRecord[];
}): DefinitionResolution {
  const term = normalizeDefinedTerm(args.term ?? "");
  if (!term.normalized) return { term: "", definitionId: null, status: "not_applicable", scope: null, sourceDocumentId: args.sourceDocumentId ?? null, reasonCodes: ["empty_defined_term"] };
  const active = args.definitions.filter((definition) => definition.termNormalized === term.normalized && definition.definitionStatus !== "superseded");
  if (!active.length) return { term: term.display, definitionId: null, status: "unresolved", scope: null, sourceDocumentId: args.sourceDocumentId ?? null, reasonCodes: ["definition_not_found"] };
  const sameScope = active.filter((definition) => args.scopeKey && definition.scopeKey === args.scopeKey);
  const pool = sameScope.length ? sameScope : active;
  const conflicting = pool.filter((definition) => definition.definitionStatus === "conflicting");
  if (conflicting.length || pool.length > 1 && new Set(pool.map((definition) => definition.definitionText.toLowerCase())).size > 1) {
    return { term: term.display, definitionId: null, status: "ambiguous", scope: args.scopeKey ?? null, sourceDocumentId: args.sourceDocumentId ?? null, reasonCodes: ["multiple_active_definitions"] };
  }
  const selected = [...pool].sort((a, b) => scopeRank(a.scopeType) - scopeRank(b.scopeType))[0];
  return { term: term.display, definitionId: selected.id ?? null, status: selected.definitionStatus === "unresolved" ? "unresolved" : "resolved", scope: selected.scopeKey ?? selected.scopeType, sourceDocumentId: args.sourceDocumentId ?? null, reasonCodes: selected.definitionStatus === "unresolved" ? ["definition_reference_unresolved"] : [] };
}

export function resolveDefinedTermsInText(args: { text: string; definitions: DefinitionRecord[]; scopeKey?: string | null; sourceDocumentId?: string | null }): DefinitionResolution[] {
  const candidates = new Set<string>();
  for (const definition of args.definitions) {
    if (definition.termDisplay && new RegExp(`\\b${definition.termDisplay.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(args.text)) candidates.add(definition.termDisplay);
  }
  return [...candidates].map((term) => resolveDefinedTermUsage({ term, definitions: args.definitions, scopeKey: args.scopeKey, sourceDocumentId: args.sourceDocumentId }));
}