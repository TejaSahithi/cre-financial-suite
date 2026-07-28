// @ts-nocheck
/**
 * Canonical Claim/Evidence Layer — identity context.
 *
 * Moved out of claim-converters.ts (Phase 6A) so canonical types have a
 * neutral home that doesn't depend on converter implementations -- the
 * same reasoning that keeps expense-vocabulary.ts's types independent of
 * any one specialist schema. claim-converters.ts keeps a transitional
 * re-export so every existing import (Phase 5's expense-specialist-claims.ts,
 * expense-specialist-metrics.ts, orchestrator.ts, etc.) keeps working
 * unchanged.
 */

export interface ClaimIdentityContext {
  organizationId: string;
  fileId: string;
  generationId: string;
  extractionRunId: string | null;
}
