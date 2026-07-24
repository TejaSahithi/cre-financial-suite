#!/usr/bin/env node
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { aggregateLeaseExtractionReports, scoreLeaseExtraction } from "../src/lib/leaseExtractionEval.js";

function parseArgs(argv) {
  const out = { manifest: "benchmarks/lease-extraction/manifest.json", output: "benchmarks/lease-extraction/reports/latest", runMode: "replay", failOnThreshold: false, updateBaseline: false, reportJson: false, smoke: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--manifest") out.manifest = next();
    else if (arg === "--fixture") out.fixture = next();
    else if (arg === "--actual") out.actual = next();
    else if (arg === "--corpus") out.corpus = next();
    else if (arg === "--output") out.output = next();
    else if (arg === "--smoke") out.smoke = true;
    else if (arg === "--report-json") out.reportJson = true;
    else if (arg === "--update-baseline") out.updateBaseline = true;
    else if (arg === "--fail-on-threshold") out.failOnThreshold = true;
    else if (arg === "--live") out.runMode = "live";
    else if (arg === "--replay") out.runMode = "replay";
  }
  return out;
}

async function readJson(filePath) { return JSON.parse(await readFile(filePath, "utf8")); }
function selectFixtures(manifest, options) {
  return (manifest.fixtures || []).filter((item) => !options.fixture || item.fixtureId === options.fixture).filter((item) => !options.corpus || item.corpus === options.corpus || (options.corpus === "ci" && item.permittedForCI));
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch])); }
function pct(value) { return `${(Number(value || 0) * 100).toFixed(2)}%`; }
function reportNote(report) { return report.runMode === "scorer_smoke" ? "Smoke-mode metrics validate scorer wiring only. They are not extraction accuracy metrics." : "Replay-mode metrics require a captured pipeline review payload. They are not live extraction metrics unless runMode is live."; }

function renderMarkdown(report) {
  return `${[
    "# Lease Extraction Evaluation Report", "", `Generated: ${report.generatedAt}`, `Run mode: ${report.runMode}`, `Fixtures: ${report.selectedFixtureCount}`, `Corpus sufficiency: ${report.corpusSufficiency}`, "",
    "## Summary Metrics", "", `- Precision: ${pct(report.metrics.precision)}`, `- Recall: ${pct(report.metrics.recall)}`, `- F1: ${pct(report.metrics.f1)}`, `- Critical precision: ${pct(report.metrics.criticalPrecision)}`, `- Critical recall: ${pct(report.metrics.criticalRecall)}`, `- Unsupported critical auto-fills: ${report.metrics.unsupportedCriticalAutoFills}`, `- Duplicate canonical rows: ${report.metrics.duplicateCanonicalRows}`, `- Wrong-domain evidence facts: ${report.metrics.wrongDomainEvidenceFacts}`, "",
    "## Thresholds", "", "| Level | Gate | Status | Actual | Threshold |", "| --- | --- | --- | --- | --- |",
    ...report.thresholdResults.map((gate) => `| ${gate.level} | ${gate.name}${gate.enabled === false ? " (disabled)" : ""} | ${gate.passed ? "pass" : "fail"} | ${Number(gate.actual).toFixed(4)} | ${gate.operator} ${Number(gate.threshold).toFixed(4)} |`), "",
    "## Known Failures By Stage", "", ...report.documents.flatMap((doc) => doc.failureStages.length ? doc.failureStages.map((item) => `- ${doc.fixtureId} ${item.identity}: ${item.stage} - ${item.reason}`) : [`- ${doc.fixtureId}: no field-level failures in this run artifact.`]), "", `Note: ${reportNote(report)}`
  ].join("\n")}\n`;
}

function renderHtml(report) {
  const rows = report.thresholdResults.map((gate) => `<tr><td>${gate.level}</td><td>${escapeHtml(gate.name)}${gate.enabled === false ? " (disabled)" : ""}</td><td>${gate.passed ? "pass" : "fail"}</td><td>${Number(gate.actual).toFixed(4)}</td><td>${escapeHtml(gate.operator)} ${Number(gate.threshold).toFixed(4)}</td></tr>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Lease Extraction Eval</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#0f172a}table{border-collapse:collapse;width:100%}td,th{border:1px solid #e2e8f0;padding:8px;text-align:left}</style></head><body><h1>Lease Extraction Evaluation</h1><p>Run mode: ${escapeHtml(report.runMode)} | Fixtures: ${report.selectedFixtureCount} | Corpus: ${escapeHtml(report.corpusSufficiency)}</p><p>Precision ${pct(report.metrics.precision)} | Recall ${pct(report.metrics.recall)} | F1 ${pct(report.metrics.f1)} | Critical precision ${pct(report.metrics.criticalPrecision)}</p><table><thead><tr><th>Level</th><th>Gate</th><th>Status</th><th>Actual</th><th>Threshold</th></tr></thead><tbody>${rows}</tbody></table><p>${escapeHtml(reportNote(report))}</p></body></html>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.runMode === "live") throw new Error("Live evaluation is not wired yet. Capture a review payload and run replay mode, or extend this command to invoke the deployed pipeline explicitly.");
  if (options.actual && !options.fixture) throw new Error("--actual requires --fixture so the runner knows which ground truth to compare against.");
  const manifest = await readJson(options.manifest);
  const selected = selectFixtures(manifest, options);
  if (!selected.length) throw new Error("No lease extraction evaluation fixtures matched the requested filters.");
  const reports = [];
  const propertyTypes = [];
  const documentTypes = [];
  for (const entry of selected) {
    const fixture = await readJson(entry.groundTruthFixture);
    const actualPath = options.actual || (options.smoke ? entry.smokeActualFixture : entry.replayActualFixture);
    if (!actualPath) throw new Error(`No captured actual review payload is configured for ${entry.fixtureId}. Provide --actual <path>, add replayActualFixture to the manifest, or pass --smoke to exercise scorer wiring only.`);
    const actual = await readJson(actualPath);
    const effectiveRunMode = options.smoke ? "scorer_smoke" : (entry.runMode === "requires_captured_actual" ? options.runMode : entry.runMode || options.runMode);
    reports.push(scoreLeaseExtraction({ fixture, actual, runMode: effectiveRunMode }));
    propertyTypes.push(entry.propertyType || fixture.propertyType);
    documentTypes.push(entry.documentType || fixture.documentType);
  }
  const aggregate = aggregateLeaseExtractionReports(reports, { runMode: options.smoke ? "scorer_smoke" : options.runMode, propertyTypes, documentTypes });
  await mkdir(options.output, { recursive: true });
  const jsonPath = path.join(options.output, "lease-extraction-eval-report.json");
  const htmlPath = path.join(options.output, "lease-extraction-eval-report.html");
  const mdPath = path.join(options.output, "lease-extraction-eval-report.md");
  await writeFile(jsonPath, `${JSON.stringify(aggregate, null, 2)}\n`);
  await writeFile(htmlPath, renderHtml(aggregate));
  await writeFile(mdPath, renderMarkdown(aggregate));
  if (options.updateBaseline) {
    const baselineDir = "benchmarks/lease-extraction/baselines/latest";
    await mkdir(baselineDir, { recursive: true });
    await copyFile(jsonPath, path.join(baselineDir, "lease-extraction-eval-report.json"));
    await copyFile(mdPath, path.join(baselineDir, "lease-extraction-eval-report.md"));
  }
  const failed = aggregate.thresholdResults.filter((gate) => gate.enabled !== false && !gate.passed);
  console.log(`Lease extraction eval complete: ${aggregate.selectedFixtureCount} fixture(s), mode=${aggregate.runMode}.`);
  console.log(`Report written to ${jsonPath}`);
  console.log(`F1=${pct(aggregate.metrics.f1)} criticalPrecision=${pct(aggregate.metrics.criticalPrecision)} unsupportedCriticalAutoFills=${aggregate.metrics.unsupportedCriticalAutoFills}`);
  if (aggregate.runMode === "scorer_smoke") console.log("Smoke mode only validates scorer wiring; it is not an extraction accuracy baseline.");
  if (failed.length) { console.log(`Threshold failures: ${failed.map((gate) => gate.name).join(", ")}`); if (options.failOnThreshold) process.exitCode = 1; }
  else console.log("Enabled threshold gates passed.");
  if (options.reportJson) console.log(JSON.stringify(aggregate));
}

main().catch((error) => { console.error(error?.stack || error?.message || error); process.exitCode = 1; });
