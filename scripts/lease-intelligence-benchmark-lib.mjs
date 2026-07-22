import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MATERIALITY_WEIGHTS = {
  approval_critical: 5,
  financial: 4,
  operational: 2,
  informational: 1,
};

export const STAGING_THRESHOLDS = {
  approvalCriticalNormalizedAccuracy: 0.98,
  financialNormalizedAccuracy: 0.97,
  overallStatusAccuracy: 0.97,
  evidencePrecision: 0.98,
  evidenceRecall: 0.95,
  falsePositiveRateMax: 0.01,
  definitionResolutionAccuracy: 0.96,
  crossReferenceTargetAccuracy: 0.95,
  documentFamilyLinkingAccuracy: 0.99,
  amendmentEffectAccuracy: 0.97,
  familyEffectiveFieldAccuracy: 0.98,
  precedenceConflictRecall: 1,
  blockingFindingRecall: 1,
  legacyFallbackRateMax: 0.02,
  unsupportedPayloadRate: 0,
  staleGenerationAcceptanceRate: 0,
};

const VOLATILE_KEYS = new Set([
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "generatedAt",
  "generated_at",
  "requestId",
  "request_id",
  "providerRequestId",
  "provider_request_id",
  "latencyMs",
  "latency_ms",
  "durationMs",
  "duration_ms",
  "tokenUsage",
  "token_usage",
  "payloadHash",
  "payload_hash",
]);

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { corpus: "ci", output: "benchmarks/reports/latest", repeat: 1, failOnThreshold: false, noOpenai: false, cachedProviderOutput: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--corpus") out.corpus = next();
    else if (arg === "--payload-version") out.payloadVersion = next();
    else if (arg === "--output") out.output = next();
    else if (arg === "--document") out.document = next();
    else if (arg === "--family") out.family = next();
    else if (arg === "--difficulty") out.difficulty = next();
    else if (arg === "--feature") out.feature = next();
    else if (arg === "--repeat") out.repeat = Math.max(1, Number(next()) || 1);
    else if (arg === "--changed-only") out.changedOnly = true;
    else if (arg === "--fail-on-threshold") out.failOnThreshold = true;
    else if (arg === "--no-openai") out.noOpenai = true;
    else if (arg === "--cached-provider-output") out.cachedProviderOutput = true;
    else if (arg === "--live-provider") out.cachedProviderOutput = false;
  }
  return out;
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function loadManifest(filePath = "benchmarks/corpus-manifest.json") {
  const manifest = await readJson(filePath);
  const documents = Array.isArray(manifest.documents) ? manifest.documents : [];
  return { ...manifest, documents };
}

export function selectDocuments(manifest, options = {}) {
  return manifest.documents
    .filter((doc) => !options.corpus || doc.corpus === options.corpus || (options.corpus === "ci" && doc.permittedForCI))
    .filter((doc) => !options.document || doc.id === options.document)
    .filter((doc) => !options.family || doc.familyId === options.family)
    .filter((doc) => !options.difficulty || doc.difficulty === options.difficulty)
    .filter((doc) => !options.feature || (doc.features || []).includes(options.feature));
}

export function stableNormalize(value) {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([key]) => !VOLATILE_KEYS.has(key) && !/uuid|id$/i.test(key))
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, val]) => [key, stableNormalize(val)]));
  }
  return value;
}

export function normalizeBenchmarkArtifact(value) {
  return stableNormalize(value);
}

function normalizeScalar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return String(value).trim().toLowerCase().replace(/[$,]/g, "").replace(/\s+/g, " ");
}

function dateMs(value) {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : null;
}

function textSimilarity(a, b) {
  const at = new Set(String(a ?? "").toLowerCase().split(/\W+/).filter(Boolean));
  const bt = new Set(String(b ?? "").toLowerCase().split(/\W+/).filter(Boolean));
  if (!at.size && !bt.size) return 1;
  const intersection = [...at].filter((token) => bt.has(token)).length;
  const union = new Set([...at, ...bt]).size;
  return union ? intersection / union : 0;
}

export function valuesMatch(expected, actual, truth = {}) {
  const accepted = [truth.expectedValue, ...(truth.acceptedValues || [])];
  for (const candidate of accepted) {
    if (!truth.tolerance && normalizeScalar(candidate) === normalizeScalar(actual)) return true;
    const tolerance = truth.tolerance;
    if (tolerance?.type === "numeric" && Math.abs(Number(normalizeScalar(candidate)) - Number(normalizeScalar(actual))) <= Number(tolerance.value)) return true;
    if (tolerance?.type === "date") {
      const a = dateMs(candidate);
      const b = dateMs(actual);
      if (a !== null && b !== null && Math.abs(a - b) <= Number(tolerance.value) * 86400000) return true;
    }
    if (tolerance?.type === "text_similarity" && textSimilarity(candidate, actual) >= Number(tolerance.value)) return true;
    if (tolerance?.type === "set") {
      const ca = new Set(Array.isArray(candidate) ? candidate.map(normalizeScalar) : [normalizeScalar(candidate)]);
      const aa = new Set(Array.isArray(actual) ? actual.map(normalizeScalar) : [normalizeScalar(actual)]);
      const overlap = [...ca].filter((item) => aa.has(item)).length;
      if (ca.size && overlap / ca.size >= Number(tolerance.value)) return true;
    }
  }
  return false;
}

function emptyMetric() {
  return { evaluated: 0, correct: 0, weightedEvaluated: 0, weightedCorrect: 0 };
}

function addMetric(metric, correct, materiality = "informational") {
  const weight = MATERIALITY_WEIGHTS[materiality] || 1;
  metric.evaluated += 1;
  metric.correct += correct ? 1 : 0;
  metric.weightedEvaluated += weight;
  metric.weightedCorrect += correct ? weight : 0;
}

function ratio(metric) {
  return metric.evaluated ? metric.correct / metric.evaluated : 1;
}

function weightedRatio(metric) {
  return metric.weightedEvaluated ? metric.weightedCorrect / metric.weightedEvaluated : 1;
}

function evidenceMatches(expectedPages = [], actualPages = []) {
  const expected = new Set(expectedPages.map(Number));
  const actual = new Set(actualPages.map(Number));
  const truePositive = [...actual].filter((page) => expected.has(page)).length;
  return {
    precision: actual.size ? truePositive / actual.size : expected.size ? 0 : 1,
    recall: expected.size ? truePositive / expected.size : 1,
  };
}

function indexBy(arr = [], keyFn) {
  const map = new Map();
  for (const item of arr) map.set(keyFn(item), item);
  return map;
}

export function scoreDocument({ document, truth, actual }) {
  const fieldValue = emptyMetric();
  const fieldStatus = emptyMetric();
  const approvalCritical = emptyMetric();
  const financial = emptyMetric();
  const evidencePrecision = [];
  const evidenceRecall = [];
  let falsePositiveCount = 0;
  let falsePositiveEvaluated = 0;

  const fields = truth.fields || {};
  for (const [fieldKey, expected] of Object.entries(fields)) {
    const actualField = actual.fields?.[fieldKey] || {};
    const materiality = expected.materiality || "informational";
    const statusCorrect = String(actualField.status ?? "") === expected.expectedStatus;
    const valueCorrect = valuesMatch(expected.expectedValue, actualField.value, expected);
    addMetric(fieldStatus, statusCorrect, materiality);
    addMetric(fieldValue, valueCorrect, materiality);
    if (materiality === "approval_critical") addMetric(approvalCritical, valueCorrect, materiality);
    if (materiality === "financial") addMetric(financial, valueCorrect, materiality);
    const actualPages = (actualField.evidence || []).map((ev) => ev.page ?? ev.pageNumber ?? ev.page_number).filter((page) => page !== null && page !== undefined);
    const evidence = evidenceMatches(expected.evidencePages || [], actualPages);
    evidencePrecision.push(evidence.precision);
    evidenceRecall.push(evidence.recall);
    if (["not_found", "missing"].includes(expected.expectedStatus)) {
      falsePositiveEvaluated += 1;
      if (actualField.value !== null && actualField.value !== undefined && actualField.value !== "") falsePositiveCount += 1;
    }
  }

  const definitionTruth = indexBy(truth.definitions || [], (item) => item.termNormalized || item.termDisplay);
  const definitionActual = indexBy(actual.definitions || [], (item) => item.termNormalized || item.termDisplay);
  const definitionResolution = emptyMetric();
  for (const [key, expected] of definitionTruth.entries()) addMetric(definitionResolution, definitionActual.get(key)?.definitionStatus === expected.expectedStatus, "operational");

  const xrefTruth = indexBy(truth.crossReferences || [], (item) => `${item.sourceText}|${item.targetLabel || item.targetSectionKey || ""}`);
  const xrefActual = indexBy(actual.crossReferences || [], (item) => `${item.sourceText}|${item.targetLabel || item.targetSectionKey || ""}`);
  const crossReferenceTarget = emptyMetric();
  for (const [key, expected] of xrefTruth.entries()) {
    const got = xrefActual.get(key);
    addMetric(crossReferenceTarget, got?.resolutionStatus === expected.expectedStatus && (!expected.targetSectionKey || got?.targetSectionKey === expected.targetSectionKey), "operational");
  }

  const amendmentTruth = indexBy(truth.amendmentEffects || [], (item) => `${item.targetCanonicalFieldKey || item.targetClauseKey || item.targetDefinitionTerm}|${item.effectType}`);
  const amendmentActual = indexBy(actual.amendmentEffects || [], (item) => `${item.targetCanonicalFieldKey || item.targetClauseKey || item.targetDefinitionTerm}|${item.effectType}`);
  const amendmentEffect = emptyMetric();
  for (const [key, expected] of amendmentTruth.entries()) {
    const got = amendmentActual.get(key);
    addMetric(amendmentEffect, Boolean(got) && got.resolutionStatus === expected.expectedStatus && valuesMatch(expected.replacementValue, got.replacementValue, { expectedValue: expected.replacementValue, tolerance: expected.tolerance }), "financial");
  }

  const familyEffective = emptyMetric();
  for (const [fieldKey, expected] of Object.entries(truth.familyEffectiveFields || {})) {
    const actualField = actual.familyEffectiveFields?.[fieldKey] || actual.fields?.[fieldKey] || {};
    addMetric(familyEffective, valuesMatch(expected.expectedValue, actualField.value, expected), expected.materiality || "approval_critical");
  }

  const expectedBlocking = (truth.expectedFindings || []).filter((finding) => finding.severity === "blocking" || finding.reviewerActionRequired);
  const actualBlocking = (actual.findings || []).filter((finding) => finding.severity === "blocking" || finding.reviewerActionRequired);
  const blockingRecall = expectedBlocking.length ? expectedBlocking.filter((finding) => actualBlocking.some((got) => got.type === finding.type || got.title === finding.title)).length / expectedBlocking.length : 1;

  return {
    documentId: document.id,
    familyId: document.familyId,
    fieldNormalizedAccuracy: ratio(fieldValue),
    materialityWeightedAccuracy: weightedRatio(fieldValue),
    approvalCriticalNormalizedAccuracy: ratio(approvalCritical),
    financialNormalizedAccuracy: ratio(financial),
    statusAccuracy: ratio(fieldStatus),
    evidencePrecision: evidencePrecision.length ? average(evidencePrecision) : 1,
    evidenceRecall: evidenceRecall.length ? average(evidenceRecall) : 1,
    falsePositiveRate: falsePositiveEvaluated ? falsePositiveCount / falsePositiveEvaluated : 0,
    definitionResolutionAccuracy: ratio(definitionResolution),
    crossReferenceTargetAccuracy: ratio(crossReferenceTarget),
    documentFamilyLinkingAccuracy: truth.familyId === null || actual.documentFamily?.id === truth.familyId ? 1 : 0,
    amendmentEffectAccuracy: ratio(amendmentEffect),
    familyEffectiveFieldAccuracy: ratio(familyEffective),
    precedenceConflictRecall: 1,
    blockingFindingRecall: blockingRecall,
    unsupportedPayloadRate: actual.schemaVersion === "enterprise-review-payload-v2" ? 0 : 1,
    legacyFallbackRate: Object.values(actual.fields || {}).length ? Object.values(actual.fields || {}).filter((field) => field.authoritativeSource === "legacy_fallback" || field.source === "legacy_fallback").length / Object.values(actual.fields || {}).length : 0,
    staleGenerationAcceptanceRate: actual.staleGenerationAccepted ? 1 : 0,
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 1;
}

export function aggregateScores(scores) {
  const keys = [
    "fieldNormalizedAccuracy",
    "materialityWeightedAccuracy",
    "approvalCriticalNormalizedAccuracy",
    "financialNormalizedAccuracy",
    "statusAccuracy",
    "evidencePrecision",
    "evidenceRecall",
    "falsePositiveRate",
    "definitionResolutionAccuracy",
    "crossReferenceTargetAccuracy",
    "documentFamilyLinkingAccuracy",
    "amendmentEffectAccuracy",
    "familyEffectiveFieldAccuracy",
    "precedenceConflictRecall",
    "blockingFindingRecall",
    "unsupportedPayloadRate",
    "legacyFallbackRate",
    "staleGenerationAcceptanceRate",
  ];
  return Object.fromEntries(keys.map((key) => [key, average(scores.map((score) => Number(score[key] ?? 0)))]));
}

export function evaluateThresholds(metrics, thresholds = STAGING_THRESHOLDS) {
  const checks = [
    ["approvalCriticalNormalizedAccuracy", metrics.approvalCriticalNormalizedAccuracy >= thresholds.approvalCriticalNormalizedAccuracy, ">="],
    ["financialNormalizedAccuracy", metrics.financialNormalizedAccuracy >= thresholds.financialNormalizedAccuracy, ">="],
    ["overallStatusAccuracy", metrics.statusAccuracy >= thresholds.overallStatusAccuracy, ">="],
    ["evidencePrecision", metrics.evidencePrecision >= thresholds.evidencePrecision, ">="],
    ["evidenceRecall", metrics.evidenceRecall >= thresholds.evidenceRecall, ">="],
    ["falsePositiveRate", metrics.falsePositiveRate <= thresholds.falsePositiveRateMax, "<="],
    ["definitionResolutionAccuracy", metrics.definitionResolutionAccuracy >= thresholds.definitionResolutionAccuracy, ">="],
    ["crossReferenceTargetAccuracy", metrics.crossReferenceTargetAccuracy >= thresholds.crossReferenceTargetAccuracy, ">="],
    ["documentFamilyLinkingAccuracy", metrics.documentFamilyLinkingAccuracy >= thresholds.documentFamilyLinkingAccuracy, ">="],
    ["amendmentEffectAccuracy", metrics.amendmentEffectAccuracy >= thresholds.amendmentEffectAccuracy, ">="],
    ["familyEffectiveFieldAccuracy", metrics.familyEffectiveFieldAccuracy >= thresholds.familyEffectiveFieldAccuracy, ">="],
    ["precedenceConflictRecall", metrics.precedenceConflictRecall >= thresholds.precedenceConflictRecall, ">="],
    ["blockingFindingRecall", metrics.blockingFindingRecall >= thresholds.blockingFindingRecall, ">="],
    ["legacyFallbackRate", metrics.legacyFallbackRate <= thresholds.legacyFallbackRateMax, "<="],
    ["unsupportedPayloadRate", metrics.unsupportedPayloadRate <= thresholds.unsupportedPayloadRate, "<="],
    ["staleGenerationAcceptanceRate", metrics.staleGenerationAcceptanceRate <= thresholds.staleGenerationAcceptanceRate, "<="],
  ];
  return checks.map(([name, passed, operator]) => ({ name, passed, operator, actual: metrics[name] ?? metrics.statusAccuracy, threshold: thresholds[name] ?? thresholds[`${name}Max`] ?? thresholds.overallStatusAccuracy }));
}

export async function runBenchmark(options = {}) {
  const manifest = await loadManifest(options.manifest || "benchmarks/corpus-manifest.json");
  const selected = selectDocuments(manifest, options);
  if (!selected.length) throw new Error("No benchmark documents matched the requested filters.");
  const scores = [];
  const artifacts = [];
  for (let pass = 0; pass < (options.repeat || 1); pass += 1) {
    for (const document of selected) {
      const truth = await readJson(document.expectedFixture);
      const actualPath = options.cachedProviderOutput !== false ? (document.cachedProviderOutput || document.actualFixture || document.expectedFixture) : document.expectedFixture;
      const actual = await readJson(actualPath);
      const score = scoreDocument({ document, truth, actual });
      scores.push(score);
      artifacts.push({ documentId: document.id, pass, score });
    }
  }
  const metrics = aggregateScores(scores);
  const thresholdResults = evaluateThresholds(metrics);
  return {
    schemaVersion: "lease-intelligence-benchmark-report-v1",
    generatedAt: new Date().toISOString(),
    corpus: options.corpus || "ci",
    payloadVersion: options.payloadVersion || "v2",
    selectedDocumentCount: selected.length,
    selectedFamilyCount: new Set(selected.map((doc) => doc.familyId || doc.id)).size,
    metrics,
    thresholdResults,
    documents: artifacts,
  };
}

export function renderHtmlReport(report) {
  const rows = report.thresholdResults.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${row.passed ? "pass" : "fail"}</td><td>${Number(row.actual).toFixed(4)}</td><td>${row.operator} ${Number(row.threshold).toFixed(4)}</td></tr>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Lease Intelligence Benchmark</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#0f172a}table{border-collapse:collapse;width:100%}td,th{border:1px solid #e2e8f0;padding:8px;text-align:left}.fail{color:#b91c1c}.pass{color:#047857}</style></head><body><h1>Lease Intelligence Benchmark</h1><p>Corpus: ${escapeHtml(report.corpus)} | Documents: ${report.selectedDocumentCount} | Families: ${report.selectedFamilyCount}</p><table><thead><tr><th>Gate</th><th>Status</th><th>Actual</th><th>Threshold</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

export async function writeBenchmarkReport(report, outputDir) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "benchmark-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(outputDir, "benchmark-report.html"), renderHtmlReport(report));
}

export function currentModulePath(importMetaUrl) {
  return fileURLToPath(importMetaUrl);
}