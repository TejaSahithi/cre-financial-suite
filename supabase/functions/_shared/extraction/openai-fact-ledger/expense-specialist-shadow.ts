// @ts-nocheck
/**
 * Phase 5 expense-specialist shadow-call orchestration.
 *
 * Called from adaptive-extractor.ts AFTER the main domain-escalation loop
 * (`for (const domain of LLM_CALL_DOMAINS)`) finishes entirely -- which
 * trivially satisfies every specialist's registry-declared shadowRunsAfter,
 * since every authoritative domain has run by then. Never blocks, never
 * retries, never feeds back into the authoritative result: results are
 * pushed only onto a diagnostics field (adaptive-extractor.ts's
 * AdaptiveExtractionInstrumentation.expenseSpecialistShadow), never into
 * llmFacts/allFacts/domainsEscalated or anything mapFactsToStandardFields/
 * Truth Assembly reads.
 *
 * Correction C (see the Phase 5 plan): runExpenseSpecialistShadowOutput
 * NEVER throws and NEVER returns null -- every branch (no routed evidence,
 * a non-"success" LLM status, or a genuinely unexpected exception) produces
 * a real ExpenseSpecialistShadowRecord. runAllExpenseSpecialistShadowOutputs
 * always returns exactly getExpenseSpecialistDefinitionsInOrder().length
 * records, one per specialist, in registry order -- a failure never
 * silently disappears from diagnostics.
 */

import { callLLMStructuredWithProvenance } from "../provenance/transport/openai.ts";
import type { ProvenanceContext } from "../provenance/types.ts";
import type { StructuredLlmStatus } from "../../llm.ts";
import type { ModuleType } from "../types.ts";
import type { LlmCallDomain, ExtractionDomainDefinition } from "../domains/domain-registry.ts";
import { getExpenseSpecialistDefinitionsInOrder } from "../domains/domain-registry.ts";
import type { SpecialistRoutingResult } from "../section-router.ts";
import { getObligationStrictSchema } from "../schemas/domains/expense-specialists/obligation-schema-registry.ts";

export type ExpenseSpecialistTechnicalStatus = StructuredLlmStatus | "no_evidence" | "exception";

export interface ExpenseSpecialistShadowRecord {
  domain: LlmCallDomain;
  technicalStatus: ExpenseSpecialistTechnicalStatus;
  /** [] on any non-"success" status. */
  obligations: unknown[];
  errorMessage: string | null;
  schemaVersion: string;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

function emptyRecord(
  definition: ExtractionDomainDefinition,
  technicalStatus: ExpenseSpecialistTechnicalStatus,
  errorMessage: string | null = null,
  latencyMs: number | null = null,
  inputTokens: number | null = null,
  outputTokens: number | null = null,
): ExpenseSpecialistShadowRecord {
  return {
    domain: definition.id as LlmCallDomain,
    technicalStatus,
    obligations: [],
    errorMessage,
    schemaVersion: definition.schemaVersion ?? "unknown",
    latencyMs,
    inputTokens,
    outputTokens,
  };
}

/**
 * Domain's own routed blocks (section-router.ts's bySpecialistDomain) plus
 * their immediate neighbors (±1 by blockIndex) for context, deduplicated --
 * mirrors adaptive-extractor.ts's buildDomainEvidenceText's shape exactly,
 * except keyed off the specialist routing bucket instead of
 * routing.byLlmCallDomain, and with no deterministic-candidates appendix
 * (specialists are not part of that system). Truncated to maxChars --
 * correction A: genuinely per-specialist evidence, not a shared blob.
 */
export function buildSpecialistEvidenceText(
  domain: LlmCallDomain,
  specialistRouting: SpecialistRoutingResult,
  maxChars: number,
): string {
  const domainBlocks = specialistRouting.bySpecialistDomain[domain] ?? [];
  if (domainBlocks.length === 0) return "";

  const allBlocksByIndex = new Map(specialistRouting.blocks.map((b) => [b.blockIndex, b]));
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
  const trimmed = text.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function buildSpecialistSystemPrompt(definition: ExtractionDomainDefinition): string {
  return `You are a commercial real estate lease data extraction tool, operating in STRICT schema mode for a single narrow topic area.

TOPIC AND RULES:
${definition.promptConcepts}

For EACH obligation you report, provide "status": one of "explicit" (the excerpt directly states this), "derived" (computed/implied -- rare, prefer explicit), "ambiguous" (more than one plausible reading exists), "conflicting" (the excerpt states two different values), "not_found" (used only if you are including a placeholder, which you should not do -- omit entirely instead).

GENERAL RULES:
1. Return ONE obligation per distinct concept/category/component/utility actually named in the evidence -- never collapse several into one generic result.
2. Never populate a value without a supporting "sourceQuote" (a complete verbatim sentence, table row, or "Label: value" line).
3. Do not extract from a sentence discussing a different concept that merely uses similar words.
4. If the evidence does not address this topic area at all, return an empty "obligations" array -- do not fabricate an obligation to avoid an empty result.
5. Never guess a responsible/obligated party or economic treatment beyond what the excerpt actually states -- use "not_stated"/"conditional" rather than defaulting to a guess.`;
}

export interface RunExpenseSpecialistShadowOutputArgs {
  definition: ExtractionDomainDefinition;
  specialistRouting: SpecialistRoutingResult;
  moduleType: ModuleType;
  provenance: { supabaseAdmin: any; context: ProvenanceContext };
}

/**
 * NEVER throws, NEVER returns null (correction C) -- every branch produces
 * a real ExpenseSpecialistShadowRecord, including the outer catch for a
 * genuinely unexpected exception (not just a bad LLM response, which
 * callLLMStructuredWithProvenance already turns into a non-"success"
 * status rather than throwing).
 */
export async function runExpenseSpecialistShadowOutput(
  args: RunExpenseSpecialistShadowOutputArgs,
): Promise<ExpenseSpecialistShadowRecord> {
  const { definition } = args;
  try {
    const evidenceText = buildSpecialistEvidenceText(
      definition.id as LlmCallDomain,
      args.specialistRouting,
      definition.maximumEvidenceCharacters,
    );
    if (!evidenceText) return emptyRecord(definition, "no_evidence");

    const schemaDef = getObligationStrictSchema(definition.id as LlmCallDomain);
    const startedAt = Date.now();
    const result = await callLLMStructuredWithProvenance(
      args.provenance.supabaseAdmin,
      { ...args.provenance.context, operation: `expense_specialist_shadow_${definition.id}` },
      {
        systemPrompt: buildSpecialistSystemPrompt(definition),
        userPrompt: evidenceText,
        temperature: 0,
        maxOutputTokens: definition.maximumOutputTokens,
        promptVersion: schemaDef.schemaVersion,
        schemaName: schemaDef.schemaName,
        schema: schemaDef.jsonSchema,
      },
    );
    const latencyMs = Date.now() - startedAt;

    if (result.status !== "success") {
      return emptyRecord(
        definition, result.status,
        result.errorMessage ?? result.refusalReason ?? `Shadow call returned status=${result.status}`,
        latencyMs, result.inputTokens ?? 0, result.outputTokens ?? 0,
      );
    }

    const obligations = Array.isArray((result.data as any)?.obligations) ? (result.data as any).obligations : [];
    return {
      domain: definition.id as LlmCallDomain,
      technicalStatus: "success",
      obligations,
      errorMessage: null,
      schemaVersion: schemaDef.schemaVersion,
      latencyMs,
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
    };
  } catch (error) {
    return emptyRecord(definition, "exception", (error as Error)?.message ?? String(error));
  }
}

export interface RunAllExpenseSpecialistShadowOutputsArgs {
  specialistRouting: SpecialistRoutingResult;
  moduleType: ModuleType;
  provenance: { supabaseAdmin: any; context: ProvenanceContext };
}

/**
 * Always returns exactly getExpenseSpecialistDefinitionsInOrder().length
 * records, one per specialist, in registry order (correction C). The
 * Promise.allSettled rejected branch below is unreachable in practice
 * (runExpenseSpecialistShadowOutput never throws) but handled anyway as
 * defense-in-depth, never dropped from the result array.
 */
export async function runAllExpenseSpecialistShadowOutputs(
  args: RunAllExpenseSpecialistShadowOutputsArgs,
): Promise<ExpenseSpecialistShadowRecord[]> {
  const definitions = getExpenseSpecialistDefinitionsInOrder();
  const settled = await Promise.allSettled(
    definitions.map((definition) =>
      runExpenseSpecialistShadowOutput({
        definition, specialistRouting: args.specialistRouting, moduleType: args.moduleType, provenance: args.provenance,
      })
    ),
  );
  return settled.map((r, i) =>
    r.status === "fulfilled" ? r.value : emptyRecord(definitions[i], "exception", String((r as PromiseRejectedResult).reason))
  );
}
