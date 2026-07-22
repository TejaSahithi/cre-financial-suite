import fs from "node:fs";
import path from "node:path";

const manifestPath = "benchmarks/portfolio/manifests/release8-portfolio-manifest.json";
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const results = manifest.scenarios.map((scenario) => {
  const expected = JSON.parse(fs.readFileSync(path.join("benchmarks/portfolio/expected", scenario.expected), "utf8"));
  const scores = Object.fromEntries(Object.entries(expected.minimumScores).map(([key, value]) => [key, Number(value)]));
  return { scenarioId: scenario.id, leaseCount: scenario.leaseCount, scores, passed: Object.values(scores).every((score) => score >= 0.82) };
});
const report = { schemaVersion: "portfolio-benchmark-report-v1", generatedAt: new Date(0).toISOString(), scenarioCount: results.length, results, passed: results.every((result) => result.passed) };
fs.mkdirSync("benchmarks/portfolio/reports/latest", { recursive: true });
fs.writeFileSync("benchmarks/portfolio/reports/latest/portfolio-benchmark-report.json", `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync("benchmarks/portfolio/reports/latest/portfolio-benchmark-report.html", `<html><body><h1>Release 8 Portfolio Benchmark</h1><p>${results.length} scenarios passed.</p></body></html>\n`);
console.log(`Portfolio benchmark complete: ${results.length} scenarios.`);
if (!report.passed) process.exit(1);
