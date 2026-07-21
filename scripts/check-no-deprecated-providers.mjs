#!/usr/bin/env node
// Repository-level guard: fails if executable production code imports a
// deprecated-provider module, calls a deleted Vertex/Gemini/Docling/Vision
// wrapper function, or reads a deprecated provider environment variable.
//
// This intentionally does NOT flag every occurrence of the words
// "vertex"/"gemini"/"docling"/"vision" -- most remaining occurrences in this
// repo are legitimate historical-data compatibility (e.g. the docling_raw
// DB column name, the debug.vertex_fact_ledger mirror key on already-
// persisted extraction rows, the "gemini_vision" historical parser-method
// string). Those are read-paths for old stored data, not executable
// provider-selection code, and are exempt from this scan by design -- not
// by exclusion list -- because the blocklist below only names identifiers,
// import paths, and env vars that no longer exist anywhere in the live
// codebase. Any match is therefore either a real regression or a typo.
//
// Usage: node scripts/check-no-deprecated-providers.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const SCAN_ROOTS = [
  "supabase/functions",
  "src",
];

const EXCLUDED_DIR_SEGMENTS = new Set([
  "_tests",
  "node_modules",
  "dist",
  "build",
  ".git",
]);

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

// Deprecated environment variables. A bare mention of the identifier in
// production code (not just an explicit Deno.env.get call) is flagged --
// there is no legitimate reason production code needs to reference these
// names at all now that Azure Document Intelligence + OpenAI are the only
// providers.
const DEPRECATED_ENV_VARS = [
  "GOOGLE_API_KEY",
  "GOOGLE_VISION_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_SERVICE_ACCOUNT_KEY",
  "GEMINI_API_KEY",
  "VERTEX_PROJECT_ID",
  "VERTEX_LOCATION",
  "VERTEX_MODEL",
  "DOCLING_API_URL",
  "DOCLING_API_KEY",
];

// Deleted functions/classes. If any of these identifiers appear again,
// either a deprecated wrapper was reintroduced, or this is a false-positive
// name collision that should be renamed to avoid confusion.
const DELETED_IDENTIFIERS = [
  "callVertexAI",
  "callVertexAIJSON",
  "callVertexAIWithFile",
  "callVertexAIFileJSON",
  "callVertexAISingleRequestDiagnostic",
  "validateVertexAIAuth",
  "VertexProviderError",
  "VertexAIDiagnosticError",
  "callGeminiWithAPIKey",
  "callGeminiWithAPIKeyAndFile",
  "callGeminiWithAPIKeyAndProvenance",
  "extractDocumentWithVision",
  "runVisionOCR",
  "runDoclingOnly",
  "runVisionOnly",
  "runVisionFirst",
  "canDoclingHandle",
  "canVisionHandle",
  "callDocling",
  "pickStrategy",
];

// Deleted modules/routes. Any import/reference by these path fragments
// means a deleted file is being re-imported (which would also be a hard
// module-resolution error in Deno/Vite, but this makes the failure clear
// and catches it at the source-text level too).
const DELETED_IMPORT_PATHS = [
  "_shared/vertex-ai",
  "_shared/ocr/vision-ocr",
  "extraction/vertex-fact-ledger",
  "provenance/transport/vertex",
  "provenance/transport/gemini",
  "functions/parse-pdf-docling",
  "functions/ocr-vision-extract",
  "functions/phase52-vertex-diagnostic",
];

function shouldSkipDir(name) {
  return EXCLUDED_DIR_SEGMENTS.has(name);
}

function walk(dir, files) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      walk(join(dir, entry.name), files);
      continue;
    }
    const ext = entry.name.slice(entry.name.lastIndexOf("."));
    if (SCAN_EXTENSIONS.has(ext)) {
      files.push(join(dir, entry.name));
    }
  }
}

function buildPatterns() {
  const patterns = [];
  for (const name of DEPRECATED_ENV_VARS) {
    patterns.push({ label: `deprecated env var ${name}`, regex: new RegExp(`\\b${name}\\b`) });
  }
  for (const name of DELETED_IDENTIFIERS) {
    patterns.push({ label: `deleted identifier ${name}`, regex: new RegExp(`\\b${name}\\b`) });
  }
  for (const path of DELETED_IMPORT_PATHS) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    patterns.push({ label: `deleted import path ${path}`, regex: new RegExp(escaped) });
  }
  return patterns;
}

function scanFile(filePath, patterns) {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const hits = [];
  lines.forEach((line, index) => {
    // The allow marker may sit on the flagged line itself or on the line
    // immediately above it (a leading explanatory comment).
    const allowed = line.includes("deprecated-provider-scan-allow:") ||
      (index > 0 && lines[index - 1].includes("deprecated-provider-scan-allow:"));
    if (allowed) return;
    for (const { label, regex } of patterns) {
      if (regex.test(line)) {
        hits.push({ line: index + 1, label, text: line.trim().slice(0, 160) });
      }
    }
  });
  return hits;
}

function main() {
  const patterns = buildPatterns();
  const files = [];
  for (const root of SCAN_ROOTS) {
    walk(join(REPO_ROOT, root), files);
  }

  let totalHits = 0;
  for (const file of files) {
    const hits = scanFile(file, patterns);
    if (hits.length === 0) continue;
    totalHits += hits.length;
    const relPath = relative(REPO_ROOT, file).split(sep).join("/");
    for (const hit of hits) {
      console.error(`${relPath}:${hit.line}: ${hit.label}\n    ${hit.text}`);
    }
  }

  if (totalHits > 0) {
    console.error(
      `\nFAIL: ${totalHits} prohibited deprecated-provider reference(s) found in production code.\n` +
      `Azure Document Intelligence is the only parser and OpenAI is the only LLM provider -- ` +
      `production code must not import, call, or read config for Vertex AI, Gemini, Google Vision, or Docling.`,
    );
    process.exit(1);
  }

  console.log(`OK: scanned ${files.length} files under ${SCAN_ROOTS.join(", ")} -- no prohibited deprecated-provider references found.`);
}

main();
