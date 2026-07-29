#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error("Usage: node scripts/compare-whole-document-extraction.mjs <current-result.json> <whole-document-result.json>");
  process.exit(2);
}

const [, , currentPath, experimentPath] = process.argv;
if (!currentPath || !experimentPath) usage();

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function firstRow(payload) {
  if (Array.isArray(payload?.rows)) return payload.rows[0] ?? {};
  if (Array.isArray(payload?.parsed_data)) return payload.parsed_data[0] ?? {};
  if (Array.isArray(payload?.normalized_output?.rows)) return payload.normalized_output.rows[0] ?? {};
  return payload?.row ?? payload ?? {};
}

function values(row) {
  return Object.fromEntries(
    Object.entries(row).filter(([key, value]) =>
      !key.startsWith("_") &&
      !["confidence_score", "extraction_notes"].includes(key) &&
      value !== null &&
      value !== undefined &&
      value !== ""
    ),
  );
}

const current = values(firstRow(readJson(currentPath)));
const experimentPayload = readJson(experimentPath);
const experimentRow = firstRow(experimentPayload);
const experiment = values(experimentRow);
const keys = [...new Set([...Object.keys(current), ...Object.keys(experiment)])].sort();

const comparison = keys.map((fieldKey) => {
  const currentValue = current[fieldKey] ?? null;
  const experimentValue = experiment[fieldKey] ?? null;
  const same = JSON.stringify(currentValue) === JSON.stringify(experimentValue);
  const evidence = experimentRow?._field_evidence?.[fieldKey] ?? null;
  return {
    fieldKey,
    currentValue,
    wholeDocumentValue: experimentValue,
    same,
    wholeDocumentHasEvidence: Boolean(evidence?.source_text),
    wholeDocumentStatus: evidence?.extraction_status ?? null,
  };
});

const summary = {
  currentPopulated: Object.keys(current).length,
  wholeDocumentPopulated: Object.keys(experiment).length,
  agreementCount: comparison.filter((row) => row.same && row.currentValue != null).length,
  currentOnlyCount: comparison.filter((row) => row.currentValue != null && row.wholeDocumentValue == null).length,
  wholeDocumentOnlyCount: comparison.filter((row) => row.currentValue == null && row.wholeDocumentValue != null).length,
  disagreementCount: comparison.filter((row) => row.currentValue != null && row.wholeDocumentValue != null && !row.same).length,
  wholeDocumentEvidenceCount: comparison.filter((row) => row.wholeDocumentHasEvidence).length,
};

console.log(JSON.stringify({ summary, comparison }, null, 2));
