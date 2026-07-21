// @ts-nocheck

import type { CanonicalReviewFieldDefinition } from "./canonical-review-field-registry.ts";
import { buildCanonicalCoverageLedger, type CanonicalCoverageLedger, type CanonicalCoverageStatus } from "./canonical-coverage-ledger.ts";
import { projectionRowToReadModel, type CanonicalFieldProjectionReadModel, type CanonicalProjectionConflict, type CanonicalDerivationTrace } from "./canonical-projection-contract.ts";
import { buildCanonicalLegacyParity, type CanonicalLegacyParitySummary, type CanonicalAuthorityReadiness } from "./canonical-review-parity.ts";

export type EnterpriseFindingType =
  | "projection_conflict"
  | "missing_required_field"
  | "missing_source_evidence"
  | "invalid_projection"
  | "legacy_fallback_used"
  | "canonical_legacy_material_mismatch"
  | "low_confidence_projection"
  | "rejected_candidate_material"
  | "parse_quality_warning"
  | "evidence_integrity_warning";

export interface EnterpriseDynamicFinding {
  findingId: string;
  type: EnterpriseFindingType;
  canonicalFieldKey: string | null;
  domain: string | null;
  severity: "informational" | "warning" | "material" | "blocking";
  title: string;
  summary: string;
  reasonCodes: string[];
  claimIds: string[];
  evidenceIds: string[];
  resolutionStatus: "open" | "accepted" | "overridden" | "dismissed" | "resolved";
  reviewerActionRequired: boolean;
}

export interface EnterpriseEvidenceReference {
  evidenceId: string | null;
  claimId: string | null;
  page: number | null;
  blockIds: string[];
  polygonAvailable: boolean;
  sourceText: string | null;
  sourceClauseCategory: string | null;
}

export interface EnterpriseReviewField {
  canonicalFieldKey: string;
  reviewPath: string;
  domain: string;
  value: unknown;
  displayValue: string | null;
  status: CanonicalCoverageStatus;
  confidence: number | null;
  authoritativeSource: "canonical_projection" | "legacy_fallback" | "reviewer_override" | "derived" | "none";
  evidence: EnterpriseEvidenceReference[];
  derivation: CanonicalDerivationTrace | null;
  conflict: CanonicalProjectionConflict | null;
  review: {
    editable: boolean;
    requiresAttention: boolean;
    blocking: boolean;
    reasonCodes: string[];
  };
}

export interface EnterpriseValidationSummary {
  valid: boolean;
  approvalEligible: boolean;
  blockingIssueCount: number;
  warningCount: number;
  reasonCodes: string[];
}

export interface EnterpriseReviewPayload {
  schemaVersion: "enterprise-review-payload-v1";
  uploadedFileId: string;
  leaseId: string | null;
  orgId: string;
  runId: string;
  generationId: string | null;
  sourceMode: "legacy" | "canonical_hybrid" | "canonical_strict";
  canonicalDocument: {
    layoutHash: string | null;
    layoutSchemaVersion: string | null;
    layoutSource: "azure_native" | "legacy_lossy" | null;
    geometryAvailable: boolean;
  };
  fields: Record<string, EnterpriseReviewField>;
  coverage: CanonicalCoverageLedger;
  findings: EnterpriseDynamicFinding[];
  unresolvedConflicts: CanonicalProjectionConflict[];
  validationSummary: EnterpriseValidationSummary;
  compatibility: {
    legacyPayloadAvailable: boolean;
    fallbackFieldCount: number;
    paritySummary: CanonicalLegacyParitySummary | null;
  };
  payloadHash: string;
}

export interface EnterpriseReviewBuildResult {
  payload: EnterpriseReviewPayload;
  authorityReadiness: CanonicalAuthorityReadiness;
  rejectedProjectionCount: number;
  rejectedProjectionReasons: string[];
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
}

export function readLegacyFieldValue(field: CanonicalReviewFieldDefinition, legacyPayload: any): unknown {
  const firstRecord = legacyPayload?.records?.[0] ?? legacyPayload?.rows?.[0] ?? null;
  if (!firstRecord) return null;
  const key = field.canonicalFieldKey;
  const standardField = Array.isArray(firstRecord?.standard_fields)
    ? firstRecord.standard_fields.find((item: any) => item?.field_key === key)
    : null;
  return firstRecord?.fields?.[key]?.value ?? firstRecord?.values?.[key] ?? standardField?.value ?? null;
}

function writePath(target: any, path: string[], value: unknown) {
  let node = target;
  for (const segment of path.slice(0, -1)) {
    if (node[segment] == null || typeof node[segment] !== "object") node[segment] = {};
    node = node[segment];
  }
  node[path[path.length - 1]] = value;
}

export function enterpriseReviewPayloadToLegacyShape(payload: EnterpriseReviewPayload): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const fields: Record<string, unknown> = {};
  const standardFields = Object.values(payload.fields).map((field) => {
    values[field.canonicalFieldKey] = field.value;
    fields[field.canonicalFieldKey] = {
      value: field.value,
      confidence: field.confidence,
      status: field.status,
      source: field.authoritativeSource,
      evidence: field.evidence,
    };
    return {
      field_key: field.canonicalFieldKey,
      value: field.value,
      display_value: field.displayValue,
      status: field.status,
      confidence: field.confidence,
      authoritative_source: field.authoritativeSource,
      evidence: field.evidence,
      editable: field.review.editable,
    };
  });
  return {
    schema_version: 2,
    enterprise_review_payload_schema_version: payload.schemaVersion,
    file_id: payload.uploadedFileId,
    module_type: "lease",
    review_status: "pending",
    source_mode: payload.sourceMode,
    records: [{ row_index: 0, record_index: 0, values, fields, standard_fields: standardFields, custom_fields: [], missing_required: [] }],
    rows: [{ row_index: 0, record_index: 0, values, fields, standard_fields: standardFields, custom_fields: [], missing_required: [] }],
    metadata: {
      enterprise_review_payload: {
        schema_version: payload.schemaVersion,
        payload_hash: payload.payloadHash,
        coverage_summary: payload.coverage.totals,
      },
    },
  };
}

function evidenceReferencesFor(projection: CanonicalFieldProjectionReadModel | null, evidenceRows: any[]): EnterpriseEvidenceReference[] {
  if (!projection) return [];
  const sourceClaims = new Set(projection.sourceClaimIds);
  return evidenceRows
    .filter((row) => sourceClaims.has(String(row?.claim_id ?? "")) || projection.evidenceIds.includes(String(row?.id ?? "")))
    .map((row) => ({
      evidenceId: row?.id ?? null,
      claimId: row?.claim_id ?? null,
      page: typeof row?.page === "number" ? row.page : typeof row?.page_number === "number" ? row.page_number : null,
      blockIds: Array.isArray(row?.block_ids) ? row.block_ids : [],
      polygonAvailable: Array.isArray(row?.polygon) && row.polygon.length >= 8,
      sourceText: typeof row?.source_text === "string" ? row.source_text : null,
      sourceClauseCategory: row?.claim_type ?? row?.source_clause_category ?? null,
    }));
}

function fieldSource(args: {
  sourceMode: EnterpriseReviewPayload["sourceMode"];
  strict: boolean;
  field: CanonicalReviewFieldDefinition;
  projection: CanonicalFieldProjectionReadModel | null;
  coverageStatus: CanonicalCoverageStatus;
  legacyValue: unknown;
}): EnterpriseReviewField["authoritativeSource"] {
  if (args.field.authority === "derived") return "derived";
  if (args.sourceMode === "legacy") return hasValue(args.legacyValue) ? "legacy_fallback" : "none";
  if (args.coverageStatus === "legacy_fallback") return "legacy_fallback";
  if (args.projection && ["resolved", "resolved_with_warning", "needs_review", "conflict", "missing_source_evidence"].includes(args.coverageStatus)) return "canonical_projection";
  return "none";
}

function fieldValueFor(args: {
  source: EnterpriseReviewField["authoritativeSource"];
  projection: CanonicalFieldProjectionReadModel | null;
  legacyValue: unknown;
}): unknown {
  if (args.source === "canonical_projection") return args.projection?.normalizedValue ?? args.projection?.value ?? null;
  if (args.source === "legacy_fallback") return args.legacyValue;
  return null;
}

function buildFindings(args: {
  coverage: CanonicalCoverageLedger;
  fields: Record<string, EnterpriseReviewField>;
  parity: CanonicalLegacyParitySummary | null;
  rejectedProjectionReasons: string[];
}): EnterpriseDynamicFinding[] {
  const findings: EnterpriseDynamicFinding[] = [];
  for (const entry of args.coverage.entries) {
    const field = args.fields[entry.canonicalFieldKey];
    const base = {
      canonicalFieldKey: entry.canonicalFieldKey,
      domain: entry.domain,
      claimIds: field?.evidence?.map((e) => e.claimId).filter(Boolean) ?? [],
      evidenceIds: field?.evidence?.map((e) => e.evidenceId).filter(Boolean) ?? [],
      resolutionStatus: "open" as const,
    };
    if (entry.coverageStatus === "conflict") findings.push({ findingId: `projection_conflict:${entry.canonicalFieldKey}`, type: "projection_conflict", severity: "blocking", title: "Projection conflict", summary: `${entry.canonicalFieldKey} has unresolved canonical candidates.`, reasonCodes: entry.blockingReasons, reviewerActionRequired: true, ...base });
    if (entry.coverageStatus === "missing" && entry.requiredForApproval) findings.push({ findingId: `missing_required_field:${entry.canonicalFieldKey}`, type: "missing_required_field", severity: "blocking", title: "Missing required field", summary: `${entry.canonicalFieldKey} is required for approval.`, reasonCodes: entry.blockingReasons, reviewerActionRequired: true, ...base });
    if (entry.coverageStatus === "missing_source_evidence") findings.push({ findingId: `missing_source_evidence:${entry.canonicalFieldKey}`, type: "missing_source_evidence", severity: entry.requiredForApproval ? "blocking" : "warning", title: "Missing source evidence", summary: `${entry.canonicalFieldKey} has a value without acceptable source evidence.`, reasonCodes: entry.blockingReasons, reviewerActionRequired: entry.requiredForApproval, ...base });
    if (entry.coverageStatus === "invalid") findings.push({ findingId: `invalid_projection:${entry.canonicalFieldKey}`, type: "invalid_projection", severity: "blocking", title: "Invalid projection", summary: `${entry.canonicalFieldKey} failed canonical projection validation.`, reasonCodes: entry.blockingReasons, reviewerActionRequired: true, ...base });
    if (entry.legacyFallbackUsed) findings.push({ findingId: `legacy_fallback_used:${entry.canonicalFieldKey}`, type: "legacy_fallback_used", severity: "warning", title: "Legacy fallback used", summary: `${entry.canonicalFieldKey} used configured legacy fallback.`, reasonCodes: entry.warningReasons, reviewerActionRequired: false, ...base });
    if (entry.warningReasons.includes("low_confidence_projection")) findings.push({ findingId: `low_confidence_projection:${entry.canonicalFieldKey}`, type: "low_confidence_projection", severity: "warning", title: "Low confidence projection", summary: `${entry.canonicalFieldKey} has low canonical confidence.`, reasonCodes: ["low_confidence_projection"], reviewerActionRequired: false, ...base });
  }
  for (const comparison of args.parity?.comparisons ?? []) {
    if (comparison.material) findings.push({ findingId: `canonical_legacy_material_mismatch:${comparison.canonicalFieldKey}`, type: "canonical_legacy_material_mismatch", canonicalFieldKey: comparison.canonicalFieldKey, domain: null, severity: "material", title: "Canonical and legacy values differ", summary: `${comparison.canonicalFieldKey} differs materially between canonical and legacy payloads.`, reasonCodes: comparison.reasonCodes, claimIds: [], evidenceIds: [], resolutionStatus: "open", reviewerActionRequired: false });
  }
  args.rejectedProjectionReasons.forEach((reason, index) => findings.push({ findingId: `evidence_integrity_warning:${index}`, type: "evidence_integrity_warning", canonicalFieldKey: null, domain: null, severity: "warning", title: "Projection integrity warning", summary: reason, reasonCodes: ["projection_generation_integrity"], claimIds: [], evidenceIds: [], resolutionStatus: "open", reviewerActionRequired: false }));
  return findings;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

export async function deterministicPayloadHash(payload: Omit<EnterpriseReviewPayload, "payloadHash"> | EnterpriseReviewPayload): Promise<string> {
  const clone = { ...(payload as any) };
  delete clone.payloadHash;
  const encoded = new TextEncoder().encode(JSON.stringify(stable(clone)));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildEnterpriseReviewPayload(args: {
  orgId: string;
  uploadedFileId: string;
  leaseId?: string | null;
  run: any;
  generationId?: string | null;
  sourceMode: EnterpriseReviewPayload["sourceMode"];
  registry: CanonicalReviewFieldDefinition[];
  projectionRows: any[];
  evidenceRows?: any[];
  legacyPayload?: unknown;
  canonicalDocument?: EnterpriseReviewPayload["canonicalDocument"];
  activeOverrides?: any[];
}): Promise<EnterpriseReviewBuildResult> {
  const generationId = args.generationId ?? args.run?.generation_id ?? null;
  const strict = args.sourceMode === "canonical_strict";
  const rejectedProjectionReasons: string[] = [];
  const acceptedRows = args.projectionRows.filter((row) => {
    if (row?.org_id && row.org_id !== args.orgId) {
      rejectedProjectionReasons.push(`Projection ${row.id ?? row.field_key} rejected: wrong org_id.`);
      return false;
    }
    if (row?.uploaded_file_id && row.uploaded_file_id !== args.uploadedFileId) {
      rejectedProjectionReasons.push(`Projection ${row.id ?? row.field_key} rejected: wrong uploaded_file_id.`);
      return false;
    }
    if (row?.run_id && row.run_id !== args.run?.id) {
      rejectedProjectionReasons.push(`Projection ${row.id ?? row.field_key} rejected: wrong run_id.`);
      return false;
    }
    if (row?.generation_id && generationId && row.generation_id !== generationId) {
      rejectedProjectionReasons.push(`Projection ${row.id ?? row.field_key} rejected: wrong generation_id.`);
      return false;
    }
    return true;
  });
  const domainByKey = new Map(args.registry.map((field) => [field.canonicalFieldKey, field.domain]));
  const projections = acceptedRows.map((row) => projectionRowToReadModel(row, { generationId, domain: domainByKey.get(row?.field_key ?? row?.canonical_field_key) ?? null }));
  const projectionsByKey = new Map(projections.map((projection) => [projection.canonicalFieldKey, projection]));
  const legacyPayload = args.legacyPayload ?? null;
  const coverage = buildCanonicalCoverageLedger({ registry: args.registry, projections, legacyPayload, legacyValueResolver: readLegacyFieldValue, strict });
  const parity = buildCanonicalLegacyParity({ registry: args.registry, projections, legacyPayload, legacyValueResolver: readLegacyFieldValue, moduleType: "lease" });
  const coverageByKey = new Map(coverage.entries.map((entry) => [entry.canonicalFieldKey, entry]));
  const overridesByKey = new Map((args.activeOverrides ?? []).filter((row: any) => row?.is_active !== false).map((row: any) => [row.canonical_field_key ?? row.canonicalFieldKey, row]));
  const fields: Record<string, EnterpriseReviewField> = {};
  for (const field of args.registry) {
    const projection = projectionsByKey.get(field.canonicalFieldKey) ?? null;
    const coverageEntry = coverageByKey.get(field.canonicalFieldKey)!;
    const legacyValue = readLegacyFieldValue(field, legacyPayload);
    const override = overridesByKey.get(field.canonicalFieldKey) ?? null;
    let effectiveStatus = coverageEntry.coverageStatus;
    let source = fieldSource({ sourceMode: args.sourceMode, strict, field, projection, coverageStatus: coverageEntry.coverageStatus, legacyValue });
    let value = fieldValueFor({ source, projection, legacyValue });
    let overrideRequiresAttention = false;
    let overrideBlocking = false;
    if (override) {
      source = "reviewer_override";
      const action = override.action ?? "overridden";
      if (action === "accepted") value = projection?.normalizedValue ?? projection?.value ?? value;
      if (action === "overridden") value = override.override_value ?? override.overrideValue ?? value;
      if (action === "cleared") {
        value = null;
        effectiveStatus = field.requiredForApproval ? "missing" : "not_applicable";
        overrideBlocking = Boolean(field.requiredForApproval);
      }
      if (action === "marked_not_applicable") {
        value = null;
        effectiveStatus = "not_applicable";
        overrideBlocking = Boolean(field.requiredForApproval);
      }
      if (action === "needs_followup") overrideRequiresAttention = true;
    }
    const evidence = evidenceReferencesFor(projection, args.evidenceRows ?? []);
    fields[field.canonicalFieldKey] = {
      canonicalFieldKey: field.canonicalFieldKey,
      reviewPath: field.reviewPath,
      domain: field.domain,
      value,
      displayValue: hasValue(value) ? String(value) : projection?.displayValue ?? null,
      status: effectiveStatus,
      confidence: projection?.confidence ?? null,
      authoritativeSource: source,
      evidence,
      derivation: projection?.derivation ?? null,
      conflict: projection?.conflict ?? null,
      review: {
        editable: field.allowReviewerOverride,
        requiresAttention: overrideRequiresAttention || overrideBlocking || coverageEntry.blocking || ["needs_review", "conflict", "missing_source_evidence", "legacy_fallback"].includes(effectiveStatus),
        blocking: override ? overrideBlocking : coverageEntry.blocking,
        reasonCodes: [...coverageEntry.blockingReasons, ...coverageEntry.warningReasons],
      },
    };
  }
  const findings = buildFindings({ coverage, fields, parity, rejectedProjectionReasons });
  const overrideCount = (args.activeOverrides ?? []).filter((row: any) => row?.is_active !== false).length;
  const effectiveFields = Object.values(fields);
  const effectiveBlockingIssueCount = effectiveFields.filter((field: any) => field?.review?.blocking).length;
  const effectiveMissingRequiredCount = args.registry.filter((field) => field.requiredForApproval && fields[field.canonicalFieldKey]?.status === "missing").length;
  const validationSummary = {
    valid: effectiveBlockingIssueCount === 0,
    approvalEligible: args.sourceMode === "legacy" ? true : effectiveBlockingIssueCount === 0,
    blockingIssueCount: effectiveBlockingIssueCount,
    warningCount: findings.filter((finding) => finding.severity === "warning" || finding.severity === "material").length,
    conflictCount: coverage.totals.conflicts,
    missingRequiredCount: effectiveMissingRequiredCount,
    missingEvidenceCount: coverage.totals.missingSourceEvidence,
    fallbackCount: coverage.totals.legacyFallbacks,
    overrideCount,
    reasonCodes: [...new Set(findings.flatMap((finding) => finding.reasonCodes))],
  };
  const payloadWithoutHash = {
    schemaVersion: "enterprise-review-payload-v1" as const,
    uploadedFileId: args.uploadedFileId,
    leaseId: args.leaseId ?? null,
    orgId: args.orgId,
    runId: String(args.run?.id ?? ""),
    generationId,
    sourceMode: args.sourceMode,
    canonicalDocument: args.canonicalDocument ?? { layoutHash: null, layoutSchemaVersion: null, layoutSource: null, geometryAvailable: false },
    fields,
    coverage,
    findings,
    unresolvedConflicts: Object.values(fields).map((field) => field.conflict).filter(Boolean),
    validationSummary,
    compatibility: {
      legacyPayloadAvailable: legacyPayload != null,
      fallbackFieldCount: coverage.totals.legacyFallbacks,
      paritySummary: parity,
    },
  };
  const payloadHash = await deterministicPayloadHash(payloadWithoutHash);
  return {
    payload: { ...payloadWithoutHash, payloadHash },
    authorityReadiness: parity.readiness,
    rejectedProjectionCount: rejectedProjectionReasons.length,
    rejectedProjectionReasons,
  };
}
