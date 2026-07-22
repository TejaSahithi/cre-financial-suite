#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const files = [
  "load-tests/review-payload.js",
  "load-tests/semantic-search.js",
  "load-tests/reviewer-actions.js",
  "load-tests/concurrent-ingestion.js",
];
const requiredTerms = ["thresholds", "scenarios", "organization", "stale"];
const failures = [];
for (const file of files) {
  const source = await readFile(file, "utf8").catch(() => "");
  if (!source) failures.push(`${file}: missing`);
  for (const term of requiredTerms) if (!source.includes(term)) failures.push(`${file}: missing ${term}`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Release 7 load-test definitions present: ${files.length}`);