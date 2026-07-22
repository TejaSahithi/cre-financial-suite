#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";

const REQUIRED_DOCS = [
  "docs/release-7-benchmark-adjudication-guide.md",
  "docs/release-7-security-validation.md",
  "docs/release-7-ga-readiness-report.md",
  "docs/runbooks/release-7-pipeline-failure.md",
  "docs/runbooks/release-7-provider-outage.md",
  "docs/runbooks/release-7-review-payload-failure.md",
  "docs/runbooks/release-7-semantic-search-failure.md",
  "docs/runbooks/release-7-amendment-conflict.md",
  "docs/runbooks/release-7-rollback.md",
  "docs/runbooks/release-7-security-incident.md",
];

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

const missing = [];
for (const file of REQUIRED_DOCS) if (!(await exists(file))) missing.push(file);
let latestReport = null;
if (await exists("benchmarks/reports/latest/benchmark-report.json")) {
  latestReport = JSON.parse(await readFile("benchmarks/reports/latest/benchmark-report.json", "utf8"));
}
const failingGates = latestReport?.thresholdResults?.filter((gate) => !gate.passed) ?? [];
const status = missing.length || failingGates.length || !latestReport ? "not_ready" : "ready_for_ga_review";
const summary = {
  schemaVersion: "release-7-ga-readiness-check-v1",
  status,
  missingDocuments: missing,
  latestBenchmarkReport: Boolean(latestReport),
  failingGates: failingGates.map((gate) => gate.name),
  note: status === "not_ready" ? "Release 7 controls are present but GA must remain gated until missing evidence and failing gates are resolved." : "Automated evidence is present; final GA still requires human go/no-go approval.",
};
console.log(JSON.stringify(summary, null, 2));
if (process.argv.includes("--fail-on-not-ready") && status !== "ready_for_ga_review") process.exitCode = 1;