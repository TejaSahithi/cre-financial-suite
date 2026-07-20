// @ts-nocheck
import type { LeaseClaimsLedgerMode } from "../../claims/feature-mode.ts";
import type { LeaseDocumentPackageMode } from "../../document-package/feature-mode.ts";
import type { LeaseFinancialScheduleMode } from "../feature-mode.ts";

export interface FinancialRuntimeContext {
  orgId: string;
  uploadedFileId: string;
  leaseId?: string | null;
  extractionRunId: string;
  generationId: string;
  packageId?: string | null;
  stageAttempt?: number;
}

export interface FinancialRuntimeInput {
  currentCompatibility?: { fields?: Record<string, unknown> } | Record<string, unknown> | null;
  packageId?: string | null;
  packageAwareInput?: boolean;
}

export interface FinancialRuntimeModes {
  claimsMode: LeaseClaimsLedgerMode;
  packageMode: LeaseDocumentPackageMode;
  financialMode: LeaseFinancialScheduleMode;
}

export type FinancialRuntimeStatus =
  | "disabled"
  | "completed"
  | "completed_with_warnings"
  | "needs_review"
  | "requires_related_document"
  | "failed";

export interface FinancialRuntimeResult {
  enabled: boolean;
  mode: LeaseFinancialScheduleMode;
  claimsMode?: LeaseClaimsLedgerMode;
  packageMode?: LeaseDocumentPackageMode;
  calculationRunId?: string;
  projectionRunId?: string;
  diffStatus?: string;
  compatibilityPersisted: boolean;
  criticalDateProjectionStatus?: string;
  status: FinancialRuntimeStatus;
  errorCode?: string;
}

export interface FinancialRuntimeEnvLike {
  get(key: string): string | undefined;
}