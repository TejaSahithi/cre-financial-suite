// @ts-nocheck
/**
 * Section-Aware Candidate Router.
 *
 * Deterministically routes Azure Layout output (headings, paragraph roles,
 * table headers, layout position, neighboring content) into named lease
 * sections/domains. This is a ROUTING layer only — it limits which
 * candidates compete for which fields (see domain-readiness.ts and
 * deterministic-candidates.ts), it never assigns a final field value itself.
 * A repair clause routed to "repairs" can still produce a repair/maintenance
 * fact; it must not thereby win a utility-payment field unless the text
 * itself contains an explicit payment obligation (that distinction is
 * enforced downstream by semantic-compatibility.ts's responsibilityRole
 * check, not here).
 *
 * Operates directly on AzureDocumentOutput (aka DoclingOutput) — the one
 * document representation already flowing through the entire active
 * pipeline (parser.ts -> azure-layout-adapter.ts -> every extraction step).
 * This deliberately does NOT introduce a second document graph alongside the
 * dormant document-intelligence-v3 canonical layout; it reuses the same
 * text_blocks/tables/fields shape rule-extractor.ts, chunker.ts, and
 * fact-ledger-extractor.ts already consume.
 */

import type { DoclingOutput, DoclingTextBlock } from "./types.ts";

export type SectionDomain =
  | "parties"
  | "premises"
  | "term"
  | "base_rent"
  | "rent_schedule"
  | "additional_rent"
  | "expense_recovery"
  | "cam"
  | "taxes"
  | "insurance"
  | "utilities"
  | "repairs"
  | "options"
  | "defaults"
  | "signatures"
  | "guaranty"
  | "amendment"
  | "other";

/** The 5 bounded domains that receive at most ONE Azure OpenAI call each
 *  (see domain-readiness.ts / adaptive-extractor.ts). Every SectionDomain
 *  above maps to exactly one of these (or null, for "other", which never by
 *  itself triggers an LLM call). */
export const LLM_CALL_DOMAINS = [
  "core_terms",
  "rent_and_charges",
  "expenses_and_cam",
  "operating_obligations",
  "legal_rights_and_dates",
] as const;
export type LlmCallDomain = typeof LLM_CALL_DOMAINS[number];

export const SECTION_DOMAIN_TO_LLM_CALL_DOMAIN: Record<SectionDomain, LlmCallDomain | null> = {
  parties: "core_terms",
  premises: "core_terms",
  term: "core_terms",
  signatures: "core_terms",
  base_rent: "rent_and_charges",
  rent_schedule: "rent_and_charges",
  additional_rent: "rent_and_charges",
  expense_recovery: "expenses_and_cam",
  cam: "expenses_and_cam",
  taxes: "expenses_and_cam",
  insurance: "expenses_and_cam",
  utilities: "expenses_and_cam",
  repairs: "operating_obligations",
  options: "legal_rights_and_dates",
  defaults: "legal_rights_and_dates",
  guaranty: "legal_rights_and_dates",
  amendment: "legal_rights_and_dates",
  other: null,
};

/** Maps each SectionDomain to the closest existing clause-category (the same
 *  34-entry CLAUSE_DEFINITIONS vocabulary lease-workflow.ts and
 *  fact-ledger-extractor.ts already use) so deterministic candidates
 *  (deterministic-candidates.ts) and LLM-produced facts carry directly
 *  comparable `category` values into fact-field-mapper.ts's existing
 *  scoring/semantic-compatibility gates -- no new category vocabulary. */
export const SECTION_DOMAIN_CLAUSE_CATEGORY: Record<SectionDomain, string> = {
  parties: "clause:party_identification",
  premises: "clause:premises_description",
  term: "clause:lease_term",
  base_rent: "clause:rent_escalation",
  rent_schedule: "clause:rent_escalation",
  additional_rent: "clause:operating_expense_recovery",
  expense_recovery: "clause:operating_expense_recovery",
  cam: "clause:cam_recoveries",
  taxes: "clause:taxes",
  insurance: "clause:insurance",
  utilities: "clause:operating_expense_recovery",
  repairs: "clause:repairs_maintenance",
  options: "clause:renewal_option",
  defaults: "clause:defaults_remedies",
  signatures: "clause:default",
  guaranty: "clause:guaranty",
  amendment: "clause:default",
  other: "clause:default",
};

interface DomainPattern {
  domain: SectionDomain;
  pattern: RegExp;
  weight: number;
}

// Generalized keyword/heading patterns per domain -- no document names, no
// landlord/tenant names, no page numbers, no literal sentences. Each domain
// mixes a HEADING-shaped signal (higher weight -- section titles are the
// strongest routing signal) with body-language signals (lower weight).
const DOMAIN_PATTERNS: DomainPattern[] = [
  { domain: "parties", pattern: /\b(?:parties|landlord\s+and\s+tenant|lessor\s+and\s+lessee)\b/i, weight: 3 },
  { domain: "parties", pattern: /\bby\s+and\s+between\b|\bherein\s+called\b|\breferred\s+to\s+as\b/i, weight: 2 },
  { domain: "premises", pattern: /\bpremises\b|\bdemised\s+premises\b|\brentable\s+(?:square\s+feet|area)\b/i, weight: 3 },
  { domain: "premises", pattern: /\bsuite\b|\bunit\s+number\b|\bsquare\s+footage\b/i, weight: 2 },
  { domain: "term", pattern: /\bterm\s+of\s+(?:the\s+)?lease\b|\blease\s+term\b|\bcommencement\s+date\b|\bexpiration\s+date\b/i, weight: 3 },
  { domain: "term", pattern: /\bcommence[sd]?\b|\bexpire[sd]?\b/i, weight: 1 },
  { domain: "base_rent", pattern: /\bbase\s+rent\b|\bminimum\s+rent\b|\bmonthly\s+rent\b/i, weight: 3 },
  { domain: "rent_schedule", pattern: /\brent\s+schedule\b|\bstepped\s+rent\b|\brent\s+increases?\b/i, weight: 3 },
  { domain: "additional_rent", pattern: /\badditional\s+rent\b/i, weight: 3 },
  { domain: "expense_recovery", pattern: /\boperating\s+expenses?\b|\bexpense\s+recover(?:y|ies)\b|\bpass[\s-]?through\b/i, weight: 3 },
  { domain: "cam", pattern: /\bcommon\s+area\s+maintenance\b|\bcam\b/i, weight: 3 },
  { domain: "taxes", pattern: /\breal\s+estate\s+tax(?:es)?\b|\bproperty\s+tax(?:es)?\b|\bad\s+valorem\b/i, weight: 3 },
  { domain: "insurance", pattern: /\binsurance\b|\bpolicy\b|\bcertificate\s+of\s+insurance\b|\bliability\s+coverage\b/i, weight: 3 },
  { domain: "utilities", pattern: /\butilit(?:y|ies)\b|\belectric(?:ity|al)?\s+service\b|\bwater\s+(?:and\s+)?sewer\b/i, weight: 3 },
  { domain: "repairs", pattern: /\brepairs?\s+and\s+maintenance\b|\bmaintenance\s+and\s+repairs?\b|\bhvac\b|\bstructural\s+repairs?\b/i, weight: 3 },
  { domain: "options", pattern: /\brenewal\s+options?\b|\boption\s+to\s+renew\b|\bright\s+of\s+first\s+(?:refusal|offer)\b/i, weight: 3 },
  { domain: "defaults", pattern: /\bevent(?:s)?\s+of\s+default\b|\bdefault\s+and\s+remedies\b|\bremedies\b/i, weight: 3 },
  { domain: "signatures", pattern: /\bin\s+witness\s+whereof\b|\bsignature\s+page\b|\bexecuted\s+this\b/i, weight: 3 },
  { domain: "guaranty", pattern: /\bguaranty\b|\bguarantor\b/i, weight: 3 },
  { domain: "amendment", pattern: /\bamendment\b|\baddendum\b|\bmodification\s+to\s+lease\b/i, weight: 3 },
];

function isHeadingShaped(block: DoclingTextBlock): boolean {
  const text = String(block.text ?? "").trim();
  if (!text || text.length > 90) return false;
  if (String(block.type ?? "").toLowerCase() === "heading") return true;
  // Numbered heading ("1. Premises", "Section 4.2 Rent") or an ALL-CAPS
  // short line -- both are common lease section-title shapes Azure Layout's
  // paragraph role doesn't always label as "heading" for scanned documents.
  if (/^(?:section\s+)?(?:[0-9]+[.)]\s*){1,3}[A-Za-z]/i.test(text)) return true;
  if (text === text.toUpperCase() && /[A-Z]{3,}/.test(text)) return true;
  return false;
}

function scoreBlockDomains(text: string): Partial<Record<SectionDomain, number>> {
  const scores: Partial<Record<SectionDomain, number>> = {};
  for (const { domain, pattern, weight } of DOMAIN_PATTERNS) {
    if (pattern.test(text)) scores[domain] = (scores[domain] ?? 0) + weight;
  }
  return scores;
}

function topDomain(scores: Partial<Record<SectionDomain, number>>): SectionDomain | null {
  let best: SectionDomain | null = null;
  let bestScore = 0;
  for (const [domain, score] of Object.entries(scores) as Array<[SectionDomain, number]>) {
    if (score > bestScore) {
      bestScore = score;
      best = domain;
    }
  }
  return best;
}

export interface RoutedBlock {
  blockIndex: number;
  page: number | null;
  type: string;
  text: string;
  domainScores: Partial<Record<SectionDomain, number>>;
  primaryDomain: SectionDomain;
  /** The nearest preceding heading's own text, if any -- carried along so
   *  evidence packages (adaptive-extractor.ts) can include heading context
   *  even when a body block's own text has no domain keyword of its own. */
  headingContext: string | null;
}

export interface SectionRoutingResult {
  blocks: RoutedBlock[];
  byDomain: Record<SectionDomain, RoutedBlock[]>;
  byLlmCallDomain: Record<LlmCallDomain, RoutedBlock[]>;
}

/**
 * Route every text block in an Azure-parsed document into a SectionDomain.
 * A block may score for multiple domains (domainScores); primaryDomain is
 * the highest-scoring one, defaulting to "other" when nothing matches.
 * Neighboring content inherits the nearest preceding heading's domain at a
 * lower weight than a direct keyword match in the block's own text, so an
 * unrelated aside under a "Repairs" heading doesn't automatically outrank a
 * body sentence that explicitly discusses a different topic.
 */
export function routeSections(docling: DoclingOutput): SectionRoutingResult {
  const blocks = Array.isArray(docling?.text_blocks) ? docling.text_blocks : [];
  let currentHeadingDomain: SectionDomain | null = null;
  let currentHeadingText: string | null = null;

  const routed: RoutedBlock[] = blocks.map((block) => {
    const text = String(block?.text ?? "");
    const scores = scoreBlockDomains(text);
    const headingShaped = isHeadingShaped(block);

    if (headingShaped) {
      const headingDomain = topDomain(scores);
      if (headingDomain) {
        currentHeadingDomain = headingDomain;
        currentHeadingText = text.trim();
      }
    } else if (currentHeadingDomain) {
      // Inherited-heading boost is weaker (1) than a direct in-block keyword
      // match (2-3 above) so an off-topic body sentence under a matching
      // heading doesn't beat a body sentence that names its own domain.
      scores[currentHeadingDomain] = (scores[currentHeadingDomain] ?? 0) + 1;
    }

    const primaryDomain = topDomain(scores) ?? "other";
    return {
      blockIndex: typeof block?.block_index === "number" ? block.block_index : -1,
      page: typeof block?.page === "number" ? block.page : null,
      type: String(block?.type ?? "paragraph"),
      text,
      domainScores: scores,
      primaryDomain,
      headingContext: currentHeadingText,
    };
  });

  const byDomain = {} as Record<SectionDomain, RoutedBlock[]>;
  const byLlmCallDomain = {} as Record<LlmCallDomain, RoutedBlock[]>;
  for (const block of routed) {
    (byDomain[block.primaryDomain] ??= []).push(block);
    const llmDomain = SECTION_DOMAIN_TO_LLM_CALL_DOMAIN[block.primaryDomain];
    if (llmDomain) (byLlmCallDomain[llmDomain] ??= []).push(block);
  }

  return { blocks: routed, byDomain, byLlmCallDomain };
}
