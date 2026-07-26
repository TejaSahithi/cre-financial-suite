// @ts-nocheck
/**
 * Adaptive (Section-Aware) Fact Ledger Extraction.
 *
 * Azure Layout output -> section routing -> deterministic candidates ->
 * domain readiness -> narrow, domain-scoped Azure OpenAI calls ONLY for
 * unresolved domains -> merged Fact[] into the SAME shape/consumers
 * extractFactLedger() already produces (mapFactsToStandardFields, then
 * Lease Truth Assembly). This is the ONLY new thing this module does --
 * candidate production and domain-escalation decisions. It does not create
 * a new final publisher and does not change mapFactsToStandardFields,
 * merger.ts, or lease-truth-assembly.ts.
 *
 * Falls back to the existing, fully-tested extractFactLedger() (whole-
 * document chunking) whenever adaptive routing cannot confidently apply
 * (e.g. no text blocks to route at all) -- "do not enforce the call count by
 * dropping necessary extraction" is satisfied by this safety net, not by a
 * lower bound on how carefully any one domain is checked.
 */

import { callLLMJSON, LLMProviderError } from "../../llm.ts";
import { callLLMJSONWithProvenance } from "../provenance/transport/openai.ts";
import { resolveVerifiedSourcePage } from "../evidence-index.ts";
import { routeSections, LLM_CALL_DOMAINS, type LlmCallDomain, type SectionRoutingResult } from "../section-router.ts";
import { extractDeterministicCandidates, type DeterministicExtractionResult } from "../deterministic-candidates.ts";
import { evaluateDomainReadiness, type DomainReadiness } from "../domain-readiness.ts";
import { extractFactLedger, parseFactsResponse, dedupeFacts } from "./fact-ledger-extractor.ts";
import type { ModuleType } from "../types.ts";
import type { CanonicalDocumentIndex, DocumentProfileClassification, Fact, FactLedgerResult } from "./types.ts";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Narrow, per-domain concept lists -- named directly in the domain's own
// system prompt so the model is never asked to consider the whole 88-field
// registry or the whole document for a domain that only needs a handful of
// concepts resolved.
const DOMAIN_CONCEPTS: Record<LlmCallDomain, string> = {
  core_terms:
    "tenant legal name, landlord legal name, property/premises address, unit or suite number, " +
    "rentable square footage, lease commencement date, lease expiration date, lease term length",
  rent_and_charges:
    "monthly base rent amount, annual base rent amount, security deposit amount, late fee amount, " +
    "rent escalation rate/type, billing frequency -- NEVER additional rent, CAM, reimbursements, or " +
    "amortized charges as if they were base rent",
  expenses_and_cam:
    "CAM/common-area-maintenance recovery structure and amount, real-estate-tax responsibility, " +
    "insurance-cost responsibility, base year or expense stop, gross-up provisions -- each as the " +
    "NORMALIZED responsibility answer (tenant/landlord/shared), with the supporting clause as evidence",
  operating_obligations:
    "repair and maintenance responsibility (structural, HVAC, interior, exterior) and utility " +
    "payment responsibility -- distinguish who PAYS for a utility/system from who merely maintains " +
    "or repairs it; a repair-only clause does not by itself establish payment responsibility",
  legal_rights_and_dates:
    "renewal/extension options, right of first refusal or offer, early termination rights, " +
    "termination or renewal notice periods -- only an actual GRANT of a right, never a heading, " +
    "defined term, guaranty recital, or surrender/holdover/default clause",
};

function buildDomainSystemPrompt(domain: LlmCallDomain, moduleType: ModuleType): string {
  return `You are a commercial real estate (${moduleType}) fact extraction tool, focused ONLY on the following topic area for this call:

${DOMAIN_CONCEPTS[domain]}

Extract every discrete, verifiable FACT stated in the provided document excerpt that relates to this
topic area ONLY. Do not extract facts about unrelated topics even if they appear in the excerpt.

A fact is one atomic assertion grounded in EXACT verbatim source text from the excerpt.
"value" is the SHORT, ATOMIC answer only (entity name, date, dollar figure, normalized responsibility
answer). "source_text" is the exact verbatim grounding quote (a complete sentence, complete table row,
or a single "Label: value" line) -- never paraphrased, never truncated mid-sentence.

Some facts in this excerpt may already be resolved deterministically and are listed below under
"Already resolved deterministically" -- do not re-report those unless the excerpt reveals a genuine
conflict with them (a different value for the same concept); if so, report the excerpt's version so a
human reviewer can compare.

Output ONLY a valid JSON object of this exact shape:
  { "facts": [ { "category": "clause:default", "value": <value>, "source_text": "<verbatim>", "source_page": <page or null>, "confidence": <0.0-1.0> } ] }
If there are no facts for this topic area, return { "facts": [] } -- never omit the "facts" key.

RULES:
1. source_text MUST be exact verbatim text -- never paraphrase.
2. If you cannot provide exact source_text for a fact, DO NOT include it.
3. NEVER guess, infer, or calculate values not explicitly stated.
4. Stay within the stated topic area for this call.`;
}

function buildDomainEvidenceText(
  domain: LlmCallDomain,
  routing: SectionRoutingResult,
  deterministic: DeterministicExtractionResult,
): string {
  const domainBlocks = routing.byLlmCallDomain[domain] ?? [];
  if (domainBlocks.length === 0) return "";

  // Include each routed block plus its immediate neighbors (±1 by
  // blockIndex) for context, deduplicated -- a bounded, section-scoped
  // evidence package, not the whole document.
  const allBlocksByIndex = new Map(routing.blocks.map((b) => [b.blockIndex, b]));
  const includedIndexes = new Set<number>();
  for (const block of domainBlocks) {
    includedIndexes.add(block.blockIndex);
    for (const neighborIndex of [block.blockIndex - 1, block.blockIndex + 1]) {
      if (allBlocksByIndex.has(neighborIndex)) includedIndexes.add(neighborIndex);
    }
  }
  const orderedBlocks = [...includedIndexes]
    .sort((a, b) => a - b)
    .map((i) => allBlocksByIndex.get(i))
    .filter(Boolean);

  let text = "";
  let lastPage: number | null = null;
  for (const block of orderedBlocks) {
    if (block.page != null && block.page !== lastPage) {
      text += `\n[[PAGE ${block.page}]]\n`;
      lastPage = block.page;
    }
    text += `${block.text}\n`;
  }

  const domainDeterministicFacts = (deterministic.candidatesByDomain[domain] ?? []).map((c) => c.fact);
  if (domainDeterministicFacts.length > 0) {
    text += "\nAlready resolved deterministically (do not re-report unless conflicting):\n";
    for (const fact of domainDeterministicFacts.slice(0, 10)) {
      text += `- ${fact.category}: ${JSON.stringify(fact.value)} (from "${String(fact.sourceText).slice(0, 120)}")\n`;
    }
  }
  return text.trim();
}

export interface DomainCallInstrumentation {
  domain: LlmCallDomain;
  called: boolean;
  reason: string;
  inputCharsEstimate: number;
  inputTokensEstimate: number;
  outputTokens: number | null;
  promptTokens: number | null;
  factsReturned: number;
  cacheHit: boolean;
}

export interface AdaptiveExtractionInstrumentation {
  mode: "adaptive" | "fallback_full_chunk";
  fallbackReason?: string;
  azureCalls: number;
  llmCalls: number;
  llmDomains: LlmCallDomain[];
  domainsResolvedDeterministically: LlmCallDomain[];
  domainsEscalated: LlmCallDomain[];
  perDomain: DomainCallInstrumentation[];
  totalInputTokensEstimate: number;
  totalOutputTokens: number;
  deterministicFieldsCovered: string[];
}

export type AdaptiveFactLedgerResult = FactLedgerResult & {
  adaptiveInstrumentation: AdaptiveExtractionInstrumentation;
};

// Simple in-memory cache: identical (domain, evidence-text) pairs within the
// same process never issue a second Azure OpenAI call. Real cross-invocation
// caching (by document hash) is a documented follow-up (see
// LEASE_TRUTH_ASSEMBLY_IMPLEMENTATION.md) -- this in-process cache exists so
// a canonical-only rebuild that re-runs this module against unchanged inputs
// within the same run never re-calls the LLM.
const domainCallCache = new Map<string, Fact[]>();

function domainCacheKey(domain: LlmCallDomain, evidenceText: string, moduleType: ModuleType): string {
  return `${moduleType}:${domain}:${evidenceText.length}:${evidenceText.slice(0, 64)}`;
}

async function callDomainLlm(args: {
  domain: LlmCallDomain;
  evidenceText: string;
  moduleType: ModuleType;
  deadlineAt?: number;
  provenance?: { supabaseAdmin: any; context: import("../provenance/types.ts").ProvenanceContext };
}): Promise<{ facts: Fact[]; promptTokens: number | null; completionTokens: number | null; cacheHit: boolean; warning: string | null }> {
  const { domain, evidenceText, moduleType, provenance } = args;
  const cacheKey = domainCacheKey(domain, evidenceText, moduleType);
  const cached = domainCallCache.get(cacheKey);
  if (cached) {
    return { facts: cached, promptTokens: 0, completionTokens: 0, cacheHit: true, warning: null };
  }

  try {
    const callOpts = {
      systemPrompt: buildDomainSystemPrompt(domain, moduleType),
      userPrompt: evidenceText,
      temperature: 0,
    };
    const response = provenance
      ? await callLLMJSONWithProvenance(
        provenance.supabaseAdmin,
        { ...provenance.context, operation: `adaptive_fact_ledger_domain_${domain}` },
        callOpts,
      )
      : await callLLMJSON(callOpts);
    const facts = response.data == null ? [] : parseFactsResponse(response.data);
    domainCallCache.set(cacheKey, facts);
    return {
      facts,
      promptTokens: (response as any)?.promptTokens ?? null,
      completionTokens: (response as any)?.completionTokens ?? null,
      cacheHit: false,
      warning: null,
    };
  } catch (error) {
    return {
      facts: [],
      promptTokens: null,
      completionTokens: null,
      cacheHit: false,
      warning: `Adaptive domain extraction failed for domain=${domain}: ${(error as Error)?.message ?? error}`,
    };
  }
}

export interface ExtractFactLedgerAdaptiveArgs {
  docIndex: CanonicalDocumentIndex;
  profile: DocumentProfileClassification;
  moduleType: ModuleType;
  fileBase64?: string | null;
  fileMimeType?: string | null;
  fileModeOverride?: boolean;
  deadlineAt?: number;
  provenance?: { supabaseAdmin: any; context: import("../provenance/types.ts").ProvenanceContext };
  maxChunks?: number;
  onProgress?: (progress: Record<string, unknown>) => Promise<void> | void;
  resume?: import("./types.ts").FactLedgerResumeState;
}

/**
 * Section-aware adaptive extraction: deterministic candidates first, then at
 * most one Azure OpenAI call per unresolved domain (of the 5 in
 * LLM_CALL_DOMAINS), never one call per chunk/page/field. Falls back to
 * extractFactLedger() (whole-document chunking) when the document has no
 * routable text-block structure at all, or when the caller has requested
 * file-mode/resume semantics this adaptive path does not implement (both of
 * those remain fully served by the existing, unmodified extractor).
 */
export async function extractFactLedgerAdaptive(args: ExtractFactLedgerAdaptiveArgs): Promise<AdaptiveFactLedgerResult> {
  const { docIndex, moduleType } = args;
  const doclingRaw = (docIndex?.doclingRaw ?? {}) as Record<string, unknown>;
  const textBlocks = Array.isArray((doclingRaw as any)?.text_blocks) ? (doclingRaw as any).text_blocks : [];

  const fallbackReasons: string[] = [];
  if (textBlocks.length === 0) fallbackReasons.push("Document has no Azure Layout text_blocks to route.");
  if (args.resume) fallbackReasons.push("A checkpoint/resume state was provided; adaptive mode does not implement mid-flight resume.");
  const fileModeRequested = args.fileModeOverride ?? false;
  if (fileModeRequested && args.fileBase64) fallbackReasons.push("File-mode extraction was requested.");

  if (fallbackReasons.length > 0) {
    const fallback = await extractFactLedger(args);
    return {
      ...fallback,
      adaptiveInstrumentation: {
        mode: "fallback_full_chunk",
        fallbackReason: fallbackReasons.join(" "),
        azureCalls: 0,
        llmCalls: fallback.chunksProcessed ?? 0,
        llmDomains: [],
        domainsResolvedDeterministically: [],
        domainsEscalated: [],
        perDomain: [],
        totalInputTokensEstimate: 0,
        totalOutputTokens: 0,
        deterministicFieldsCovered: [],
      },
    };
  }

  const routing = routeSections(doclingRaw as any);
  const deterministic = extractDeterministicCandidates(doclingRaw as any, moduleType);

  const perDomain: DomainCallInstrumentation[] = [];
  const domainsResolvedDeterministically: LlmCallDomain[] = [];
  const domainsEscalated: LlmCallDomain[] = [];
  const llmFacts: Fact[] = [];
  const warnings: string[] = [];
  let totalInputTokensEstimate = 0;
  let totalOutputTokens = 0;
  let llmCallsMade = 0;

  for (const domain of LLM_CALL_DOMAINS) {
    const domainFacts = (deterministic.candidatesByDomain[domain] ?? []).map((c) => c.fact);
    const hasRoutedContent = (routing.byLlmCallDomain[domain] ?? []).length > 0;
    const readiness: DomainReadiness = evaluateDomainReadiness({
      domain,
      moduleType,
      deterministicFacts: domainFacts,
      hasRoutedSectionContent: hasRoutedContent,
    });

    if (!readiness.requiresLlm) {
      domainsResolvedDeterministically.push(domain);
      perDomain.push({
        domain,
        called: false,
        reason: "Deterministic candidates already satisfy this domain's critical facts with no conflict.",
        inputCharsEstimate: 0,
        inputTokensEstimate: 0,
        outputTokens: null,
        promptTokens: null,
        factsReturned: 0,
        cacheHit: false,
      });
      continue;
    }

    const evidenceText = buildDomainEvidenceText(domain, routing, deterministic);
    if (!evidenceText) {
      // Readiness said this domain needs an LLM call, but there is no
      // routed section content to build a package from -- nothing to send,
      // and nothing was dropped (the domain genuinely has no evidence).
      domainsResolvedDeterministically.push(domain);
      perDomain.push({
        domain,
        called: false,
        reason: `${readiness.escalationReasons.join(" ")} No routed section content was available to build an evidence package.`.trim(),
        inputCharsEstimate: 0,
        inputTokensEstimate: 0,
        outputTokens: null,
        promptTokens: null,
        factsReturned: 0,
        cacheHit: false,
      });
      continue;
    }

    domainsEscalated.push(domain);
    const callResult = await callDomainLlm({
      domain,
      evidenceText,
      moduleType,
      deadlineAt: args.deadlineAt,
      provenance: args.provenance,
    });
    if (callResult.warning) warnings.push(callResult.warning);
    if (!callResult.cacheHit) llmCallsMade += 1;
    const taggedFacts = callResult.facts.map((fact) => ({ ...fact, chunkIndex: LLM_CALL_DOMAINS.indexOf(domain) }));
    llmFacts.push(...taggedFacts);
    const inputTokensEstimate = estimateTokens(evidenceText);
    totalInputTokensEstimate += inputTokensEstimate;
    totalOutputTokens += callResult.completionTokens ?? 0;

    perDomain.push({
      domain,
      called: true,
      reason: readiness.escalationReasons.join(" ") || "Domain was not confidently resolved by deterministic candidates alone.",
      inputCharsEstimate: evidenceText.length,
      inputTokensEstimate,
      outputTokens: callResult.completionTokens,
      promptTokens: callResult.promptTokens,
      factsReturned: taggedFacts.length,
      cacheHit: callResult.cacheHit,
    });
  }

  const groundedLlmFacts = llmFacts.map((fact) => ({
    ...fact,
    sourcePage: fact.sourcePage ?? resolveVerifiedSourcePage(doclingRaw, fact.sourceText, null),
  }));
  const allFacts = dedupeFacts([...deterministic.facts, ...groundedLlmFacts]);

  return {
    facts: allFacts,
    warnings,
    chunksProcessed: llmCallsMade,
    chunksTotal: LLM_CALL_DOMAINS.length,
    chunksSucceeded: llmCallsMade - warnings.length,
    chunksFailed: warnings.length,
    adaptiveInstrumentation: {
      mode: "adaptive",
      azureCalls: 0,
      llmCalls: llmCallsMade,
      llmDomains: domainsEscalated,
      domainsResolvedDeterministically,
      domainsEscalated,
      perDomain,
      totalInputTokensEstimate,
      totalOutputTokens,
      deterministicFieldsCovered: [...deterministic.fieldKeysCovered],
    },
  };
}

export const __test__ = {
  buildDomainSystemPrompt,
  buildDomainEvidenceText,
  domainCallCache,
};
