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
import { getEnabledDomainIdsInOrder, DOMAIN_REGISTRY } from "./domains/domain-registry.ts";
// Transitional re-export (Phase 4): LlmCallDomain now lives in
// domains/domain-registry.ts (derived from DOMAIN_REGISTRY, not the other
// way around -- see that file's docstring). Re-exported here so the many
// files across this codebase that already `import type { LlmCallDomain }
// from "./section-router.ts"` keep working unchanged. New code should
// import the type from domains/domain-registry.ts directly; existing
// imports can migrate incrementally, not as part of this change.
export type { LlmCallDomain } from "./domains/domain-registry.ts";

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

/** The bounded domains that receive at most ONE Azure OpenAI call each (see
 *  domain-readiness.ts / adaptive-extractor.ts). Every SectionDomain above
 *  maps to exactly one of these (or null, for "other", which never by
 *  itself triggers an LLM call). Phase 4: sourced from the domain registry
 *  (domains/domain-registry.ts) instead of a hand-written literal -- same
 *   5 domains, same order, verified in
 *  _tests/domain-registry-byte-compatibility.test.ts. LlmCallDomain itself
 *  is now defined (and re-exported) from the registry; see the transitional
 *  re-export near the top of this file. */
export const LLM_CALL_DOMAINS = getEnabledDomainIdsInOrder();

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
  /** Multi-label routing shadow (Phase 3, LEASE_MULTILABEL_ROUTING_V1) --
   *  only populated by routeSectionsMultiLabel(), undefined from plain
   *  routeSections(). See that function's docstring below. */
  llmDomainScores?: Partial<Record<LlmCallDomain, number>>;
  targetLlmCallDomains?: LlmCallDomain[];
  /** Phase 5 expense-specialist shadow routing -- only populated by
   *  routeSectionsWithSpecialists(). A SEPARATE field from
   *  targetLlmCallDomains, never merged into it: MAX_TARGET_DOMAINS's flat
   *  3-cap is a single module constant with no domain-class partitioning,
   *  so feeding specialist scores into the same selection would let them
   *  crowd out the original 5 domains and risk the locked Phase 3
   *  "never more than 3" test. See selectSpecialistTargetDomains below. */
  targetSpecialistDomains?: LlmCallDomain[];
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

// ── Multi-label routing shadow (Phase 3, LEASE_MULTILABEL_ROUTING_V1) ───────
//
// A block already legitimately scores for MULTIPLE SectionDomains today
// (scoreBlockDomains above) -- routeSections() just throws that away by
// keeping only topDomain(). This section surfaces the scores that already
// exist rather than computing new ones: llmDomainScores sums each matching
// SectionDomain's score into its mapped LlmCallDomain (SECTION_DOMAIN_TO_LLM_CALL_DOMAIN),
// so a block matching both "cam" and "insurance" patterns (both -> expenses_and_cam)
// naturally scores higher there than a block matching only one.
//
// Thresholds are in the SAME raw integer scale DOMAIN_PATTERNS' weights use
// (1-3 per matching pattern, additive) -- not a 0-1 normalized scale. A
// single strong heading-shaped match (weight 3) or two weaker body matches
// clears a threshold of 2-3. expenses_and_cam starts lower than the others
// because CAM/expense/tax/insurance/utility clauses are routed here via 4
// different SectionDomains that are individually easy to under-match (see
// adaptive-extractor.ts's DOMAIN_CONCEPTS.expenses_and_cam comment on this
// same under-recall pattern). These are initial values for shadow
// observation, not tuned production thresholds.
// Phase 4: sourced from the domain registry's routingThreshold field
// instead of a hand-written literal -- same 5 values, verified in
// _tests/domain-registry-byte-compatibility.test.ts.
export const DOMAIN_THRESHOLDS: Record<LlmCallDomain, number> = Object.fromEntries(
  DOMAIN_REGISTRY.map((d) => [d.id, d.routingThreshold]),
) as Record<LlmCallDomain, number>;

const MAX_TARGET_DOMAINS = 3;

function aggregateLlmDomainScores(sectionScores: Partial<Record<SectionDomain, number>>): Partial<Record<LlmCallDomain, number>> {
  const out: Partial<Record<LlmCallDomain, number>> = {};
  for (const [sectionDomain, score] of Object.entries(sectionScores) as Array<[SectionDomain, number]>) {
    const llmDomain = SECTION_DOMAIN_TO_LLM_CALL_DOMAIN[sectionDomain];
    if (!llmDomain) continue;
    out[llmDomain] = (out[llmDomain] ?? 0) + score;
  }
  return out;
}

function selectTargetDomains(
  llmDomainScores: Partial<Record<LlmCallDomain, number>>,
  thresholds: Record<LlmCallDomain, number>,
): LlmCallDomain[] {
  return (Object.entries(llmDomainScores) as Array<[LlmCallDomain, number]>)
    .filter(([domain, score]) => score >= (thresholds[domain] ?? Infinity))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TARGET_DOMAINS)
    .map(([domain]) => domain);
}

/**
 * Shadow-only multi-label variant of routeSections(): calls it internally
 * and adds llmDomainScores/targetLlmCallDomains to each block -- primaryDomain
 * and byLlmCallDomain (built from primaryDomain alone) are untouched, so
 * this is purely additive. Nothing in the authoritative extraction path
 * calls this function; adaptive-extractor.ts's domain-escalation loop keeps
 * using plain routeSections()/byLlmCallDomain exactly as before.
 */
export function routeSectionsMultiLabel(
  docling: DoclingOutput,
  thresholds: Record<LlmCallDomain, number> = DOMAIN_THRESHOLDS,
): SectionRoutingResult {
  const result = routeSections(docling);
  const blocks = result.blocks.map((block) => {
    const llmDomainScores = aggregateLlmDomainScores(block.domainScores);
    const targetLlmCallDomains = selectTargetDomains(llmDomainScores, thresholds);
    return { ...block, llmDomainScores, targetLlmCallDomains };
  });
  return { ...result, blocks };
}

export interface RoutingShadowDiagnostic {
  blockIndex: number;
  primaryDomain: SectionDomain;
  /** The single LlmCallDomain primaryDomain alone would have routed to,
   *  today's authoritative behavior -- null for "other" (never escalated). */
  authoritativeLlmDomain: LlmCallDomain | null;
  targetLlmCallDomains: LlmCallDomain[];
  /** targetLlmCallDomains minus authoritativeLlmDomain -- the domains this
   *  block would ADDITIONALLY reach under multi-label routing. Empty when
   *  multi-label selection agrees with today's single-label routing. */
  addedDomains: LlmCallDomain[];
}

/**
 * Diagnostic-only comparison between today's single-label routing and the
 * multi-label shadow selection, for a human to review -- never consumed by
 * the extraction pipeline itself.
 */
export function buildRoutingShadowDiagnostics(multiLabelBlocks: RoutedBlock[]): RoutingShadowDiagnostic[] {
  return multiLabelBlocks.map((block) => {
    const authoritativeLlmDomain = SECTION_DOMAIN_TO_LLM_CALL_DOMAIN[block.primaryDomain] ?? null;
    const targetLlmCallDomains = block.targetLlmCallDomains ?? [];
    const addedDomains = targetLlmCallDomains.filter((domain) => domain !== authoritativeLlmDomain);
    return {
      blockIndex: block.blockIndex,
      primaryDomain: block.primaryDomain,
      authoritativeLlmDomain,
      targetLlmCallDomains,
      addedDomains,
    };
  });
}

export interface MultiLabelRoutingMetrics {
  totalBlocks: number;
  /** Blocks where multi-label selection chose more than one domain. */
  multiLabelBlocks: number;
  averageTargetsPerBlock: number;
  maximumTargetsPerBlock: number;
  /** Blocks with zero selected domains -- normal/expected for boilerplate,
   *  signatures, definitions, etc.; not itself a failure signal. Reported
   *  for a human to spot-check, not to gate on automatically. */
  blocksWithNoTargets: number;
  /** How many blocks would ADD each domain beyond today's single-label
   *  routing (RoutingShadowDiagnostic.addedDomains, aggregated by domain). */
  addedTargetCountsByDomain: Record<string, number>;
  /** Sum of added blocks' own text length per domain -- an approximation
   *  of extra evidence volume (this block's raw text only, not the full
   *  assembled evidence package with heading/neighbor context
   *  adaptive-extractor.ts would add), not an exact token count. */
  evidenceCharacterGrowthByDomain: Record<string, number>;
}

export function buildMultiLabelRoutingMetrics(
  blocks: RoutedBlock[],
  diagnostics: RoutingShadowDiagnostic[],
): MultiLabelRoutingMetrics {
  const totalBlocks = blocks.length;
  const targetCounts = diagnostics.map((d) => d.targetLlmCallDomains.length);
  const multiLabelBlocks = targetCounts.filter((n) => n > 1).length;
  const averageTargetsPerBlock = totalBlocks > 0 ? targetCounts.reduce((a, b) => a + b, 0) / totalBlocks : 0;
  const maximumTargetsPerBlock = targetCounts.length > 0 ? Math.max(...targetCounts) : 0;
  const blocksWithNoTargets = targetCounts.filter((n) => n === 0).length;

  const addedTargetCountsByDomain: Record<string, number> = {};
  const evidenceCharacterGrowthByDomain: Record<string, number> = {};
  const blocksByIndex = new Map(blocks.map((b) => [b.blockIndex, b]));
  for (const diagnostic of diagnostics) {
    const block = blocksByIndex.get(diagnostic.blockIndex);
    for (const domain of diagnostic.addedDomains) {
      addedTargetCountsByDomain[domain] = (addedTargetCountsByDomain[domain] ?? 0) + 1;
      evidenceCharacterGrowthByDomain[domain] = (evidenceCharacterGrowthByDomain[domain] ?? 0) + (block?.text.length ?? 0);
    }
  }

  return { totalBlocks, multiLabelBlocks, averageTargetsPerBlock, maximumTargetsPerBlock, blocksWithNoTargets, addedTargetCountsByDomain, evidenceCharacterGrowthByDomain };
}

// ── Phase 5: expense-specialist shadow routing ──────────────────────────────
//
// SECTION_DOMAIN_TO_LLM_CALL_DOMAIN above is ONE-TO-ONE (cam/taxes/insurance/
// utilities all resolve to the single bucket expenses_and_cam, repairs to
// operating_obligations) -- aggregateLlmDomainScores() and selectTargetDomains()
// both assume that shape and MUST stay untouched (byte-identical Phase 3
// behavior). This section is a separate, additive, ONE-TO-MANY layer: each
// SectionDomain can route to its own specialist LlmCallDomain, scored and
// selected independently of the original 5's routing entirely.

const SECTION_DOMAIN_TO_SPECIALIST_DOMAINS: Partial<Record<SectionDomain, LlmCallDomain[]>> = {
  cam: ["cam_and_operating_expenses"],
  taxes: ["taxes"],
  insurance: ["insurance"],
  utilities: ["utilities"],
  repairs: ["repairs_and_maintenance"],
};

export interface SpecialistRoutingBudget {
  maximumSpecialistsPerBlock: number;
  maximumEvidenceCharactersPerSpecialist: number;
  maximumTotalShadowEvidenceCharacters: number;
}

/** Initial, tunable safety values -- not permanent production thresholds
 *  (same framing as DOMAIN_THRESHOLDS' own comment above). */
export const DEFAULT_SPECIALIST_ROUTING_BUDGET: SpecialistRoutingBudget = {
  maximumSpecialistsPerBlock: 5,
  maximumEvidenceCharactersPerSpecialist: 24_000,
  maximumTotalShadowEvidenceCharacters: 80_000,
};

export interface SpecialistRoutingResult {
  blocks: RoutedBlock[];
  bySpecialistDomain: Partial<Record<LlmCallDomain, RoutedBlock[]>>;
}

function aggregateSpecialistDomainScores(
  sectionScores: Partial<Record<SectionDomain, number>>,
): Partial<Record<LlmCallDomain, number>> {
  const out: Partial<Record<LlmCallDomain, number>> = {};
  for (const [sectionDomain, score] of Object.entries(sectionScores) as Array<[SectionDomain, number]>) {
    const specialistDomains = SECTION_DOMAIN_TO_SPECIALIST_DOMAINS[sectionDomain];
    if (!specialistDomains) continue;
    for (const specialistDomain of specialistDomains) {
      out[specialistDomain] = (out[specialistDomain] ?? 0) + score;
    }
  }
  return out;
}

/** Same sort-by-score-descending shape as selectTargetDomains, but sliced to
 *  budget.maximumSpecialistsPerBlock instead of the hardcoded module
 *  constant MAX_TARGET_DOMAINS -- a genuinely separate selection, never
 *  merged with or competing against the original 5's targetLlmCallDomains. */
function selectSpecialistTargetDomains(
  specialistScores: Partial<Record<LlmCallDomain, number>>,
  thresholds: Record<LlmCallDomain, number>,
  budget: SpecialistRoutingBudget,
): LlmCallDomain[] {
  return (Object.entries(specialistScores) as Array<[LlmCallDomain, number]>)
    .filter(([domain, score]) => score >= (thresholds[domain] ?? Infinity))
    .sort((a, b) => b[1] - a[1])
    .slice(0, budget.maximumSpecialistsPerBlock)
    .map(([domain]) => domain);
}

/**
 * Shadow-only specialist variant of routeSections(): calls it internally
 * and adds targetSpecialistDomains to each block plus a bySpecialistDomain
 * lookup (each specialist's own routed blocks, for building its own
 * evidence text -- see expense-specialist-shadow.ts's
 * buildSpecialistEvidenceText). primaryDomain, byLlmCallDomain,
 * targetLlmCallDomains, and every existing consumer of routeSections()/
 * routeSectionsMultiLabel() are untouched -- this is a new, separate
 * function. Runs directly off routeSections()'s own per-block domainScores
 * (already computed regardless of any flag) -- cheap and pure; only the LLM
 * calls this evidence feeds are flag-gated (expense-specialists-mode.ts).
 */
export function routeSectionsWithSpecialists(
  docling: DoclingOutput,
  thresholds: Record<LlmCallDomain, number> = DOMAIN_THRESHOLDS,
  budget: SpecialistRoutingBudget = DEFAULT_SPECIALIST_ROUTING_BUDGET,
): SpecialistRoutingResult {
  const result = routeSections(docling);
  const bySpecialistDomain: Partial<Record<LlmCallDomain, RoutedBlock[]>> = {};
  const blocks = result.blocks.map((block) => {
    const specialistScores = aggregateSpecialistDomainScores(block.domainScores);
    const targetSpecialistDomains = selectSpecialistTargetDomains(specialistScores, thresholds, budget);
    const withTargets: RoutedBlock = { ...block, targetSpecialistDomains };
    for (const domain of targetSpecialistDomains) {
      (bySpecialistDomain[domain] ??= []).push(withTargets);
    }
    return withTargets;
  });
  return { blocks, bySpecialistDomain };
}
