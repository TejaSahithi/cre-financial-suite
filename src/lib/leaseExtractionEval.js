import { LEASE_FIELD_CONTRACT, resolveCanonicalFieldKey, getFieldContract } from "./leaseFieldContract.js";

export const FIXTURE_VERSION = "lease-ground-truth/1.0";
export const REPORT_VERSION = "lease-extraction-eval-report/1.0";
export const FAILURE_STAGES = ["azure_ocr","document_normalization","section_segmentation","retrieval","rule_extraction","table_extraction","llm_extraction","normalization","semantic_validation","candidate_decision","merge","canonical_mapping","payload_generation","frontend_resolution","approval_validation","unknown"];
export const LEVEL_1_THRESHOLDS = { unsupportedCriticalAutoFillsMaxIncrease: 0, duplicateCanonicalRowsMax: 0, wrongDomainCriticalEvidenceMax: 0 };
export const LEVEL_2_TARGET_THRESHOLDS = { minimumFixtureCount: 12, minimumPropertyTypes: 4, minimumDocumentTypes: 5, f1Min: 0.95, criticalPrecisionMin: 0.98, unsupportedCriticalAutoFillsMax: 0, duplicateCanonicalRowsMax: 0, wrongDomainCriticalEvidenceMax: 0 };

const CANONICAL_KEYS = new Set(LEASE_FIELD_CONTRACT.map((entry) => entry.canonicalKey));
const VALUE_EXPECTATIONS = new Set(["value"]);
const ABSTENTION_EXPECTATIONS = new Set(["not_stated", "not_applicable", "insufficient_evidence"]);
const CONFLICT_STATUSES = new Set(["conflict", "conflict_detected", "has_conflict"]);
const ABSTENTION_STATUSES = new Set(["not_stated", "not_found", "missing", "not_applicable", "insufficient_evidence", "missing_source_evidence"]);
const AUTO_STATUSES = new Set(["extracted", "derived", "auto_populated", "resolved", "accepted", "approved", "modified", "source_backed"]);

const arr = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
const lower = (value) => String(value ?? "").toLowerCase();
const includes = (text, needle) => lower(text).includes(lower(needle));
const identityOf = (field) => `${field.scopeKey ?? "lease"}:${field.canonicalFieldKey}`;

export function normalizeScalar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase().replace(/[,$]/g, "").replace(/\bapproximately\b|\bapprox\.?\b/g, "").replace(/\bsquare feet\b|\bsq\.\s*ft\.?\b|\bsf\b/g, "sqft").replace(/\s+/g, " ").trim();
  return /^\$?\d+(?:\.\d+)?$/.test(text) ? Number(text) : text;
}

function normalizeDate(value) {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

function normalizeMoney(value) {
  const num = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(num) ? Number(num.toFixed(2)) : null;
}

function normalizeEnum(value) {
  return value == null ? null : String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeForComparison(value, fieldKey) {
  const key = lower(fieldKey);
  if (/date|expiration|commencement|deadline/.test(key)) return normalizeDate(value) ?? normalizeScalar(value);
  if (/rent|deposit|amount|fee|premium|cost|limit|gross_up_threshold|cam_cap_pct|admin_fee_pct|square_footage|rsf/.test(key)) return normalizeMoney(value) ?? normalizeScalar(value);
  if (/responsibility|lease_type|status|frequency|type|method|cap/.test(key)) return normalizeEnum(value);
  return normalizeScalar(value);
}

export function valuesMatch(expected, actual, field = {}) {
  const expectedValues = field && Object.prototype.hasOwnProperty.call(field, "normalizedValue") ? [field.normalizedValue, ...(field.acceptedAlternativeValues || [])] : [expected];
  const actualNorm = normalizeForComparison(actual, field.canonicalFieldKey);
  return expectedValues.some((candidate) => normalizeForComparison(candidate, field.canonicalFieldKey) === actualNorm);
}

export function validateLeaseGroundTruthFixture(fixture) {
  const errors = [];
  if (!fixture || typeof fixture !== "object") return ["Fixture must be an object."];
  if (fixture.fixtureVersion !== FIXTURE_VERSION) errors.push(`fixtureVersion must be ${FIXTURE_VERSION}.`);
  for (const key of ["fixtureId", "documentName", "documentType", "propertyType", "sourceFile", "adjudication"]) if (fixture[key] === undefined || fixture[key] === null || fixture[key] === "") errors.push(`Missing required fixture key: ${key}.`);
  if (!arr(fixture.expectedFields).length) errors.push("expectedFields must contain at least one field.");
  const seen = new Set();
  for (const field of arr(fixture.expectedFields)) {
    const canonicalFieldKey = resolveCanonicalFieldKey(field.canonicalFieldKey);
    if (!CANONICAL_KEYS.has(canonicalFieldKey)) errors.push(`Unknown canonical field key: ${field.canonicalFieldKey}.`);
    if (!["value", "not_stated", "not_applicable", "insufficient_evidence", "conflict"].includes(field.expectation)) errors.push(`Invalid expectation for ${field.canonicalFieldKey}: ${field.expectation}.`);
    const identity = `${field.scopeKey ?? "lease"}:${canonicalFieldKey}`;
    if (seen.has(identity)) errors.push(`Duplicate ground-truth field identity: ${identity}.`);
    seen.add(identity);
    if (field.expectation === "value" && (field.normalizedValue === undefined || field.normalizedValue === null || field.normalizedValue === "")) errors.push(`Value expectation requires normalizedValue: ${identity}.`);
  }
  return errors;
}

function actualFieldKey(field) {
  return resolveCanonicalFieldKey(field.canonical_field_key ?? field.canonicalFieldKey ?? field.field_key ?? field.fieldKey ?? field.key);
}
function actualScope(field) { return field.scope_key ?? field.scopeKey ?? "lease"; }
function actualStatus(field) { return lower(field?.canonical_status ?? field?.canonicalStatus ?? field?.extraction_status ?? field?.extractionStatus ?? field?.status); }
function actualValue(field) { return field?.authoritative_value ?? field?.normalized_value ?? field?.normalizedValue ?? field?.value ?? field?.display_value ?? field?.displayValue ?? null; }

function normalizeEvidence(raw) {
  const ev = raw && typeof raw === "object" ? raw : {};
  const text = ev.source_text ?? ev.sourceText ?? ev.source_clause ?? ev.sourceClause ?? ev.exact_source_text ?? ev.snippet ?? "";
  return { page: ev.page ?? ev.pageNumber ?? ev.page_number ?? ev.source_page ?? ev.sourcePage ?? null, text: String(text ?? ""), clauseCategory: ev.clause_category ?? ev.clauseCategory ?? ev.fact_category ?? ev.factCategory ?? ev.category ?? null };
}

function actualEvidence(field) {
  const evidence = [];
  for (const ev of arr(field?.evidence)) evidence.push(normalizeEvidence(ev));
  if (field?.evidence && !Array.isArray(field.evidence) && typeof field.evidence === "object") evidence.push(normalizeEvidence(field.evidence));
  const inline = normalizeEvidence(field || {});
  if (inline.text || inline.page !== null || inline.clauseCategory) evidence.push(inline);
  const unique = new Map();
  for (const ev of evidence) unique.set(`${ev.page ?? ""}|${ev.text}|${ev.clauseCategory ?? ""}`, ev);
  return [...unique.values()];
}

export function extractActualFields(actual) {
  const fields = [];
  const push = (field) => {
    if (!field || typeof field !== "object") return;
    const canonicalFieldKey = actualFieldKey(field);
    if (!canonicalFieldKey) return;
    fields.push({ ...field, canonicalFieldKey, scopeKey: actualScope(field), value: actualValue(field), status: actualStatus(field), evidence: actualEvidence(field) });
  };
  if (actual?.fields && !Array.isArray(actual.fields)) for (const [key, value] of Object.entries(actual.fields)) push({ field_key: key, ...(value && typeof value === "object" ? value : { value }) });
  for (const record of arr(actual?.records ?? actual?.rows)) {
    for (const field of arr(record?.standard_fields ?? record?.standardFields)) push(field);
    for (const field of arr(record?.custom_fields ?? record?.customFields)) push(field);
    if (record?.fields && !Array.isArray(record.fields)) for (const [key, value] of Object.entries(record.fields)) push({ field_key: key, ...(value && typeof value === "object" ? value : { value }) });
  }
  for (const field of arr(actual?.standard_fields ?? actual?.standardFields)) push(field);
  return fields;
}

export function findDuplicateCanonicalRows(actualFields) {
  const counts = new Map();
  for (const field of actualFields) {
    const key = `${field.scopeKey ?? "lease"}:${field.canonicalFieldKey}`;
    const list = counts.get(key) || [];
    list.push(field);
    counts.set(key, list);
  }
  return [...counts.entries()].filter(([, list]) => list.length > 1).map(([identity, list]) => ({ identity, count: list.length, fieldKeys: list.map((item) => item.field_key ?? item.fieldKey ?? item.canonicalFieldKey) }));
}

function evidenceScore(expectedField, actualField) {
  const expected = arr(expectedField.expectedEvidence);
  const actual = actualField ? arr(actualField.evidence) : [];
  if (!expected.length) return { status: "not_required", correct: true, missing: false, wrongDomain: false, details: [] };
  if (!actual.length) return { status: "missing", correct: false, missing: true, wrongDomain: false, details: expected.map((item) => ({ expected: item, reason: "No actual evidence." })) };
  const details = [];
  let anyCorrect = false;
  let wrongDomain = false;
  for (const exp of expected) {
    const pageMatches = actual.filter((ev) => exp.page == null || Number(ev.page) === Number(exp.page));
    const candidates = pageMatches.length ? pageMatches : actual;
    const matched = candidates.some((ev) => {
      const anyOk = !exp.requiredTextAny?.length || exp.requiredTextAny.some((needle) => includes(ev.text, needle));
      const allOk = !exp.requiredTextAll?.length || exp.requiredTextAll.every((needle) => includes(ev.text, needle));
      const forbiddenOk = !exp.forbiddenText?.length || exp.forbiddenText.every((needle) => !includes(ev.text, needle));
      const categoryOk = !exp.clauseCategory || !ev.clauseCategory || String(ev.clauseCategory) === String(exp.clauseCategory);
      if (!categoryOk || !forbiddenOk) wrongDomain = true;
      return anyOk && allOk && forbiddenOk && categoryOk;
    });
    details.push({ expected: exp, matched });
    if (matched) anyCorrect = true;
  }
  return { status: anyCorrect && !wrongDomain ? "correct" : wrongDomain ? "wrong_domain" : "missing_or_wrong_span", correct: anyCorrect && !wrongDomain, missing: false, wrongDomain, details };
}

function isAutomaticallyExtracted(field) {
  if (!field) return false;
  if (field.accepted === true || field.review_status === "accepted" || field.reviewStatus === "accepted") return true;
  const status = actualStatus(field);
  if (CONFLICT_STATUSES.has(status) || ABSTENTION_STATUSES.has(status)) return false;
  if (field.requires_review === true || field.requiresReview === true) return false;
  const value = actualValue(field);
  return AUTO_STATUSES.has(status) || (value !== null && value !== undefined && value !== "");
}

function expectationMatchesStatus(expected, actual) {
  const status = actualStatus(actual);
  if (expected.expectation === "conflict") return CONFLICT_STATUSES.has(status);
  if (ABSTENTION_EXPECTATIONS.has(expected.expectation)) return ABSTENTION_STATUSES.has(status) || actualValue(actual) === null || actualValue(actual) === "";
  return isAutomaticallyExtracted(actual);
}

function domainForField(fieldKey) {
  const group = getFieldContract(fieldKey)?.group || "unknown";
  return { property_premises: "parties_and_premises", parties: "parties_and_premises", term_dates: "dates_and_term", rent_charges: "rent_and_charges", expenses_recoveries: "expense_recovery_and_cam", cam_rules: "expense_recovery_and_cam", taxes: "taxes", insurance: "insurance", utilities: "utilities", repairs_maintenance: "repairs", legal_options: "assignment_and_transfer", critical_dates: "critical_dates" }[group] || group;
}

function classifyFailureStage({ expectedField, actualField, valueCorrect, statusCorrect, evScore }) {
  if (!actualField) return { stage: "retrieval", reason: "No canonical field row was produced for this ground-truth fact." };
  if (!statusCorrect) return { stage: "payload_generation", reason: `Actual status '${actualStatus(actualField)}' did not match expectation '${expectedField.expectation}'.` };
  if (!valueCorrect) return { stage: "normalization", reason: "Canonical field was present but normalized value did not match adjudicated value." };
  if (evScore.wrongDomain) return { stage: "semantic_validation", reason: "Value matched but evidence came from a forbidden or wrong legal domain." };
  if (evScore.missing || !evScore.correct) return { stage: "retrieval", reason: "Value matched but evidence was missing or did not satisfy page/text expectations." };
  return null;
}

function emptyMetrics() {
  return { supportedGroundTruthFacts: 0, truePositiveFacts: 0, falsePositiveFacts: 0, falseNegativeFacts: 0, correctAbstentions: 0, incorrectAbstentions: 0, correctlyDetectedConflicts: 0, missedConflicts: 0, falseConflicts: 0, duplicateCanonicalRows: 0, wrongDomainEvidenceFacts: 0, missingEvidenceFacts: 0, unsupportedCriticalAutoFills: 0, precision: 0, recall: 0, f1: 0, criticalPrecision: 0, criticalRecall: 0, criticalF1: 0, normalizedValueExactMatchRate: 0, semanticScopeAccuracy: 0, canonicalMappingAccuracy: 0, evidenceAccuracy: 0, conflictDetectionAccuracy: 0, abstentionAccuracy: 0 };
}
function emptyCounters() { return { valueEvaluated: 0, valueCorrect: 0, semanticEvaluated: 0, semanticCorrect: 0, mappingEvaluated: 0, mappingCorrect: 0, evidenceEvaluated: 0, evidenceCorrect: 0, conflictEvaluated: 0, conflictCorrect: 0, abstentionEvaluated: 0, abstentionCorrect: 0, criticalSupported: 0, criticalExtracted: 0, criticalTruePositive: 0 }; }
function finalizeMetrics(metrics, counters) {
  const pDen = metrics.truePositiveFacts + metrics.falsePositiveFacts;
  metrics.precision = pDen ? metrics.truePositiveFacts / pDen : 1;
  metrics.recall = metrics.supportedGroundTruthFacts ? metrics.truePositiveFacts / metrics.supportedGroundTruthFacts : 1;
  metrics.f1 = metrics.precision + metrics.recall ? (2 * metrics.precision * metrics.recall) / (metrics.precision + metrics.recall) : 0;
  metrics.criticalPrecision = counters.criticalExtracted ? counters.criticalTruePositive / counters.criticalExtracted : 1;
  metrics.criticalRecall = counters.criticalSupported ? counters.criticalTruePositive / counters.criticalSupported : 1;
  metrics.criticalF1 = metrics.criticalPrecision + metrics.criticalRecall ? (2 * metrics.criticalPrecision * metrics.criticalRecall) / (metrics.criticalPrecision + metrics.criticalRecall) : 0;
  metrics.normalizedValueExactMatchRate = counters.valueEvaluated ? counters.valueCorrect / counters.valueEvaluated : 1;
  metrics.semanticScopeAccuracy = counters.semanticEvaluated ? counters.semanticCorrect / counters.semanticEvaluated : 1;
  metrics.canonicalMappingAccuracy = counters.mappingEvaluated ? counters.mappingCorrect / counters.mappingEvaluated : 1;
  metrics.evidenceAccuracy = counters.evidenceEvaluated ? counters.evidenceCorrect / counters.evidenceEvaluated : 1;
  metrics.conflictDetectionAccuracy = counters.conflictEvaluated ? counters.conflictCorrect / counters.conflictEvaluated : 1;
  metrics.abstentionAccuracy = counters.abstentionEvaluated ? counters.abstentionCorrect / counters.abstentionEvaluated : 1;
  return metrics;
}

function addDomain(domainMetrics, domain, metricsDelta, countersDelta) {
  const bucket = domainMetrics[domain] || { ...emptyMetrics(), _counters: emptyCounters() };
  for (const [key, value] of Object.entries(metricsDelta)) bucket[key] = (bucket[key] || 0) + value;
  for (const [key, value] of Object.entries(countersDelta)) bucket._counters[key] = (bucket._counters[key] || 0) + value;
  domainMetrics[domain] = bucket;
}

function scoreForbiddenExtraction(forbidden, actualFields) {
  const matches = [];
  const hasMatchConstraint = forbidden.forbiddenValue !== undefined || forbidden.forbiddenEvidenceCategory || forbidden.displayedLabel;
  if (!hasMatchConstraint) return matches;
  for (const field of actualFields) {
    if (forbidden.canonicalFieldKey && field.canonicalFieldKey !== resolveCanonicalFieldKey(forbidden.canonicalFieldKey)) continue;
    if (forbidden.displayedLabel && !includes(field.label ?? field.displayLabel ?? field.field_key, forbidden.displayedLabel)) continue;
    if (forbidden.forbiddenValue !== undefined && !valuesMatch(forbidden.forbiddenValue, actualValue(field), { normalizedValue: forbidden.forbiddenValue, canonicalFieldKey: forbidden.canonicalFieldKey })) continue;
    if (forbidden.forbiddenEvidenceCategory) {
      const hasCategory = arr(field.evidence).some((ev) => ev.clauseCategory === forbidden.forbiddenEvidenceCategory || includes(ev.text, forbidden.forbiddenEvidenceCategory));
      if (!hasCategory) continue;
    }
    if (isAutomaticallyExtracted(field)) matches.push({ field, forbidden });
  }
  return matches;
}

export function scoreLeaseExtraction({ fixture, actual, runMode = "replay", baseline = null } = {}) {
  const validationErrors = validateLeaseGroundTruthFixture(fixture);
  if (validationErrors.length) throw new Error(`Invalid lease ground-truth fixture:\n${validationErrors.join("\n")}`);
  const actualFields = extractActualFields(actual || {});
  const actualIndex = new Map();
  for (const field of actualFields) {
    const key = `${field.scopeKey ?? "lease"}:${field.canonicalFieldKey}`;
    if (!actualIndex.has(key)) actualIndex.set(key, []);
    actualIndex.get(key).push(field);
  }
  const duplicateCanonicalRows = findDuplicateCanonicalRows(actualFields);
  const metrics = emptyMetrics();
  const counters = emptyCounters();
  const domainMetrics = {};
  const fieldResults = [];
  const unsupportedExtractions = [];
  const missedExtractions = [];
  const wrongEvidence = [];
  const failureStages = [];

  for (const expectedField of fixture.expectedFields) {
    const canonicalFieldKey = resolveCanonicalFieldKey(expectedField.canonicalFieldKey);
    const expected = { ...expectedField, canonicalFieldKey };
    const identity = identityOf(expected);
    const actualField = (actualIndex.get(identity) || [])[0] || null;
    const domain = expected.domain || domainForField(canonicalFieldKey);
    const supportedValueFact = VALUE_EXPECTATIONS.has(expected.expectation);
    const metricsDelta = {};
    const countersDelta = {};
    const bumpMetric = (key) => { metrics[key] += 1; metricsDelta[key] = (metricsDelta[key] || 0) + 1; };
    const bumpCounter = (key) => { counters[key] += 1; countersDelta[key] = (countersDelta[key] || 0) + 1; };

    if (supportedValueFact) {
      bumpMetric("supportedGroundTruthFacts");
      bumpCounter("valueEvaluated");
      bumpCounter("mappingEvaluated");
      if (expected.criticality === "critical") bumpCounter("criticalSupported");
    }
    if (expected.expectation === "conflict") bumpCounter("conflictEvaluated");
    if (ABSTENTION_EXPECTATIONS.has(expected.expectation)) bumpCounter("abstentionEvaluated");

    const statusCorrect = actualField ? expectationMatchesStatus(expected, actualField) : ABSTENTION_EXPECTATIONS.has(expected.expectation);
    const valueCorrect = supportedValueFact && actualField ? valuesMatch(expected.normalizedValue, actualValue(actualField), expected) : false;
    const evScore = evidenceScore(expected, actualField);
    if (actualField && isAutomaticallyExtracted(actualField) && expected.criticality === "critical") bumpCounter("criticalExtracted");

    if (supportedValueFact && valueCorrect) {
      bumpMetric("truePositiveFacts");
      bumpCounter("valueCorrect");
      bumpCounter("mappingCorrect");
      if (evScore.correct) bumpCounter("evidenceCorrect");
      if (expected.criticality === "critical") bumpCounter("criticalTruePositive");
    } else if (supportedValueFact) {
      bumpMetric("falseNegativeFacts");
      missedExtractions.push({ identity, expectedValue: expected.normalizedValue, actualValue: actualField ? actualValue(actualField) : null, criticality: expected.criticality, domain });
    }

    if (actualField && isAutomaticallyExtracted(actualField) && (!supportedValueFact || !valueCorrect)) {
      bumpMetric("falsePositiveFacts");
      if (expected.criticality === "critical") bumpMetric("unsupportedCriticalAutoFills");
      unsupportedExtractions.push({ identity, actualValue: actualValue(actualField), reason: supportedValueFact ? "Wrong value for supported fact." : `Expected ${expected.expectation}, but value was auto-filled.`, criticality: expected.criticality, domain });
    }
    if (expected.expectation === "conflict") {
      if (statusCorrect) { bumpMetric("correctlyDetectedConflicts"); bumpCounter("conflictCorrect"); }
      else bumpMetric("missedConflicts");
    }
    if (ABSTENTION_EXPECTATIONS.has(expected.expectation)) {
      if (statusCorrect) { bumpMetric("correctAbstentions"); bumpCounter("abstentionCorrect"); }
      else bumpMetric("incorrectAbstentions");
    }
    if (actualField && CONFLICT_STATUSES.has(actualStatus(actualField)) && expected.expectation !== "conflict") bumpMetric("falseConflicts");
    if (expected.expectedEvidence?.length) bumpCounter("evidenceEvaluated");
    if (evScore.wrongDomain) { bumpMetric("wrongDomainEvidenceFacts"); wrongEvidence.push({ identity, domain, evidenceStatus: evScore.status, details: evScore.details }); }
    else if (expected.expectedEvidence?.length && !evScore.correct) bumpMetric("missingEvidenceFacts");
    bumpCounter("semanticEvaluated");
    if (evScore.correct || !expected.expectedEvidence?.length) bumpCounter("semanticCorrect");

    const failure = classifyFailureStage({ expectedField: expected, actualField, valueCorrect: supportedValueFact ? valueCorrect : true, statusCorrect, evScore });
    if (failure) failureStages.push({ identity, domain, ...failure });
    fieldResults.push({ identity, canonicalFieldKey, domain, expected: expected.expectation, expectedValue: expected.normalizedValue, actualValue: actualField ? actualValue(actualField) : null, status: actualField ? actualStatus(actualField) : "missing", valueCorrect: supportedValueFact ? valueCorrect : null, evidenceStatus: evScore.status, failureStage: failure?.stage ?? null, criticality: expected.criticality });
    addDomain(domainMetrics, domain, metricsDelta, countersDelta);
  }

  const truthIdentities = new Set(fixture.expectedFields.map((field) => identityOf({ ...field, canonicalFieldKey: resolveCanonicalFieldKey(field.canonicalFieldKey) })));
  for (const field of actualFields) {
    const identity = `${field.scopeKey ?? "lease"}:${field.canonicalFieldKey}`;
    if (!truthIdentities.has(identity) && isAutomaticallyExtracted(field)) {
      metrics.falsePositiveFacts += 1;
      unsupportedExtractions.push({ identity, actualValue: actualValue(field), reason: "Auto-filled canonical field is not represented in ground truth.", criticality: "medium", domain: domainForField(field.canonicalFieldKey) });
    }
  }

  const forbiddenMatches = [];
  for (const forbidden of arr(fixture.forbiddenExtractions)) forbiddenMatches.push(...scoreForbiddenExtraction(forbidden, actualFields));
  for (const match of forbiddenMatches) {
    if (match.forbidden.severity === "critical") metrics.unsupportedCriticalAutoFills += 1;
    unsupportedExtractions.push({ identity: `${match.field.scopeKey ?? "lease"}:${match.field.canonicalFieldKey}`, actualValue: actualValue(match.field), reason: match.forbidden.reason, criticality: match.forbidden.severity, domain: domainForField(match.field.canonicalFieldKey), forbidden: true });
  }

  metrics.duplicateCanonicalRows = duplicateCanonicalRows.length;
  finalizeMetrics(metrics, counters);
  for (const bucket of Object.values(domainMetrics)) finalizeMetrics(bucket, bucket._counters);
  for (const bucket of Object.values(domainMetrics)) delete bucket._counters;
  return { schemaVersion: REPORT_VERSION, fixtureId: fixture.fixtureId, documentName: fixture.documentName, runMode, measuredFromLiveExtraction: runMode === "live", corpusSufficiency: "insufficient_for_level_2_target_gate", metrics, metricsByDomain: domainMetrics, fieldResults, unsupportedExtractions, missedExtractions, wrongEvidence, duplicateCanonicalRows, forbiddenMatches: forbiddenMatches.map((match) => ({ fieldKey: match.field.canonicalFieldKey, value: actualValue(match.field), reason: match.forbidden.reason, severity: match.forbidden.severity })), expectedApprovalBlockers: fixture.expectedApprovalBlockers || [], actualApprovalBlockers: actual?.approval_blockers ?? actual?.approvalBlockers ?? actual?.metadata?.approval_blockers ?? [], failureStages, thresholdResults: evaluateRegressionThresholds(metrics, { baseline, fixtureCount: 1, propertyTypes: [fixture.propertyType], documentTypes: [fixture.documentType] }) };
}

export function aggregateLeaseExtractionReports(reports, options = {}) {
  const aggregate = emptyMetrics();
  const counters = emptyCounters();
  const domains = {};
  for (const report of reports) {
    for (const key of ["supportedGroundTruthFacts","truePositiveFacts","falsePositiveFacts","falseNegativeFacts","correctAbstentions","incorrectAbstentions","correctlyDetectedConflicts","missedConflicts","falseConflicts","duplicateCanonicalRows","wrongDomainEvidenceFacts","missingEvidenceFacts","unsupportedCriticalAutoFills"]) aggregate[key] += report.metrics[key] || 0;
    for (const field of report.fieldResults) {
      if (field.expected === "value") { counters.valueEvaluated += 1; counters.mappingEvaluated += 1; if (field.valueCorrect) { counters.valueCorrect += 1; counters.mappingCorrect += 1; } if (field.criticality === "critical") { counters.criticalSupported += 1; if (field.actualValue !== null && field.actualValue !== undefined && field.actualValue !== "") counters.criticalExtracted += 1; if (field.valueCorrect) counters.criticalTruePositive += 1; } }
      counters.semanticEvaluated += 1; if (!field.failureStage || field.failureStage !== "semantic_validation") counters.semanticCorrect += 1;
      if (field.evidenceStatus !== "not_required") { counters.evidenceEvaluated += 1; if (field.evidenceStatus === "correct") counters.evidenceCorrect += 1; }
      if (field.expected === "conflict") { counters.conflictEvaluated += 1; if (field.status === "conflict") counters.conflictCorrect += 1; }
      if (["not_stated", "not_applicable", "insufficient_evidence"].includes(field.expected)) { counters.abstentionEvaluated += 1; if (ABSTENTION_STATUSES.has(field.status)) counters.abstentionCorrect += 1; }
    }
    for (const [domain, metrics] of Object.entries(report.metricsByDomain || {})) domains[domain] = metrics;
  }
  finalizeMetrics(aggregate, counters);
  const propertyTypes = options.propertyTypes || [];
  const documentTypes = options.documentTypes || [];
  return { schemaVersion: REPORT_VERSION, generatedAt: new Date().toISOString(), runMode: options.runMode || "replay", selectedFixtureCount: reports.length, corpusSufficiency: reports.length >= LEVEL_2_TARGET_THRESHOLDS.minimumFixtureCount ? "candidate_for_level_2_review" : "insufficient_for_level_2_target_gate", metrics: aggregate, metricsByDomain: domains, documents: reports, thresholdResults: evaluateRegressionThresholds(aggregate, { baseline: options.baseline, fixtureCount: reports.length, propertyTypes, documentTypes }) };
}

export function evaluateRegressionThresholds(metrics, context = {}) {
  const baseline = context.baseline?.metrics || context.baseline || null;
  const propertyTypes = new Set(context.propertyTypes || []);
  const documentTypes = new Set(context.documentTypes || []);
  const corpusReady = (context.fixtureCount || 0) >= LEVEL_2_TARGET_THRESHOLDS.minimumFixtureCount && propertyTypes.size >= LEVEL_2_TARGET_THRESHOLDS.minimumPropertyTypes && documentTypes.size >= LEVEL_2_TARGET_THRESHOLDS.minimumDocumentTypes;
  return [
    { level: 1, name: "unsupportedCriticalAutoFillsNotIncrease", passed: metrics.unsupportedCriticalAutoFills <= (baseline ? baseline.unsupportedCriticalAutoFills : 0), actual: metrics.unsupportedCriticalAutoFills, threshold: baseline ? baseline.unsupportedCriticalAutoFills : 0, operator: "<=" },
    { level: 1, name: "duplicateCanonicalRowsZero", passed: metrics.duplicateCanonicalRows <= LEVEL_1_THRESHOLDS.duplicateCanonicalRowsMax, actual: metrics.duplicateCanonicalRows, threshold: LEVEL_1_THRESHOLDS.duplicateCanonicalRowsMax, operator: "<=" },
    { level: 1, name: "wrongDomainCriticalEvidenceZero", passed: metrics.wrongDomainEvidenceFacts <= LEVEL_1_THRESHOLDS.wrongDomainCriticalEvidenceMax, actual: metrics.wrongDomainEvidenceFacts, threshold: LEVEL_1_THRESHOLDS.wrongDomainCriticalEvidenceMax, operator: "<=" },
    { level: 1, name: "criticalPrecisionNotDecrease", passed: !baseline || metrics.criticalPrecision >= baseline.criticalPrecision, actual: metrics.criticalPrecision, threshold: baseline?.criticalPrecision ?? metrics.criticalPrecision, operator: ">=" },
    { level: 2, enabled: corpusReady, name: "overallF1Target", passed: !corpusReady || metrics.f1 >= LEVEL_2_TARGET_THRESHOLDS.f1Min, actual: metrics.f1, threshold: LEVEL_2_TARGET_THRESHOLDS.f1Min, operator: ">=" },
    { level: 2, enabled: corpusReady, name: "criticalPrecisionTarget", passed: !corpusReady || metrics.criticalPrecision >= LEVEL_2_TARGET_THRESHOLDS.criticalPrecisionMin, actual: metrics.criticalPrecision, threshold: LEVEL_2_TARGET_THRESHOLDS.criticalPrecisionMin, operator: ">=" },
    { level: 2, enabled: corpusReady, name: "unsupportedCriticalAutoFillsZero", passed: !corpusReady || metrics.unsupportedCriticalAutoFills <= LEVEL_2_TARGET_THRESHOLDS.unsupportedCriticalAutoFillsMax, actual: metrics.unsupportedCriticalAutoFills, threshold: LEVEL_2_TARGET_THRESHOLDS.unsupportedCriticalAutoFillsMax, operator: "<=" },
    { level: 2, enabled: corpusReady, name: "canonicalDuplicatesZero", passed: !corpusReady || metrics.duplicateCanonicalRows <= LEVEL_2_TARGET_THRESHOLDS.duplicateCanonicalRowsMax, actual: metrics.duplicateCanonicalRows, threshold: LEVEL_2_TARGET_THRESHOLDS.duplicateCanonicalRowsMax, operator: "<=" },
    { level: 2, enabled: corpusReady, name: "wrongDomainCriticalEvidenceZero", passed: !corpusReady || metrics.wrongDomainEvidenceFacts <= LEVEL_2_TARGET_THRESHOLDS.wrongDomainCriticalEvidenceMax, actual: metrics.wrongDomainEvidenceFacts, threshold: LEVEL_2_TARGET_THRESHOLDS.wrongDomainCriticalEvidenceMax, operator: "<=" },
  ];
}

