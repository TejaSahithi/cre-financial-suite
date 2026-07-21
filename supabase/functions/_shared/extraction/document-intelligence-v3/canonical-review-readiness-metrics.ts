// @ts-nocheck

export interface DomainReadinessMetrics {
  configuredFieldCount: number;
  resolvedFieldCount: number;
  canonicalCoverageRate: number;
  approvalCriticalFieldCount: number;
  approvalCriticalResolvedCount: number;
  approvalCriticalCoverageRate: number;
  evidenceCoverageRate: number;
  fallbackRate: number;
  conflictRate: number;
  missingSourceEvidenceRate: number;
  invalidProjectionRate: number;
}

export interface CanonicalReviewReadinessMetrics {
  totalRuns: number;
  payloadBuildSuccessRate: number;
  configuredFieldCount: number;
  canonicalCoverageRate: number;
  approvalCriticalCoverageRate: number;
  evidenceCoverageRate: number;
  legacyFallbackRate: number;
  materialMismatchRate: number;
  conflictRate: number;
  missingSourceEvidenceRate: number;
  invalidProjectionRate: number;
  reviewerOverrideRate: number;
  unresolvedBlockingFindingRate: number;
  crossRunIntegrityViolationCount: number;
  crossGenerationIntegrityViolationCount: number;
  byDomain: Record<string, DomainReadinessMetrics>;
}

function safeDiv(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

function entries(payload: any): any[] {
  return Array.isArray(payload?.coverage?.entries) ? payload.coverage.entries : [];
}

function findings(payload: any): any[] {
  return Array.isArray(payload?.findings) ? payload.findings : [];
}

function parityComparisons(payload: any): any[] {
  return Array.isArray(payload?.compatibility?.paritySummary?.comparisons) ? payload.compatibility.paritySummary.comparisons : [];
}

function emptyDomain(): DomainReadinessMetrics {
  return {
    configuredFieldCount: 0,
    resolvedFieldCount: 0,
    canonicalCoverageRate: 0,
    approvalCriticalFieldCount: 0,
    approvalCriticalResolvedCount: 0,
    approvalCriticalCoverageRate: 0,
    evidenceCoverageRate: 0,
    fallbackRate: 0,
    conflictRate: 0,
    missingSourceEvidenceRate: 0,
    invalidProjectionRate: 0,
  };
}

export function buildCanonicalReviewReadinessMetrics(args: {
  runs: any[];
  payloadRows: any[];
  overrideRows?: any[];
}): CanonicalReviewReadinessMetrics {
  const runs = Array.isArray(args.runs) ? args.runs : [];
  const payloadRows = Array.isArray(args.payloadRows) ? args.payloadRows : [];
  const overrideRows = Array.isArray(args.overrideRows) ? args.overrideRows : [];
  const successfulPayloads = payloadRows.filter((row) => row?.payload && row?.payload_hash);
  const allEntries = successfulPayloads.flatMap((row) => entries(row.payload));
  const configuredFieldCount = allEntries.length;
  const resolved = allEntries.filter((entry) => ["resolved", "resolved_with_warning"].includes(entry.coverageStatus));
  const approvalCritical = allEntries.filter((entry) => entry.requiredForApproval);
  const approvalCriticalResolved = approvalCritical.filter((entry) => ["resolved", "resolved_with_warning", "legacy_fallback"].includes(entry.coverageStatus));
  const evidencePresent = allEntries.filter((entry) => entry.evidencePresent || !entry.requiredForApproval);
  const fallbackCount = allEntries.filter((entry) => entry.legacyFallbackUsed || entry.coverageStatus === "legacy_fallback").length;
  const conflicts = allEntries.filter((entry) => entry.coverageStatus === "conflict").length;
  const missingSourceEvidence = allEntries.filter((entry) => entry.coverageStatus === "missing_source_evidence").length;
  const invalid = allEntries.filter((entry) => entry.coverageStatus === "invalid").length;
  const materialMismatches = successfulPayloads.flatMap((row) => parityComparisons(row.payload)).filter((comparison) => comparison.material).length;
  const blockingFindings = successfulPayloads.flatMap((row) => findings(row.payload)).filter((finding) => finding.severity === "blocking" && finding.resolutionStatus !== "resolved").length;
  const integrityViolations = payloadRows.reduce((sum, row) => sum + Number(row?.integrity_violation_count ?? 0), 0);
  const generationViolations = successfulPayloads.filter((row) => row?.payload?.generationId && row?.generation_id && row.payload.generationId !== row.generation_id).length;

  const byDomain: Record<string, DomainReadinessMetrics & { evidencePresentCount?: number; fallbackCount?: number; conflictCount?: number; missingEvidenceCount?: number; invalidCount?: number }> = {};
  for (const entry of allEntries) {
    const domain = entry.domain || "unknown";
    byDomain[domain] ??= { ...emptyDomain(), evidencePresentCount: 0, fallbackCount: 0, conflictCount: 0, missingEvidenceCount: 0, invalidCount: 0 };
    const d = byDomain[domain];
    d.configuredFieldCount += 1;
    if (["resolved", "resolved_with_warning"].includes(entry.coverageStatus)) d.resolvedFieldCount += 1;
    if (entry.requiredForApproval) d.approvalCriticalFieldCount += 1;
    if (entry.requiredForApproval && ["resolved", "resolved_with_warning", "legacy_fallback"].includes(entry.coverageStatus)) d.approvalCriticalResolvedCount += 1;
    if (entry.evidencePresent || !entry.requiredForApproval) d.evidencePresentCount! += 1;
    if (entry.legacyFallbackUsed || entry.coverageStatus === "legacy_fallback") d.fallbackCount! += 1;
    if (entry.coverageStatus === "conflict") d.conflictCount! += 1;
    if (entry.coverageStatus === "missing_source_evidence") d.missingEvidenceCount! += 1;
    if (entry.coverageStatus === "invalid") d.invalidCount! += 1;
  }

  const finalizedDomains = Object.fromEntries(Object.entries(byDomain).map(([domain, d]) => [domain, {
    configuredFieldCount: d.configuredFieldCount,
    resolvedFieldCount: d.resolvedFieldCount,
    canonicalCoverageRate: safeDiv(d.resolvedFieldCount, d.configuredFieldCount),
    approvalCriticalFieldCount: d.approvalCriticalFieldCount,
    approvalCriticalResolvedCount: d.approvalCriticalResolvedCount,
    approvalCriticalCoverageRate: safeDiv(d.approvalCriticalResolvedCount, d.approvalCriticalFieldCount),
    evidenceCoverageRate: safeDiv(d.evidencePresentCount ?? 0, d.configuredFieldCount),
    fallbackRate: safeDiv(d.fallbackCount ?? 0, d.configuredFieldCount),
    conflictRate: safeDiv(d.conflictCount ?? 0, d.configuredFieldCount),
    missingSourceEvidenceRate: safeDiv(d.missingEvidenceCount ?? 0, d.configuredFieldCount),
    invalidProjectionRate: safeDiv(d.invalidCount ?? 0, d.configuredFieldCount),
  }])) as Record<string, DomainReadinessMetrics>;

  return {
    totalRuns: runs.length,
    payloadBuildSuccessRate: safeDiv(successfulPayloads.length, Math.max(runs.length, payloadRows.length)),
    configuredFieldCount,
    canonicalCoverageRate: safeDiv(resolved.length, configuredFieldCount),
    approvalCriticalCoverageRate: safeDiv(approvalCriticalResolved.length, approvalCritical.length),
    evidenceCoverageRate: safeDiv(evidencePresent.length, configuredFieldCount),
    legacyFallbackRate: safeDiv(fallbackCount, configuredFieldCount),
    materialMismatchRate: safeDiv(materialMismatches, configuredFieldCount),
    conflictRate: safeDiv(conflicts, configuredFieldCount),
    missingSourceEvidenceRate: safeDiv(missingSourceEvidence, configuredFieldCount),
    invalidProjectionRate: safeDiv(invalid, configuredFieldCount),
    reviewerOverrideRate: safeDiv(overrideRows.length, configuredFieldCount),
    unresolvedBlockingFindingRate: safeDiv(blockingFindings, configuredFieldCount),
    crossRunIntegrityViolationCount: integrityViolations,
    crossGenerationIntegrityViolationCount: generationViolations,
    byDomain: finalizedDomains,
  };
}