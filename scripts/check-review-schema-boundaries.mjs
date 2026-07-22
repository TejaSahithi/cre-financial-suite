import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_TARGETS = [
  "src/components/review",
  "src/components/lease-review/EnterpriseCoverageDashboard.jsx",
  "src/components/lease-review/EnterpriseFindings.jsx",
  "src/components/lease-review/EnterpriseHeaderIntelligenceBar.jsx",
  "src/components/lease-review/FieldDrawerIntelligence.jsx",
  "src/components/lease-review/FieldDetailDrawer.jsx",
  "src/components/lease-review/LeaseReviewTabTable.jsx",
  "src/components/lease-review/StandardFieldsByGroup.jsx",
];

const ALLOWLIST = [
  "src/lib/review/adapters/",
  "src/lib/review/useReviewDocument.ts",
  "src/services/",
  "src/components/lease-review/ExtractionDebugPanel.jsx",
  "src/pages/LeaseReview.jsx",
  "__tests__",
];

const RULES = [
  { name: "raw ui_review_payload access", pattern: /\bui_review_payload\b/ },
  { name: "raw normalized_output access", pattern: /\bnormalized_output\b/ },
  { name: "raw reviewed_output access", pattern: /\breviewed_output\b/ },
  { name: "backend canonicalFieldKey key", pattern: /\bcanonicalFieldKey\b/ },
  { name: "enterprise payload prop/access", pattern: /\benterprisePayload\b/ },
  { name: "enterprise fieldsByKey access", pattern: /\bfieldsByKey\b/ },
  { name: "legacy-over-canonical fallback", pattern: /legacyValue\s*\?\?\s*canonicalValue/ },
  { name: "canonical-over-legacy fallback", pattern: /canonicalValue\s*\?\?\s*legacyValue/ },
];

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function isAllowed(relativePath) {
  const normalized = toPosix(relativePath);
  return ALLOWLIST.some((entry) => normalized === entry || normalized.includes(entry) || normalized.startsWith(entry));
}

function collectFiles(targets = DEFAULT_TARGETS) {
  const files = [];
  for (const target of targets) {
    const absolute = path.resolve(ROOT, target);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      const stack = [absolute];
      while (stack.length) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const entryPath = path.join(current, entry.name);
          if (entry.isDirectory()) {
            stack.push(entryPath);
          } else if (/\.(jsx?|tsx?)$/.test(entry.name)) {
            files.push(entryPath);
          }
        }
      }
    } else if (/\.(jsx?|tsx?)$/.test(absolute)) {
      files.push(absolute);
    }
  }
  return Array.from(new Set(files)).sort();
}

export function scanReviewSchemaBoundaries({ targets = DEFAULT_TARGETS } = {}) {
  const violations = [];
  for (const file of collectFiles(targets)) {
    const relative = toPosix(path.relative(ROOT, file));
    if (isAllowed(relative)) continue;
    const source = fs.readFileSync(file, "utf8");
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of RULES) {
        if (rule.pattern.test(line)) {
          violations.push({ file: relative, line: index + 1, rule: rule.name, text: line.trim() });
        }
      }
    });
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targets = process.argv.slice(2);
  const violations = scanReviewSchemaBoundaries({ targets: targets.length ? targets : DEFAULT_TARGETS });
  if (violations.length > 0) {
    console.error("Review schema boundary violations found:");
    for (const violation of violations) {
      console.error(`${violation.file}:${violation.line} ${violation.rule}: ${violation.text}`);
    }
    process.exit(1);
  }
  console.log("Review schema boundaries OK");
}