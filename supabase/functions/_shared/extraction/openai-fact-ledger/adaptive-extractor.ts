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
import { routeSections, routeSectionsMultiLabel, routeSectionsWithSpecialists, buildRoutingShadowDiagnostics, buildMultiLabelRoutingMetrics, LLM_CALL_DOMAINS, type LlmCallDomain, type SectionRoutingResult, type RoutingShadowDiagnostic, type MultiLabelRoutingMetrics } from "../section-router.ts";
import { shouldComputeMultilabelRouting } from "./multilabel-routing-mode.ts";
import { runAllExpenseSpecialistShadowOutputs, type ExpenseSpecialistShadowRecord } from "./expense-specialist-shadow.ts";
import { shouldRunLeaseExpenseSpecialists } from "./expense-specialists-mode.ts";
import { extractDeterministicCandidates, type DeterministicExtractionResult, FIELD_GROUP_CLAUSE_CATEGORY } from "../deterministic-candidates.ts";
import { evaluateDomainReadiness, type DomainReadiness } from "../domain-readiness.ts";
import { extractFactLedger, parseFactsResponse, dedupeFacts } from "./fact-ledger-extractor.ts";
import { getSchema, type FieldDef } from "../schemas.ts";
import { getFieldContract } from "../field-contract.ts";
import { getSchemaEntriesForDomain } from "../enrich-bounded-stage/domain-fields.ts";
import { checkFieldSemanticCompatibility, inferSemanticProfile } from "../semantic-compatibility.ts";
import { isLlmPrimaryMappingActive } from "./llm-primary-mapping-mode.ts";
import { runExpensesAndCamStrictOutputsShadow, type StrictOutputsShadowRecord } from "./strict-outputs-shadow.ts";
import { getDomainDefinition } from "../domains/domain-registry.ts";
import type { ModuleType } from "../types.ts";
import type { CanonicalDocumentIndex, DocumentProfileClassification, Fact, FactLedgerResult } from "./types.ts";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Narrow, per-domain concept lists -- named directly in the domain's own
// system prompt so the model is never asked to consider the whole 88-field
// registry or the whole document for a domain that only needs a handful of
// concepts resolved.
//
// Phase 4: this used to be a hand-written Record<LlmCallDomain,string>
// here; the text itself (character-identical) now lives on each domain's
// registry definition (domains/definitions/*.ts) as promptConcepts, copied
// verbatim and checked in
// _tests/domain-registry-byte-compatibility.test.ts. getDomainDefinition()
// throws on an unrecognized domain rather than silently building a
// prompt with no concepts in it.
function domainConcepts(domain: LlmCallDomain): string {
  return getDomainDefinition(domain).promptConcepts;
}

function buildDomainSystemPrompt(domain: LlmCallDomain, moduleType: ModuleType): string {
  return `You are a commercial real estate (${moduleType}) fact extraction tool, focused ONLY on the following topic area for this call:

${domainConcepts(domain)}

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

// ── LLM-primary schema-aware mapping (LLM_PRIMARY_MAPPING_MODE=active) ──────
//
// Instead of extracting loose facts tagged with a broad 34-category clause
// vocabulary and letting fact-field-mapper.ts's keyword scorer guess which
// of the 88 schema fields each belongs to, this path hands the model THIS
// domain's own field list (key, type, description, enum values) and asks it
// to assign values directly -- putting real schema comprehension at the
// actual mapping decision, not just at fact extraction. See the "LLM-primary,
// schema-aware field mapping" plan for the full rationale.

function fieldsForDomain(domain: LlmCallDomain, moduleType: ModuleType): Array<[string, FieldDef]> {
  const schema = getSchema(moduleType);
  const nonDerivedEntries = Object.entries(schema).filter(([, def]) => !(def as FieldDef).derived) as Array<[string, FieldDef]>;
  return getSchemaEntriesForDomain(nonDerivedEntries, domain) as Array<[string, FieldDef]>;
}

function buildDomainFieldReference(fields: Array<[string, FieldDef]>): string {
  return fields
    .map(([key, def]) => {
      let line = `- ${key} (${def.type}): ${def.description}`;
      if (def.type === "enum" && def.enumValues) line += ` [enum: ${def.enumValues.join(", ")}]`;
      return line;
    })
    .join("\n");
}

function buildDomainFieldAssignmentPrompt(domain: LlmCallDomain, moduleType: ModuleType, fields: Array<[string, FieldDef]>): string {
  return `You are a commercial real estate (${moduleType}) data mapping tool, focused ONLY on the following topic area for this call:

${domainConcepts(domain)}

You will be given an excerpt of a real lease document. Your task has TWO parts, and both are
mandatory:
  A. For EACH of the schema fields listed below, decide whether the excerpt states a value for
     it, and if so, extract that value grounded in exact verbatim source text.
  B. Independently of part A, read the excerpt for anything else real and relevant to this topic
     area that the field list does not capture, and report it as an additional fact (part B is
     explained fully in rule 7 below -- it is not optional or secondary to part A).

MANDATORY READING DISCIPLINE: this excerpt commonly runs several paragraphs, an itemized list, or
a table -- lease terms for a single topic area are very often split across more than one place in
the document (a general clause early, then a specific dollar amount or exception later, then a
schedule/exhibit at the end). Read the excerpt from its first character to its last before
answering. Finding one relevant sentence early is not a reason to stop looking for the rest.

SCHEMA FIELDS FOR THIS CALL:
${buildDomainFieldReference(fields)}

RULES:
1. "not_stated" is the CORRECT and EXPECTED answer whenever the excerpt does not address a
   field -- never guess, infer, calculate, or fill a field just to avoid leaving it empty. A
   field left "not_stated" because the document is genuinely silent on it is a successful,
   accurate result, not a failure. This never excuses skipping part of the excerpt -- check the
   WHOLE excerpt before deciding a field is not_stated, not just the first paragraph.
2. "source_text" MUST be exact verbatim text from the excerpt -- a complete sentence, a
   complete table row, or a single "Label: value" line. Never paraphrase, never truncate
   mid-sentence, never fabricate a quote.
3. "value" is the SHORT, ATOMIC answer only -- never a full sentence or clause fragment.
4. For enum fields, "value" MUST be exactly one of the listed enum values (or "not_stated").
5. Do not extract a field's value from a sentence discussing a DIFFERENT concept that merely
   uses similar words (e.g. a maintenance surcharge "added to" the rent is not the rent itself;
   a signature-block date is not a lease term date; boilerplate "successors and assigns"
   language is not a party or signatory name).
6. If a value is already listed below under "Already resolved deterministically", confirm it
   (re-report the same value) unless the excerpt reveals a genuine conflict -- in which case
   report the excerpt's own version so a human reviewer can compare.
7. This is part B from above, and it is NOT optional: after finishing the field list, go back
   through the excerpt once more specifically looking for real, verifiable facts in this topic
   area that do NOT fit any field above -- a specific clause provision, a per-item obligation, one
   row of an itemized list or schedule, an exception or carve-out, a cap or condition on something
   you already reported. Report EACH one as its own entry in "additional_facts" rather than
   forcing it into the wrong field or leaving it out. This is the ONLY way this kind of detail
   reaches its business tab, since the schema has no dedicated field for it -- an excerpt that
   discusses several distinct provisions should typically produce several additional_facts
   entries, not zero and not one.

Output ONLY a valid JSON object of this exact shape:
  {
    "fields": {
      "<field_key>": { "value": <value>, "source_text": "<verbatim quote>", "source_page": <page or null>, "confidence": <0.0-1.0> }
    },
    "additional_facts": [
      { "category": "<short topic label>", "value": <value>, "source_text": "<verbatim quote>", "source_page": <page or null>, "confidence": <0.0-1.0> }
    ]
  }
For a field with no stated value, either omit its key entirely or set it to
  { "not_stated": true }
Never omit the "fields" key. Only include keys from the schema field list above in "fields".
"additional_facts" may be an empty array when nothing in the excerpt falls outside the field list.`;
}

export interface FieldAssignment {
  value: unknown;
  sourceText: string | null;
  sourcePage: number | null;
  confidence: number;
  notStated: boolean;
}

function parseFieldAssignmentResponse(raw: unknown, validFieldKeys: Set<string>): Record<string, FieldAssignment> {
  const out: Record<string, FieldAssignment> = {};
  const fields = (raw as any)?.fields;
  if (!fields || typeof fields !== "object") return out;

  for (const [key, entry] of Object.entries(fields)) {
    if (!validFieldKeys.has(key)) continue; // model must stay within this domain's own field list
    if (!entry || typeof entry !== "object") continue;
    const e = entry as any;
    if (e.not_stated === true) continue; // not_stated -> no assignment at all, falls through to the legacy path
    const sourceText = typeof e.source_text === "string" ? e.source_text.trim() : "";
    if (!sourceText || sourceText.length < 3) continue; // ungrounded -> treat as not_stated, never trust a valueless claim
    if (e.value == null || e.value === "") continue;
    const confidence = Number(e.confidence);
    out[key] = {
      value: e.value,
      sourceText,
      sourcePage: Number.isFinite(Number(e.source_page)) ? Number(e.source_page) : null,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.7,
      notStated: false,
    };
  }
  return out;
}

/**
 * Converts a domain's field assignments into Fact[], running the existing
 * semantic-compatibility gate (semantic-compatibility.ts) as a veto on the
 * model's own proposal. A failing check does not drop the fact -- it is
 * still returned (llmProposedFieldKey set) so the field is populated, but
 * carries semanticVetoReason so fact-field-mapper.ts marks it needs_review
 * instead of silently trusting it. This is defense in depth, not the
 * decision-maker: the LLM already made the call; this only catches an
 * obviously-incompatible pairing before it reaches a reviewer unflagged.
 */
function assignmentsToFacts(
  domain: LlmCallDomain,
  assignments: Record<string, FieldAssignment>,
  chunkIndex: number,
): Fact[] {
  const facts: Fact[] = [];
  for (const [fieldKey, assignment] of Object.entries(assignments)) {
    const group = getFieldContract(fieldKey)?.group;
    const category = (group && FIELD_GROUP_CLAUSE_CATEGORY[group]) || "clause:default";
    const profile = inferSemanticProfile({
      value: assignment.value,
      sourceText: assignment.sourceText,
      category,
    });
    const compatibility = checkFieldSemanticCompatibility(profile, fieldKey, {
      value: assignment.value,
      sourceText: assignment.sourceText,
      category,
    });
    facts.push({
      category,
      value: assignment.value,
      sourceText: assignment.sourceText ?? "",
      sourcePage: assignment.sourcePage,
      confidence: assignment.confidence,
      chunkIndex,
      llmProposedFieldKey: fieldKey,
      semanticVetoReason: compatibility.compatible ? null : compatibility.reason,
    });
  }
  return facts;
}

async function callDomainLlmForFieldAssignment(args: {
  domain: LlmCallDomain;
  evidenceText: string;
  fields: Array<[string, FieldDef]>;
  moduleType: ModuleType;
  provenance?: { supabaseAdmin: any; context: import("../provenance/types.ts").ProvenanceContext };
}): Promise<{ assignments: Record<string, FieldAssignment>; additionalFacts: Fact[]; promptTokens: number | null; completionTokens: number | null; error: string | null }> {
  const { domain, evidenceText, fields, moduleType, provenance } = args;
  const validFieldKeys = new Set(fields.map(([key]) => key));
  try {
    const callOpts = {
      systemPrompt: buildDomainFieldAssignmentPrompt(domain, moduleType, fields),
      userPrompt: evidenceText,
      temperature: 0,
      promptVersion: "llm-primary-mapping-v1",
    };
    const response = provenance
      ? await callLLMJSONWithProvenance(
        provenance.supabaseAdmin,
        { ...provenance.context, operation: `llm_primary_mapping_domain_${domain}` },
        callOpts,
      )
      : await callLLMJSON(callOpts);
    const assignments = response.data == null ? {} : parseFieldAssignmentResponse(response.data, validFieldKeys);
    // Reuses fact-ledger-extractor.ts's own parseFactsResponse (same
    // {category,value,source_text,source_page,confidence} shape, same
    // grounding/validity checks) -- content the model found real and
    // relevant but that doesn't fit this domain's named field list. These
    // flow into the identical unmappedFacts -> surfaceDynamicFacts path
    // broad extraction always fed, so switching to schema-aware primary
    // mapping doesn't silently narrow what can reach a business tab.
    const additionalFactsRaw = (response.data as any)?.additional_facts;
    const additionalFacts = Array.isArray(additionalFactsRaw) ? parseFactsResponse(additionalFactsRaw) : [];
    return {
      assignments,
      additionalFacts,
      promptTokens: (response as any)?.promptTokens ?? null,
      completionTokens: (response as any)?.completionTokens ?? null,
      error: null,
    };
  } catch (error) {
    return {
      assignments: {},
      additionalFacts: [],
      promptTokens: null,
      completionTokens: null,
      error: `LLM-primary field assignment failed for domain=${domain}: ${(error as Error)?.message ?? error}`,
    };
  }
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
  /** True when this domain's fields were assigned by the schema-aware
   *  LLM-primary mapper (LLM_PRIMARY_MAPPING_MODE=active), false when it
   *  used the legacy broad-category extraction path (mode="off", or the
   *  primary call failed and this domain fell back). */
  primaryMappingUsed?: boolean;
  /** Set only when primaryMappingUsed is false because the schema-aware call
   *  itself failed and this domain fell back to the legacy path. */
  primaryMappingFallbackReason?: string | null;
  fieldsAssignedByPrimaryMapping?: number;
  fieldsFlaggedBySemanticVeto?: number;
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
  /** Strict Structured Outputs pilot (Phase 1, LEASE_STRICT_OUTPUTS_V1) --
   *  populated only for expenses_and_cam, only when the canary gate admits
   *  this (org, generation), and only when a provenance context was
   *  available to attach the call to. Never affects any field above. */
  strictOutputsShadow: StrictOutputsShadowRecord[];
  /** Multi-label routing shadow (Phase 3, LEASE_MULTILABEL_ROUTING_V1) --
   *  [] whenever the flag is off. Diagnostic only; the domain-escalation
   *  loop above always uses single-label routing regardless. */
  routingShadow: RoutingShadowDiagnostic[];
  routingShadowMetrics: MultiLabelRoutingMetrics | null;
  /** Phase 5 expense-specialist shadow (LEASE_EXPENSE_SPECIALISTS_V1) --
   *  [] whenever the flag is off (the default) or admission fails. Always
   *  exactly 5 records when it does run, one per specialist (see
   *  expense-specialist-shadow.ts's correction-C contract). Diagnostic
   *  only; never read by mapFactsToStandardFields/Truth Assembly. */
  expenseSpecialistShadow: ExpenseSpecialistShadowRecord[];
}

export type AdaptiveFactLedgerResult = FactLedgerResult & {
  adaptiveInstrumentation: AdaptiveExtractionInstrumentation;
};

// A process-level cache used to live here, keyed only on
// (moduleType, domain, evidenceText.length, evidenceText.slice(0,64)) -- no
// org_id, file_id, or generation_id. Supabase Edge Functions reuse warm
// isolates across requests from different callers, so two different
// documents (potentially from two different organizations) that happened to
// share the same evidence-text length and opening 64 characters for a given
// domain (plausible for boilerplate lease preambles) could receive each
// other's cached extraction. Removed outright rather than re-keyed: this
// was a same-run dedup optimization only, never a correctness requirement,
// and the cost concern it existed for is explicitly not a priority here.
// `cacheHit` stays in the return shape (always false now) since
// DomainCallInstrumentation and its consumers still read it.
async function callDomainLlm(args: {
  domain: LlmCallDomain;
  evidenceText: string;
  moduleType: ModuleType;
  deadlineAt?: number;
  provenance?: { supabaseAdmin: any; context: import("../provenance/types.ts").ProvenanceContext };
}): Promise<{ facts: Fact[]; promptTokens: number | null; completionTokens: number | null; cacheHit: boolean; warning: string | null }> {
  const { domain, evidenceText, moduleType, provenance } = args;
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
        strictOutputsShadow: [],
        routingShadow: [],
        routingShadowMetrics: null,
        expenseSpecialistShadow: [],
      },
    };
  }

  const routing = routeSections(doclingRaw as any);
  // Multi-label routing shadow (Phase 3, LEASE_MULTILABEL_ROUTING_V1) --
  // computed alongside, never in place of, the routing above. The
  // domain-escalation loop below always reads `routing.byLlmCallDomain`
  // (single-label, unchanged); this diagnostic is purely for inspection.
  const multilabelRoutingAdmitted = !!args.provenance && shouldComputeMultilabelRouting({
    orgId: args.provenance.context.orgId,
    generationId: args.provenance.context.generationId,
  });
  const multiLabelBlocksForMetrics = multilabelRoutingAdmitted ? routeSectionsMultiLabel(doclingRaw as any).blocks : null;
  const routingShadow: RoutingShadowDiagnostic[] = multiLabelBlocksForMetrics
    ? buildRoutingShadowDiagnostics(multiLabelBlocksForMetrics)
    : [];
  const routingShadowMetrics = multiLabelBlocksForMetrics
    ? buildMultiLabelRoutingMetrics(multiLabelBlocksForMetrics, routingShadow)
    : null;
  const deterministic = extractDeterministicCandidates(doclingRaw as any, moduleType);

  const perDomain: DomainCallInstrumentation[] = [];
  const domainsResolvedDeterministically: LlmCallDomain[] = [];
  const domainsEscalated: LlmCallDomain[] = [];
  const llmFacts: Fact[] = [];
  const warnings: string[] = [];
  const strictOutputsShadowRecords: StrictOutputsShadowRecord[] = [];
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
    const inputTokensEstimate = estimateTokens(evidenceText);
    totalInputTokensEstimate += inputTokensEstimate;

    let callResult: { facts: Fact[]; promptTokens: number | null; completionTokens: number | null; cacheHit: boolean; warning: string | null };
    let primaryMappingUsed = false;
    let primaryMappingFallbackReason: string | null = null;
    let assignmentsForShadow: Record<string, { value: unknown; sourceText: string | null }> | null = null;

    const domainFieldDefs = fieldsForDomain(domain, moduleType);
    if (isLlmPrimaryMappingActive() && domainFieldDefs.length > 0) {
      const primaryResult = await callDomainLlmForFieldAssignment({
        domain,
        evidenceText,
        fields: domainFieldDefs,
        moduleType,
        provenance: args.provenance,
      });
      if (!primaryResult.error) {
        primaryMappingUsed = true;
        llmCallsMade += 1;
        totalOutputTokens += primaryResult.completionTokens ?? 0;
        const additionalFactsTagged = primaryResult.additionalFacts.map((fact) => ({ ...fact, chunkIndex: LLM_CALL_DOMAINS.indexOf(domain) }));
        callResult = {
          facts: [...assignmentsToFacts(domain, primaryResult.assignments, LLM_CALL_DOMAINS.indexOf(domain)), ...additionalFactsTagged],
          promptTokens: primaryResult.promptTokens,
          completionTokens: primaryResult.completionTokens,
          cacheHit: false,
          warning: null,
        };
        if (domain === "expenses_and_cam") assignmentsForShadow = primaryResult.assignments;
      } else {
        // Schema-aware call failed outright (network/parse error) -- fall
        // back to the legacy broad-category extraction for this domain
        // rather than leaving it silently empty. This is the one case where
        // two calls genuinely happen for the same domain, and only because
        // the first one didn't produce a usable result.
        primaryMappingFallbackReason = primaryResult.error;
        warnings.push(primaryResult.error);
        callResult = await callDomainLlm({ domain, evidenceText, moduleType, deadlineAt: args.deadlineAt, provenance: args.provenance });
        if (callResult.warning) warnings.push(callResult.warning);
        if (!callResult.cacheHit) llmCallsMade += 1;
        totalOutputTokens += callResult.completionTokens ?? 0;
      }
    } else {
      callResult = await callDomainLlm({
        domain,
        evidenceText,
        moduleType,
        deadlineAt: args.deadlineAt,
        provenance: args.provenance,
      });
      if (callResult.warning) warnings.push(callResult.warning);
      if (!callResult.cacheHit) llmCallsMade += 1;
      totalOutputTokens += callResult.completionTokens ?? 0;
    }

    const taggedFacts = callResult.facts.map((fact) => ({ ...fact, chunkIndex: LLM_CALL_DOMAINS.indexOf(domain) }));
    llmFacts.push(...taggedFacts);

    // Strict Structured Outputs pilot (Phase 1) -- canary-gated, additive
    // only, fires after the authoritative call above has already completed.
    // Never awaited into the authoritative facts/warnings path beyond a
    // best-effort try/catch: a bug here must never affect this domain's
    // real extraction result.
    if (domain === "expenses_and_cam" && assignmentsForShadow && args.provenance) {
      try {
        const shadowRecord = await runExpensesAndCamStrictOutputsShadow({
          orgId: args.provenance.context.orgId,
          generationId: args.provenance.context.generationId,
          moduleType,
          evidenceText,
          domainFieldDefs,
          authoritativeAssignments: assignmentsForShadow,
          provenance: args.provenance,
        });
        if (shadowRecord) strictOutputsShadowRecords.push(shadowRecord);
      } catch (shadowError) {
        warnings.push(
          `Strict-outputs shadow call threw unexpectedly for domain=${domain}: ${(shadowError as Error)?.message ?? shadowError}`,
        );
      }
    }

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
      primaryMappingUsed,
      primaryMappingFallbackReason,
      fieldsAssignedByPrimaryMapping: primaryMappingUsed
        ? taggedFacts.filter((f) => f.llmProposedFieldKey && !f.semanticVetoReason).length
        : 0,
      fieldsFlaggedBySemanticVeto: primaryMappingUsed
        ? taggedFacts.filter((f) => f.llmProposedFieldKey && f.semanticVetoReason).length
        : 0,
    });
  }

  // Phase 5: expense-specialist shadow calls -- fire only AFTER the main
  // domain-escalation loop above has finished entirely, which trivially
  // satisfies every specialist's registry-declared shadowRunsAfter (every
  // authoritative domain has run by this point). Never awaited into the
  // authoritative facts/warnings path beyond a best-effort try/catch: a bug
  // here must never affect the real extraction result (same isolation
  // contract as the expenses_and_cam strict-outputs shadow hook above).
  let expenseSpecialistShadowRecords: ExpenseSpecialistShadowRecord[] = [];
  if (args.provenance && shouldRunLeaseExpenseSpecialists({
    orgId: args.provenance.context.orgId,
    generationId: args.provenance.context.generationId,
  })) {
    try {
      const specialistRouting = routeSectionsWithSpecialists(doclingRaw as any);
      expenseSpecialistShadowRecords = await runAllExpenseSpecialistShadowOutputs({
        specialistRouting, moduleType, provenance: args.provenance,
      });
    } catch (specialistError) {
      warnings.push(
        `Expense-specialist shadow calls threw unexpectedly: ${(specialistError as Error)?.message ?? specialistError}`,
      );
    }
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
      strictOutputsShadow: strictOutputsShadowRecords,
      routingShadow,
      routingShadowMetrics,
      expenseSpecialistShadow: expenseSpecialistShadowRecords,
    },
  };
}

export const __test__ = {
  buildDomainSystemPrompt,
  buildDomainEvidenceText,
  fieldsForDomain,
  buildDomainFieldReference,
  buildDomainFieldAssignmentPrompt,
  parseFieldAssignmentResponse,
  assignmentsToFacts,
};
