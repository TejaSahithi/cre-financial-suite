#!/usr/bin/env node
/**
 * Runs the full Deno test suite and diffs the failing-test-name set against
 * the checked-in baseline (supabase/functions/_tests/.deno-baseline-failures.json,
 * captured at the end of Release 1: 118 pre-existing, environment-dependent
 * failures — e.g. tests requiring a live local Supabase Postgres/service-role
 * key not available in this sandbox).
 *
 * A bare pass/fail COUNT comparison can hide a regression: if one baseline
 * failure gets fixed while an unrelated new one appears, the total stays 118
 * and a count-only check would say "no change". This compares by identity
 * (`<file> :: <test name>`) instead, so a new name in the failing set that
 * isn't in the baseline is flagged as a real regression even if the total
 * count is unchanged or lower.
 *
 * Usage: node scripts/compare-deno-baseline.mjs
 * Exit code 0 if no new failures, 1 otherwise.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const baselinePath = path.join(repoRoot, "supabase/functions/_tests/.deno-baseline-failures.json");
const logPath = path.join(repoRoot, ".deno-run.tmp.log");

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function parseFailuresSection(log) {
  const idx = log.lastIndexOf("FAILURES");
  if (idx === -1) return []; // no failures at all
  const section = log.slice(idx);
  const lines = section.split("\n").slice(1).filter((l) => l.trim().length > 0);
  const entries = [];
  for (const raw of lines) {
    const line = stripAnsi(raw).trim();
    if (!line || line === "FAILURES" || /^error: Test failed/.test(line)) continue;
    const arrowMatch = line.match(/^(.*?)\s*=>\s*(\.\/.*?\.ts):\d+:\d+$/);
    if (arrowMatch) {
      entries.push(`${arrowMatch[2]} :: ${arrowMatch[1].trim()}`);
      continue;
    }
    const uncaughtMatch = line.match(/^(\.\/.*?\.ts) \(uncaught error\)$/);
    if (uncaughtMatch) {
      entries.push(`MODULE_LOAD_ERROR :: ${uncaughtMatch[1]}`);
    }
  }
  return [...new Set(entries)].sort();
}

console.log("Running full Deno test suite (this can take 1-2 minutes)...");
let log = "";
try {
  log = execFileSync(
    "deno",
    ["test", "--allow-all", "--no-check", "supabase/functions/_tests/"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 },
  );
} catch (err) {
  // deno exits non-zero when any test fails -- that's expected, output is on stdout/stderr
  log = (err.stdout ?? "") + (err.stderr ?? "");
}
writeFileSync(logPath, log);

const current = parseFailuresSection(log);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const baselineSet = new Set(baseline);
const currentSet = new Set(current);

const newFailures = current.filter((name) => !baselineSet.has(name));
const fixed = baseline.filter((name) => !currentSet.has(name));

console.log(`\nBaseline failing count: ${baseline.length}`);
console.log(`Current failing count:  ${current.length}`);

if (fixed.length > 0) {
  console.log(`\n${fixed.length} previously-failing test(s) now pass (bonus, not required):`);
  for (const name of fixed) console.log(`  + ${name}`);
}

if (newFailures.length > 0) {
  console.log(`\n${newFailures.length} NEW failure(s) not in the baseline (possible regression):`);
  for (const name of newFailures) console.log(`  ! ${name}`);
  console.log(
    "\nNote: this suite has a small amount of observed order/timing-dependent flakiness " +
    "unrelated to any single change (e.g. property-based tests occasionally swapping pass/fail " +
    "across consecutive full-suite runs even with zero code changes). Re-run once before treating " +
    "a new name here as a real regression, especially if it isn't in a file this change touched.",
  );
  console.log(`\nFull run log written to ${logPath}`);
  process.exit(1);
}

console.log("\nNo new failures. Failing-test-name-set is a subset of the established baseline.");
unlinkSync(logPath);
process.exit(0);
