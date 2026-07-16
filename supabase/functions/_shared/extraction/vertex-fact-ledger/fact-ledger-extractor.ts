// @ts-nocheck
/**
 * Vertex Fact Ledger — Fact Extraction
 *
 * Default path is TEXT-MODE: chunked via chunker.ts's existing chunkDocument()
 * (capped at 4 chunks/calls) against docIndex.doclingRaw, using callVertexAIJSON().
 *
 * File-mode inline-PDF (callVertexAIFileJSON()) is an alternate path, gated
 * behind VERTEX_FACT_LEDGER_FILE_MODE (default false/unset) — mirrors the
 * NORMALIZE_INLINE_ENRICHMENT opt-in-flag convention already used in this
 * codebase. Per guardrail, Vertex file-mode PDF extraction must never be the
 * default.
 *
 * Facts are grouped using the same 34-category clause vocabulary
 * CLAUSE_DEFINITIONS (lease-workflow.ts) already uses, as "clause:<type>".
 * A fact with no real source_text is dropped — facts must be grounded.
 * Dedup via evidence-index.ts's existing normalizeForPageMatch().
 */

import { callVertexAIJSON, callVertexAIFileJSON } from "../../vertex-ai.ts";
import { chunkDocument } from "../chunker.ts";
import { normalizeForPageMatch, resolveVerifiedSourcePage } from "../evidence-index.ts";
import { CLAUSE_DEFINITIONS } from "../lease-workflow.ts";
import type { ModuleType } from "../types.ts";
import type { CanonicalDocumentIndex, DocumentProfileClassification, Fact, FactLedgerResult } from "./types.ts";

const MAX_CHUNKS = 4;
const CLAUSE_CATEGORY_VOCAB: string[] = CLAUSE_DEFINITIONS.map((def: any) => def.type);

function envFlagEnabled(name: string): boolean {
  try {
    return String(Deno.env.get(name) || "").toLowerCase() === "true";
  } catch {
    return false;
  }
}

function buildSystemPrompt(moduleType: ModuleType): string {
  return `You are a commercial real estate (${moduleType}) fact extraction tool.
Extract every discrete, verifiable FACT stated in the provided document text.

A fact is one atomic assertion — a party name, a date, a dollar amount, a percentage,
a defined term, an obligation, or a clause provision — grounded in EXACT verbatim
source text from the document.

Output ONLY a valid JSON array. Each element must have this exact shape:
  { "category": "<clause category>", "value": <extracted value>, "source_text": "<exact verbatim phrase>", "source_page": <page number or null>, "confidence": <0.0-1.0> }

The "category" MUST be one of these clause categories, prefixed with "clause:":
${CLAUSE_CATEGORY_VOCAB.map((c) => `clause:${c}`).join(", ")}
Pick the closest matching category for each fact. If nothing fits, use "clause:default".

RULES:
1. source_text MUST be the exact verbatim text from the document — never paraphrase.
2. If you cannot provide exact source_text for a fact, DO NOT include it.
3. NEVER guess, infer, or calculate values not explicitly stated.
4. Extract as many distinct facts as the text supports, not just a summary.`;
}

function isRealSourceText(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text || text.length < 3) return false;
  if (/^(llm extracted|extracted|manual_review|unknown|n\/?a|null)$/i.test(text)) return false;
  return true;
}

function coerceCategory(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  const type = raw.startsWith("clause:") ? raw.slice("clause:".length) : raw;
  return CLAUSE_CATEGORY_VOCAB.includes(type) ? `clause:${type}` : "clause:default";
}

function parseFactsResponse(raw: unknown): Fact[] {
  const arr = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.facts) ? (raw as any).facts : [];
  const facts: Fact[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const sourceText = (entry as any).source_text ?? (entry as any).sourceText;
    if (!isRealSourceText(sourceText)) continue;
    const value = (entry as any).value;
    if (value == null || value === "") continue;
    const confidence = Number((entry as any).confidence);
    facts.push({
      category: coerceCategory((entry as any).category),
      value,
      sourceText: String(sourceText).trim(),
      sourcePage: Number.isFinite(Number((entry as any).source_page ?? (entry as any).sourcePage))
        ? Number((entry as any).source_page ?? (entry as any).sourcePage)
        : null,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.6,
    });
  }
  return facts;
}

function dedupeFacts(facts: Fact[]): Fact[] {
  const seen = new Set<string>();
  const result: Fact[] = [];
  for (const fact of facts) {
    const key = `${fact.category}|${normalizeForPageMatch(fact.sourceText)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
  }
  return result;
}

async function extractFromChunk(
  chunkText: string,
  moduleType: ModuleType,
): Promise<{ facts: Fact[]; warning: string | null }> {
  try {
    const response = await callVertexAIJSON<unknown>({
      systemPrompt: buildSystemPrompt(moduleType),
      userPrompt: chunkText,
      temperature: 0,
    });
    return { facts: parseFactsResponse(response), warning: null };
  } catch (error) {
    return { facts: [], warning: `Fact ledger extraction failed for one chunk: ${(error as Error)?.message ?? error}` };
  }
}

async function extractFromFile(
  fileBase64: string,
  fileMimeType: string,
  moduleType: ModuleType,
): Promise<{ facts: Fact[]; warning: string | null }> {
  try {
    const response = await callVertexAIFileJSON<unknown>({
      systemPrompt: buildSystemPrompt(moduleType),
      userPrompt: "Extract facts from the attached document.",
      fileBase64,
      fileMimeType,
      temperature: 0,
    });
    return { facts: parseFactsResponse(response), warning: null };
  } catch (error) {
    return { facts: [], warning: `Fact ledger file-mode extraction failed: ${(error as Error)?.message ?? error}` };
  }
}

/**
 * Extract the fact ledger for a document. Text-mode by default; file-mode
 * only when VERTEX_FACT_LEDGER_FILE_MODE=true AND fileBase64 is provided.
 */
export async function extractFactLedger(args: {
  docIndex: CanonicalDocumentIndex;
  profile: DocumentProfileClassification;
  moduleType: ModuleType;
  fileBase64?: string | null;
  fileMimeType?: string | null;
  /** Explicit override for the VERTEX_FACT_LEDGER_FILE_MODE env flag — used
   *  by tests and by the orchestrator's VertexFactLedgerOptions.fileMode.
   *  Undefined defers to the env flag (default false). */
  fileModeOverride?: boolean;
}): Promise<FactLedgerResult> {
  const { docIndex, moduleType, fileBase64, fileMimeType, fileModeOverride } = args;
  const warnings: string[] = [];

  const fileModeEnabled = fileModeOverride ?? envFlagEnabled("VERTEX_FACT_LEDGER_FILE_MODE");
  if (fileModeEnabled && fileBase64 && fileMimeType) {
    const { facts, warning } = await extractFromFile(fileBase64, fileMimeType, moduleType);
    if (warning) warnings.push(warning);
    const grounded = dedupeFacts(facts).map((fact) => ({
      ...fact,
      sourcePage: resolveVerifiedSourcePage(docIndex.doclingRaw as Record<string, unknown>, fact.sourceText, fact.sourcePage),
    }));
    return { facts: grounded, warnings, chunksProcessed: 1 };
  }

  if (!docIndex.fullText || docIndex.fullText.trim().length < 10) {
    return { facts: [], warnings: ["Document text is too short for fact ledger extraction"], chunksProcessed: 0 };
  }

  const chunks = chunkDocument(docIndex.doclingRaw as any).slice(0, MAX_CHUNKS);
  const allFacts: Fact[] = [];
  let chunksProcessed = 0;

  for (const chunk of chunks) {
    const { facts, warning } = await extractFromChunk(chunk.text, moduleType);
    if (warning) warnings.push(warning);
    chunksProcessed += 1;
    for (const fact of facts) {
      allFacts.push({
        ...fact,
        sourcePage: fact.sourcePage ?? resolveVerifiedSourcePage(
          docIndex.doclingRaw as Record<string, unknown>,
          fact.sourceText,
          chunk.startPage ?? null,
        ),
      });
    }
  }

  return { facts: dedupeFacts(allFacts), warnings, chunksProcessed };
}
