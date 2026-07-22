import fs from "node:fs";
const requiredDocs = [
  "docs/release-8-portfolio-rollout-readiness.md",
  "docs/runbooks/release-8-portfolio-refresh-failure.md",
  "docs/runbooks/release-8-portfolio-export-incident.md",
  "docs/runbooks/release-8-rent-roll-reconciliation.md"
];
const report = "benchmarks/portfolio/reports/latest/portfolio-benchmark-report.json";
const missingDocuments = requiredDocs.filter((file) => !fs.existsSync(file));
const latestBenchmarkReport = fs.existsSync(report);
const failingGates = [];
if (latestBenchmarkReport) {
  const parsed = JSON.parse(fs.readFileSync(report, "utf8"));
  if (!parsed.passed) failingGates.push("portfolio_benchmark");
} else failingGates.push("portfolio_benchmark_missing");
const status = missingDocuments.length || failingGates.length ? "not_ready" : "ready_for_portfolio_pilot_review";
console.log(JSON.stringify({ schemaVersion: "release-8-portfolio-readiness-check-v1", status, missingDocuments, latestBenchmarkReport, failingGates, note: "Pilot readiness requires human approval; Release 8 does not auto-publish or write back to operational systems." }, null, 2));
if (status !== "ready_for_portfolio_pilot_review") process.exit(1);
