#!/usr/bin/env node
import { parseArgs, runBenchmark, writeBenchmarkReport } from "./lease-intelligence-benchmark-lib.mjs";

const options = parseArgs(process.argv.slice(2));
try {
  const report = await runBenchmark(options);
  await writeBenchmarkReport(report, options.output);
  const failed = report.thresholdResults.filter((gate) => !gate.passed);
  console.log(`Lease intelligence benchmark complete: ${report.selectedDocumentCount} documents, ${report.selectedFamilyCount} families.`);
  console.log(`Report written to ${options.output}`);
  if (failed.length) {
    console.log(`Threshold failures: ${failed.map((gate) => gate.name).join(", ")}`);
    if (options.failOnThreshold) process.exitCode = 1;
  } else {
    console.log("All benchmark thresholds passed.");
  }
} catch (error) {
  console.error(error?.message || error);
  process.exitCode = 1;
}