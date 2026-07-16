// @ts-nocheck
/**
 * Vertex Fact Ledger — Document Profile Classifier
 *
 * One callVertexAIJSON() call over the document's head/tail excerpt,
 * text-only (never file-mode — file-mode is reserved for fact-ledger-extractor.ts
 * and only under the explicit VERTEX_FACT_LEDGER_FILE_MODE opt-in flag).
 *
 * Falls back to the existing regex-based detectDocumentProfileSignals() /
 * detectDocumentProfile() (lease-workflow.ts) on any classifier failure —
 * those functions are additive-exported (no behavior change) specifically
 * so this fallback has something real to call instead of reimplementing
 * profile-detection heuristics a second time.
 */

import { callVertexAIJSON } from "../../vertex-ai.ts";
import { detectDocumentProfileSignals } from "../lease-workflow.ts";
import type { CanonicalDocumentIndex, DocumentProfile, DocumentProfileClassification } from "./types.ts";

const VALID_PROFILES: DocumentProfile[] = [
  "full_lease",
  "assignment",
  "amendment",
  "assignment_amendment",
  "abstract",
  "addendum",
  "exhibit",
];

const SYSTEM_PROMPT = `You are a commercial real estate document classifier.
Classify the document into EXACTLY ONE of these profiles:
  full_lease           — a complete, standalone lease agreement
  assignment            — assigns the tenant's interest to a new party, no amendment terms
  amendment             — modifies terms of an existing lease, not an assignment
  assignment_amendment  — both assigns AND amends in the same document
  abstract              — a lease abstract/summary document, not the lease itself
  addendum              — a short addendum attached to a lease
  exhibit                — an exhibit/attachment (e.g. floor plan, rules), not lease terms itself

Output ONLY valid JSON of this exact shape:
  { "document_profile": "<one of the profiles above>", "confidence": <0.0-1.0>, "reasoning": "<one short sentence>" }
If uncertain, use "full_lease" with a lower confidence rather than inventing a new category.`;

function regexFallback(
  docIndex: CanonicalDocumentIndex,
  documentSubtype?: string | null,
): DocumentProfileClassification {
  const signals = detectDocumentProfileSignals(docIndex.fullText, documentSubtype ?? null);
  return {
    documentProfile: (signals.selected_document_profile as DocumentProfile) || "full_lease",
    confidence: signals.strong_full_lease_signals ? 0.7 : 0.5,
    method: "regex_fallback",
    reasoning: null,
  };
}

function coerceProfile(value: unknown): DocumentProfile | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (VALID_PROFILES as string[]).includes(normalized) ? (normalized as DocumentProfile) : null;
}

/**
 * Classify a document's profile. Never throws — degrades to the regex
 * fallback on any Vertex failure, malformed response, or invalid profile.
 */
export async function classifyDocumentProfile(args: {
  docIndex: CanonicalDocumentIndex;
  documentSubtype?: string | null;
}): Promise<DocumentProfileClassification> {
  const { docIndex, documentSubtype } = args;

  if (!docIndex.fullText || docIndex.fullText.trim().length < 10) {
    return regexFallback(docIndex, documentSubtype);
  }

  try {
    const result = await callVertexAIJSON<{
      document_profile?: string;
      confidence?: number;
      reasoning?: string;
    }>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: `Document subtype hint (may be inaccurate): ${documentSubtype || "unknown"}\n\nDocument text:\n${docIndex.headTailExcerpt}`,
      temperature: 0,
    });

    const profile = coerceProfile(result?.document_profile);
    if (!profile) {
      return regexFallback(docIndex, documentSubtype);
    }

    const confidence = Number(result?.confidence);
    return {
      documentProfile: profile,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.6,
      method: "vertex",
      reasoning: result?.reasoning ?? null,
    };
  } catch {
    return regexFallback(docIndex, documentSubtype);
  }
}
