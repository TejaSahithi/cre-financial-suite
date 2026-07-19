// @ts-nocheck
import type { LeaseDocumentPackageMode } from "../feature-mode.ts";
import type { LeaseClaimsLedgerMode } from "../../claims/feature-mode.ts";
import type { CompatibilityExtractionData } from "../../claims/adapters/compatibility-payload-builder.ts";

export interface PackageRuntimeContext {
  orgId: string;
  uploadedFileId: string;
  leaseId?: string | null;
  extractionRunId: string;
  extractionStageRunId?: string | null;
  generationId: string;
  stageAttempt?: number;
}

export interface PackageRuntimeInput {
  singleDocumentCompatibility?: CompatibilityExtractionData | { fields: Record<string, unknown> } | null;
}

export interface PackageRuntimeModes {
  claimsMode: LeaseClaimsLedgerMode;
  packageMode: LeaseDocumentPackageMode;
}

export type PackageRuntimeStatus =
  | "disabled"
  | "completed"
  | "needs_review"
  | "requires_related_document"
  | "failed";

export interface PackageRuntimeResult {
  enabled: boolean;
  mode: LeaseDocumentPackageMode;
  claimsMode: LeaseClaimsLedgerMode;
  packageId?: string;
  membershipDecisionId?: string;
  relationshipCount?: number;
  resolutionRunId?: string;
  projectionRunId?: string;
  diffStatus?: string;
  compatibilityPersisted: boolean;
  status: PackageRuntimeStatus;
  errorCode?: string;
}

export interface PackageRuntimeEnvLike {
  get(key: string): string | undefined;
}
