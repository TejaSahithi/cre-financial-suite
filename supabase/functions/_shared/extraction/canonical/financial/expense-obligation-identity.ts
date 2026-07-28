// @ts-nocheck
/**
 * Deterministic identity hashing for the canonical expense-obligation layer
 * (Phase 6A, correction D) -- obligationId is reproducible (same input
 * twice -> same id) and generation-scoped, never crypto.randomUUID().
 *
 * stableHash() reuses canary-gate.ts's exact FNV-1a loop (same algorithm,
 * already established in this codebase) but outputs a hex digest rather
 * than a [0,1) sample-rate float, since this is an identity/grouping key,
 * not a sampling decision. Non-cryptographic, 32-bit -- adequate for
 * shadow-diagnostics identity (dedup grouping, obligationId), not intended
 * as a security control or a collision-proof primary key.
 */

/** Recursively sorts object keys before JSON.stringify so two objects with
 *  the same content but different construction/property order hash
 *  identically. Array element order is preserved (semantically meaningful). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function stableHash(value: unknown): string {
  return fnv1aHex(stableStringify(value));
}

export function buildObligationId(args: {
  organizationId: string;
  fileId: string;
  generationId: string;
  specialistDomain: string;
  sourceSchemaVersion: string;
  sourceObligationIndex: number;
  sourcePage: number | null;
  sourceQuote: string | null;
}): string {
  return stableHash({
    organizationId: args.organizationId,
    fileId: args.fileId,
    generationId: args.generationId,
    specialistDomain: args.specialistDomain,
    sourceSchemaVersion: args.sourceSchemaVersion,
    sourceObligationIndex: args.sourceObligationIndex,
    evidence: { sourcePage: args.sourcePage, sourceQuote: args.sourceQuote },
  });
}
