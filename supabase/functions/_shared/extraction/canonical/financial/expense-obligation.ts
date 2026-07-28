// @ts-nocheck
/**
 * Canonical Expense Obligation (Phase 6A).
 *
 * One unified shape all 5 Phase 5 specialists' raw obligations convert
 * into -- see expense-obligation-converters.ts. Diagnostics-only this
 * phase: nothing here is written into ui_review_payload or any
 * authoritative field (see orchestrator.ts's measured
 * authoritativeMutationCount tripwire in expense-obligation-metrics.ts).
 */

import type { ClaimIdentityContext } from "../claim-identity-context.ts";
import type { EvidenceReference } from "../evidence-reference.ts";
import type { ClaimStatus, ClaimVerificationStatus } from "../claim-status.ts";
import type {
  ResponsibleParty,
  ExpenseFamily,
  ExpenseCategory,
  ExpensePaymentMechanism,
  ExpenseAllocationMethod,
  ExpenseAmountType,
  ExpenseObligationType,
  CanonicalAuditRight,
} from "./expense-vocabulary.ts";

export interface ExpenseCap {
  type: "cumulative_percentage" | "non_cumulative_percentage" | "fixed_amount" | "other";
  value: number | null;
  appliesTo: string | null;
}

/** Deterministic source lineage (correction D) -- what specialist, what
 *  schema version, which position in its raw obligations[] array, and a
 *  hash of the raw obligation object itself. Enables reproducible
 *  obligationId generation, shadow diffing across runs, and dedup
 *  diagnostics without re-deriving any of this from scratch. */
export interface ExpenseObligationSource {
  specialistDomain: string;
  sourceSchemaVersion: string;
  sourceObligationIndex: number;
  sourcePayloadHash: string;
}

export interface ExpenseObligation extends ClaimIdentityContext {
  obligationId: string;
  source: ExpenseObligationSource;

  family: ExpenseFamily;
  category: ExpenseCategory;
  /** Preserves the source enum value whenever the target category
   *  collapsed to "other" -- never lost, just not first-class. */
  subcategory: string | null;

  responsibleParty: ResponsibleParty;
  beneficiaryParty: "tenant" | "landlord" | null;

  obligationType: ExpenseObligationType;
  paymentMechanism: ExpensePaymentMechanism;
  allocationMethod: ExpenseAllocationMethod;
  amountType: ExpenseAmountType;

  amount: number | null;
  currency: string | null;
  percentage: number | null;

  cap: ExpenseCap | null;

  inclusions: string[];
  exclusions: string[];

  reconciliation: {
    frequency: string | null;
    estimatedPayments: boolean | null;
    annualReconciliation: boolean | null;
    auditRight: CanonicalAuditRight | null;
    auditPeriodDays: number | null;
  } | null;

  effectivePeriod: { startDate: string | null; endDate: string | null } | null;

  status: ClaimStatus;
  verificationStatus: ClaimVerificationStatus;

  sourceClaimIds: string[];
  evidence: EvidenceReference[];

  /** Always null this phase -- amendment/package resolution is a later,
   *  separate phase, same placeholder convention as ExtractedClaim's own
   *  controllingDocumentId. */
  controllingDocumentId: string | null;

  requiresReview: boolean;
  reviewReasons: string[];
}
