// @ts-nocheck
/**
 * Document Intelligence v3 - Temporal and Supersession Diagnostics (Phase 12).
 *
 * Diagnostic-only. This module uses already-persisted v3 claims/projections
 * plus the package graph to identify document ordering, effective periods,
 * candidate supersession, and candidate current truth. It never mutates
 * canonical projections, Lease Review rows, or approval state.
 */

export const SUPERSESSION_TYPES = [
  "amends",
  "extends",
  "replaces",
  "assigns",
  "terminates",
  "renews",
  "clarifies",
  "conflicts_with",
  "unknown",
] as const;

export const SUPERSESSION_STATUSES = [
  "candidate",
  "needs_review",
  "blocked_missing_related_document",
  "confirmed_by_relationship",
  "rejected",
] as const;

const TIMELINE_DATE_PRIORITY = [
  "effective_date",
  "assignment_effective_date",
  "amendment_date",
  "execution_date",
  "lease_date",
  "document_date",
] as const;

const TEMPORAL_FIELD_KEYS = [
  "lease_date",
  "execution_date",
  "effective_date",
  "assignment_effective_date",
  "original_lease_date",
  "commencement_date",
  "expiration_date",
  "original_expiration_date",
  "amended_expiration_date",
  "termination_effective_date",
  "renewal_effective_date",
  "amendment_date",
  "document_date",
] as const;

function text(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return s.length ? s : null;
}

function compact(values: any[]): string[] {
  return [...new Set((values || []).filter((v) => v != null && String(v).trim()).map((v) => String(v).trim()))];
}

function unwrapValue(value: any): any {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("value" in value) return value.value;
    if ("normalized_value" in value) return value.normalized_value;
  }
  return value;
}

function boolValue(value: any): boolean {
  const raw = unwrapValue(value);
  if (raw === true) return true;
  if (typeof raw === "string") return /^(true|yes|y|1)$/i.test(raw.trim());
  return false;
}

function parseDateOnly(value: any): string | null {
  const raw = unwrapValue(value);
  if (raw == null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (us) {
      const [, month, day, year] = us;
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
  }
  return null;
}

function confidenceOf(row: any): number | null {
  const direct = Number(row?.confidence);
  if (Number.isFinite(direct)) return direct;
  const composite = Number(row?.confidence?.composite);
  return Number.isFinite(composite) ? composite : null;
}

function fieldKeyForClaim(claim: any): string | null {
  const objectKey = text(claim?.object?.field_key);
  if (objectKey) return objectKey;
  const candidates = Array.isArray(claim?.canonical_field_candidates) ? claim.canonical_field_candidates : [];
  return text(candidates[0]);
}

function valueForClaim(claim: any): any {
  return claim?.object?.value ?? claim?.object?.label ?? null;
}

function docKeyFor(row: any): string | null {
  return text(row?.source_document_id)
    ?? text(row?.document_id)
    ?? text(row?.uploaded_file_id)
    ?? text(row?.document_intelligence_run_id)
    ?? text(row?.run_id);
}

function makeFieldRows(projections: any[] = [], claims: any[] = []) {
  const rows = [];
  for (const projection of Array.isArray(projections) ? projections : []) {
    rows.push({
      source: "projection",
      field_key: projection.field_key,
      value: unwrapValue(projection.value ?? projection.normalized_value),
      claim_id: Array.isArray(projection.source_claim_ids) ? projection.source_claim_ids[0] ?? null : null,
      source_claim_ids: projection.source_claim_ids ?? [],
      uploaded_file_id: projection.uploaded_file_id ?? null,
      run_id: projection.run_id ?? null,
      document_id: projection.document_id ?? null,
      confidence: confidenceOf(projection),
      extraction_mode: projection.extraction_mode ?? null,
    });
  }
  for (const claim of Array.isArray(claims) ? claims : []) {
    const fieldKey = fieldKeyForClaim(claim);
    if (!fieldKey) continue;
    rows.push({
      source: "claim",
      field_key: fieldKey,
      value: valueForClaim(claim),
      claim_id: claim.id ?? null,
      source_claim_ids: claim.id ? [claim.id] : [],
      uploaded_file_id: claim.uploaded_file_id ?? null,
      run_id: claim.run_id ?? null,
      document_id: claim.document_id ?? null,
      confidence: confidenceOf(claim),
      extraction_mode: claim.extraction_mode ?? null,
    });
  }
  return rows;
}

function groupFieldRowsByDocument(rows: any[]) {
  const byDoc = new Map<string, any[]>();
  for (const row of rows) {
    const key = docKeyFor(row);
    if (!key) continue;
    const list = byDoc.get(key) ?? [];
    list.push(row);
    byDoc.set(key, list);
  }
  return byDoc;
}

function findField(rows: any[], fieldKey: string): any | null {
  return rows.find((row) => row.field_key === fieldKey && row.value != null) ?? null;
}

function findDate(rows: any[], fieldKey: string): string | null {
  const row = findField(rows, fieldKey);
  return row ? parseDateOnly(row.value) : null;
}

function dateSignals(rows: any[], doc: any = {}) {
  const signals: Record<string, string | null> = {};
  for (const fieldKey of TEMPORAL_FIELD_KEYS) {
    signals[fieldKey] = findDate(rows, fieldKey) ?? parseDateOnly(doc?.[fieldKey]);
  }
  return signals;
}

function sortDateFrom(signals: Record<string, string | null>, doc: any) {
  for (const key of TIMELINE_DATE_PRIORITY) {
    if (signals[key]) {
      return { sort_date: signals[key], sort_reason: key, confidence: key === "document_date" ? 0.65 : 0.9 };
    }
  }
  const fallback = text(doc?.created_at) ?? text(doc?.metadata?.created_at);
  if (fallback) return { sort_date: fallback.slice(0, 10), sort_reason: "created_at_fallback", confidence: 0.35 };
  return { sort_date: null, sort_reason: "missing_temporal_date", confidence: 0 };
}

function documentRowsFromPackageGraph(packageGraph: any, run: any = {}) {
  const docs = Array.isArray(packageGraph?.documents) ? packageGraph.documents : [];
  if (docs.length) return docs;
  return [{
    document_id: null,
    uploaded_file_id: run?.uploaded_file_id ?? null,
    run_id: run?.id ?? null,
    document_profile: run?.profile_key ?? null,
    confidence: run?.profile_confidence ?? null,
    metadata: {},
  }];
}

function matchRowsForDocument(allRows: any[], doc: any, fallbackRunId: string | null) {
  const ids = compact([
    doc.document_id,
    doc.uploaded_file_id,
    doc.run_id,
    doc.document_intelligence_run_id,
    fallbackRunId,
  ]);
  return allRows.filter((row) => ids.includes(String(row.document_id ?? "")) || ids.includes(String(row.uploaded_file_id ?? "")) || ids.includes(String(row.run_id ?? "")));
}

function buildTimeline(args: { packageGraph?: any; run?: any; fieldRows?: any[] }) {
  const docs = documentRowsFromPackageGraph(args.packageGraph, args.run);
  const warnings = new Set<string>();
  const timeline = docs.map((doc) => {
    const rows = matchRowsForDocument(args.fieldRows ?? [], doc, args.run?.id ?? null);
    const signals = dateSignals(rows, doc);
    const sort = sortDateFrom(signals, doc);
    const docWarnings = new Set<string>();

    if (!signals.document_date && !signals.lease_date && !signals.execution_date) docWarnings.add("missing_document_date");
    if (!signals.effective_date && !signals.assignment_effective_date && !signals.amendment_date && !signals.termination_effective_date && !signals.renewal_effective_date) {
      docWarnings.add("missing_effective_date");
    }
    if (sort.sort_reason === "created_at_fallback") docWarnings.add("missing_document_date");
    if (signals.expiration_date && signals.amended_expiration_date && signals.expiration_date !== signals.amended_expiration_date) {
      docWarnings.add("date_conflict");
    }

    for (const warning of docWarnings) warnings.add(warning);

    return {
      document_id: doc.document_id ?? null,
      uploaded_file_id: doc.uploaded_file_id ?? null,
      run_id: doc.run_id ?? doc.document_intelligence_run_id ?? (doc.uploaded_file_id === args.run?.uploaded_file_id ? args.run?.id ?? null : null),
      profile_key: doc.document_profile ?? doc.profile_key ?? args.run?.profile_key ?? null,
      document_date: signals.document_date,
      effective_date: signals.effective_date,
      execution_date: signals.execution_date,
      lease_date: signals.lease_date,
      original_lease_date: signals.original_lease_date,
      expiration_date: signals.expiration_date,
      amended_expiration_date: signals.amended_expiration_date,
      sort_date: sort.sort_date,
      sort_reason: sort.sort_reason,
      confidence: doc.confidence ?? sort.confidence,
      warnings: [...docWarnings].sort(),
    };
  }).sort((a, b) => {
    if (!a.sort_date && !b.sort_date) return 0;
    if (!a.sort_date) return 1;
    if (!b.sort_date) return -1;
    return String(a.sort_date).localeCompare(String(b.sort_date));
  });

  for (let i = 1; i < timeline.length; i += 1) {
    if (timeline[i].sort_date && timeline[i].sort_date === timeline[i - 1].sort_date) {
      warnings.add("ambiguous_document_order");
      timeline[i].warnings = compact([...(timeline[i].warnings ?? []), "ambiguous_document_order"]).sort();
      timeline[i - 1].warnings = compact([...(timeline[i - 1].warnings ?? []), "ambiguous_document_order"]).sort();
    }
  }

  return { timeline, warnings: [...warnings].sort() };
}

function originalLeaseMissing(packageGraph: any): boolean {
  const requirements = Array.isArray(packageGraph?.related_document_requirements) ? packageGraph.related_document_requirements : [];
  return requirements.some((requirement) =>
    requirement.required_document_type === "original_lease" &&
    ["missing", "candidate_found"].includes(String(requirement.status ?? "missing"))
  );
}

function hasConfirmedRelationship(packageGraph: any, relationshipTypes: string[]) {
  const relationships = Array.isArray(packageGraph?.relationships) ? packageGraph.relationships : [];
  return relationships.some((relationship) =>
    relationshipTypes.includes(String(relationship.relationship_type)) &&
    relationship.status === "confirmed"
  );
}

function statusForRelatedDependency(packageGraph: any, relationshipTypes: string[]) {
  if (originalLeaseMissing(packageGraph)) return "blocked_missing_related_document";
  if (hasConfirmedRelationship(packageGraph, relationshipTypes)) return "confirmed_by_relationship";
  return "candidate";
}

function candidate(args: {
  supersession_type: string;
  source?: any;
  target?: any;
  sourceDocumentId?: string | null;
  targetDocumentId?: string | null;
  fieldKey?: string | null;
  oldValue?: any;
  newValue?: any;
  effectiveFrom?: string | null;
  confidence?: number | null;
  reason: string;
  status?: string;
}) {
  return {
    supersession_type: args.supersession_type ?? "unknown",
    source_claim_id: args.source?.claim_id ?? null,
    target_claim_id: args.target?.claim_id ?? null,
    source_document_id: args.sourceDocumentId ?? args.source?.document_id ?? null,
    target_document_id: args.targetDocumentId ?? args.target?.document_id ?? null,
    field_key: args.fieldKey ?? args.source?.field_key ?? args.target?.field_key ?? null,
    old_value: args.oldValue ?? args.target?.value ?? null,
    new_value: args.newValue ?? args.source?.value ?? null,
    effective_from: args.effectiveFrom ?? null,
    confidence: args.confidence ?? args.source?.confidence ?? null,
    reason: args.reason,
    status: args.status ?? "candidate",
  };
}

function buildSupersessionCandidates(args: {
  packageGraph?: any;
  fieldRows?: any[];
  timeline?: any[];
  policyKey?: string | null;
}) {
  const packageGraph = args.packageGraph ?? {};
  const rows = Array.isArray(args.fieldRows) ? args.fieldRows : [];
  const policyKey = String(args.policyKey ?? "");
  const warnings = new Set<string>();
  const candidates = [];

  if (policyKey === "unknown_cre_document" || policyKey === "non_cre_document") {
    return { candidates, warnings: [] };
  }

  const assignmentEffective = findDate(rows, "assignment_effective_date");
  const assignor = findField(rows, "assignor_name") ?? findField(rows, "tenant_name");
  const assignee = findField(rows, "assignee_name");
  if (assignmentEffective && (assignor || assignee)) {
    candidates.push(candidate({
      supersession_type: "assigns",
      source: assignee ?? assignor,
      target: assignor,
      fieldKey: "tenant_name",
      oldValue: assignor?.value ?? null,
      newValue: assignee?.value ?? null,
      effectiveFrom: assignmentEffective,
      reason: "assignment_effective_date_with_party_claims",
      status: statusForRelatedDependency(packageGraph, ["original_lease_for", "assigns"]),
    }));
  }

  const amendedExpiration = findDate(rows, "amended_expiration_date");
  if (amendedExpiration) {
    const source = findField(rows, "amended_expiration_date");
    const target = findField(rows, "expiration_date") ?? findField(rows, "original_expiration_date");
    candidates.push(candidate({
      supersession_type: "extends",
      source,
      target,
      fieldKey: "expiration_date",
      oldValue: target?.value ?? null,
      newValue: source?.value ?? amendedExpiration,
      effectiveFrom: findDate(rows, "effective_date") ?? findDate(rows, "amendment_date"),
      reason: "amended_expiration_date_updates_expiration_date",
      status: statusForRelatedDependency(packageGraph, ["original_lease_for", "amends"]),
    }));
  }

  const rentField = findField(rows, "amended_base_rent_for_additional_year")
    ?? findField(rows, "amended_base_rent")
    ?? findField(rows, "amended_monthly_rent");
  if (rentField) {
    candidates.push(candidate({
      supersession_type: "replaces",
      source: rentField,
      target: findField(rows, "monthly_rent") ?? findField(rows, "base_rent"),
      fieldKey: "monthly_rent",
      effectiveFrom: findDate(rows, "effective_date") ?? findDate(rows, "amendment_date"),
      reason: "amended_rent_term_updates_rent_related_field",
      status: statusForRelatedDependency(packageGraph, ["original_lease_for", "amends"]),
    }));
  }

  const terminationEffective = findDate(rows, "termination_effective_date");
  if (terminationEffective) {
    const source = findField(rows, "termination_effective_date");
    candidates.push(candidate({
      supersession_type: "terminates",
      source,
      fieldKey: "lease_status",
      oldValue: "active",
      newValue: "terminated",
      effectiveFrom: terminationEffective,
      reason: "termination_effective_date_updates_lease_status",
      status: "candidate",
    }));
  }

  const renewalEffective = findDate(rows, "renewal_effective_date");
  const renewalTerm = findField(rows, "renewal_term") ?? findField(rows, "renewal_expiration_date");
  if (renewalEffective || renewalTerm) {
    candidates.push(candidate({
      supersession_type: "renews",
      source: renewalTerm ?? findField(rows, "renewal_effective_date"),
      target: findField(rows, "expiration_date"),
      fieldKey: "expiration_date",
      effectiveFrom: renewalEffective ?? findDate(rows, "effective_date"),
      reason: "renewal_term_updates_lease_term",
      status: statusForRelatedDependency(packageGraph, ["original_lease_for", "amends"]),
    }));
  }

  if (boolValue(findField(rows, "all_other_terms_remain_same")?.value)) {
    warnings.add("unchanged_terms_rely_on_original_lease");
  }

  return { candidates, warnings: [...warnings].sort() };
}

function buildEffectivePeriods(fieldRows: any[], timeline: any[]) {
  const docDateByUpload = new Map<string, string>();
  for (const item of timeline) {
    if (item.uploaded_file_id && item.sort_date) docDateByUpload.set(item.uploaded_file_id, item.effective_date ?? item.sort_date);
  }

  return fieldRows
    .filter((row) => row.field_key && row.value != null && !TEMPORAL_FIELD_KEYS.includes(row.field_key))
    .map((row) => {
      const effectiveFrom = parseDateOnly(row.effective_from) ?? docDateByUpload.get(row.uploaded_file_id) ?? null;
      if (!effectiveFrom) return null;
      return {
        subject_type: "field",
        subject_id: row.field_key,
        field_key: row.field_key,
        claim_id: row.claim_id ?? null,
        effective_from: effectiveFrom,
        effective_to: null,
        date_source: docDateByUpload.has(row.uploaded_file_id) ? "document_timeline" : "claim_effective_from",
        confidence: row.confidence ?? null,
        status: "candidate",
      };
    })
    .filter(Boolean);
}

function buildCurrentTruthCandidates(fieldRows: any[], supersessionCandidates: any[]) {
  const rowsByField = new Map<string, any[]>();
  for (const row of fieldRows.filter((r) => r.field_key && r.value != null && !TEMPORAL_FIELD_KEYS.includes(r.field_key))) {
    const list = rowsByField.get(row.field_key) ?? [];
    list.push(row);
    rowsByField.set(row.field_key, list);
  }

  const supersededFields = new Set(supersessionCandidates.map((c) => c.field_key).filter(Boolean));
  const current = [];
  for (const [fieldKey, rows] of rowsByField) {
    const values = compact(rows.map((row) => JSON.stringify(row.value)));
    const status = values.length > 1 && !supersededFields.has(fieldKey) ? "conflict" : "candidate_current";
    const chosen = rows[rows.length - 1];
    current.push({
      field_key: fieldKey,
      candidate_value: chosen.value,
      source_claim_id: chosen.claim_id ?? null,
      source_document_id: chosen.document_id ?? null,
      effective_from: null,
      confidence: chosen.confidence ?? null,
      status,
      reason: status === "conflict" ? "multiple_values_without_temporal_resolution" : "latest_available_claim_candidate",
      blockers: status === "conflict" ? ["manual_temporal_review_required"] : [],
    });
  }

  for (const supersession of supersessionCandidates) {
    if (!supersession.field_key) continue;
    current.push({
      field_key: supersession.field_key,
      candidate_value: supersession.new_value,
      source_claim_id: supersession.source_claim_id,
      source_document_id: supersession.source_document_id,
      effective_from: supersession.effective_from,
      confidence: supersession.confidence,
      status: supersession.status === "blocked_missing_related_document" ? "blocked_missing_related_document" : "candidate_current",
      reason: `supersession_candidate:${supersession.supersession_type}`,
      blockers: supersession.status === "blocked_missing_related_document" ? ["missing_related_document"] : [],
    });
  }

  return current;
}

function temporalStatus(args: {
  timeline: any[];
  supersessionCandidates: any[];
  currentTruthCandidates: any[];
  unresolvedConflicts: any[];
  missingInputs: string[];
}) {
  if (args.unresolvedConflicts.length > 0 || args.currentTruthCandidates.some((c) => c.status === "conflict")) return "conflicts_detected";
  if (args.supersessionCandidates.some((c) => c.status === "blocked_missing_related_document")) return "blocked_missing_related_document";
  if (args.timeline.length === 0) return "no_temporal_data";
  if (args.missingInputs.length > 0) return "needs_review";
  return "timeline_ready";
}

export function buildTemporalSupersessionDiagnostics(args: {
  run?: any;
  claims?: any[];
  projections?: any[];
  packageGraph?: any;
  profileKey?: string | null;
  extractionPlan?: any;
}) {
  const run = args.run ?? {};
  const packageGraph = args.packageGraph ?? {};
  const profileKey = args.profileKey ?? run.profile_key ?? args.extractionPlan?.profile_key ?? null;
  const fieldRows = makeFieldRows(args.projections ?? [], args.claims ?? []);
  const { timeline, warnings: timelineWarnings } = buildTimeline({ packageGraph, run, fieldRows });
  const { candidates: supersessionCandidates, warnings: supersessionWarnings } = buildSupersessionCandidates({
    packageGraph,
    fieldRows,
    timeline,
    policyKey: profileKey,
  });
  const effectivePeriods = buildEffectivePeriods(fieldRows, timeline);
  const currentTruthCandidates = buildCurrentTruthCandidates(fieldRows, supersessionCandidates);
  const unresolvedTemporalConflicts = currentTruthCandidates
    .filter((candidate) => candidate.status === "conflict")
    .map((candidate) => ({
      field_key: candidate.field_key,
      reason: candidate.reason,
      blockers: candidate.blockers,
    }));
  const missingTemporalInputs = compact([
    ...timeline.flatMap((item) => item.warnings ?? []),
    ...(originalLeaseMissing(packageGraph) ? ["original_lease_missing", "related_document_missing"] : []),
  ]);
  const historicalClaims = supersessionCandidates
    .filter((candidate) => candidate.target_claim_id || candidate.old_value != null)
    .map((candidate) => ({
      claim_id: candidate.target_claim_id,
      field_key: candidate.field_key,
      historical_value: candidate.old_value,
      superseded_by_claim_id: candidate.source_claim_id,
      reason: candidate.reason,
      status: "candidate_historical",
    }));

  const warnings = compact([
    ...timelineWarnings,
    ...supersessionWarnings,
    ...(originalLeaseMissing(packageGraph) ? ["original_lease_missing", "related_document_missing"] : []),
  ]);

  return {
    diagnostic_only: true,
    temporal_status: temporalStatus({
      timeline,
      supersessionCandidates,
      currentTruthCandidates,
      unresolvedConflicts: unresolvedTemporalConflicts,
      missingInputs: missingTemporalInputs,
    }),
    document_timeline: timeline,
    effective_periods: effectivePeriods,
    supersession_candidates: supersessionCandidates,
    current_truth_candidates: currentTruthCandidates,
    historical_claims: historicalClaims,
    unresolved_temporal_conflicts: unresolvedTemporalConflicts,
    missing_temporal_inputs: missingTemporalInputs,
    warnings,
  };
}

export function emptyTemporalSupersessionDiagnostics(status = "not_available") {
  return {
    diagnostic_only: true,
    temporal_status: status,
    document_timeline: [],
    effective_periods: [],
    supersession_candidates: [],
    current_truth_candidates: [],
    historical_claims: [],
    unresolved_temporal_conflicts: [],
    missing_temporal_inputs: [],
    warnings: [],
  };
}
