/**
 * CAM Canonical Ownership & Legacy Guard CI Test.
 *
 * Verifies that active runtime code does not query or reference retired
 * legacy CAM objects:
 *   - cam_profiles
 *   - cam_calculations
 *   - compute-cam
 *   - savePropertyCamConfig / fetchPropertyCamConfig
 *   - CAMCalculationService
 *
 * Scope:
 *   - Runtime code: src/**, supabase/functions/** (excluding _tests),
 *     scripts/** (excluding scripts/migrations and __tests__) — JS/TS files
 *     only. A match is a violation unless the line (or the line directly
 *     above it) carries an inline "cam-legacy-scan-allow:" marker, reserved
 *     for retirement telemetry/comments that must legitimately name a
 *     retired object to explain why it's no longer used (the 410 stubs,
 *     persistCamProfile's retirement note, etc) — matching the
 *     `deprecated-provider-scan-allow:` convention already used by
 *     scripts/check-no-deprecated-providers.mjs.
 *   - Migrations (supabase/migrations/*.sql): checked against a frozen
 *     snapshot of every migration filename that existed when this guard was
 *     last updated (__fixtures__/cam-legacy-guard-migration-baseline.json).
 *     Every migration up to and including this repair is already-applied
 *     history that legitimately mentions these objects somewhere in their
 *     lifecycle (create, alter, rename, archive) and must never be edited —
 *     so the baseline, not an inline marker, is what allows them. Any
 *     migration file NOT in that snapshot (i.e. added after this guard was
 *     written) that references cam_profiles/cam_calculations is a real,
 *     new violation — exactly the class of bug (34 silently recreating
 *     cam_profiles after 29 had archived it) this half of the guard exists
 *     to catch going forward. Extending the baseline to include a
 *     legitimately new archival/repair migration is a deliberate, reviewed
 *     action, not something the guard should infer on its own.
 *   - One-off historical SQL utilities under scripts/ (paste-and-run
 *     migration bundles, point-in-time preflight diagnostics) are out of
 *     scope: nobody re-runs or extends them going forward, so they carry no
 *     ongoing risk of reintroducing a live reference the way application
 *     code or a new migration would.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../");

const RETIRED_SYMBOL_MATCHERS = [
  { symbol: "cam_profiles", test: (line) => line.includes("cam_profiles") },
  { symbol: "cam_calculations", test: (line) => line.includes("cam_calculations") },
  // "compute-cam" also shows up as plain prose in unrelated shared-utility
  // comments (e.g. "compute-cam's lock/historical lookups", describing
  // snapshot-identity design history) that have nothing to do with actually
  // invoking it. Only flag it as a string literal -- an invocation, job
  // name, or mapping key -- not as a word inside a comment.
  { symbol: "compute-cam", test: (line) => line.includes('"compute-cam"') || line.includes("'compute-cam'") },
  { symbol: "fetchPropertyCamConfig", test: (line) => line.includes("fetchPropertyCamConfig") },
  { symbol: "savePropertyCamConfig", test: (line) => line.includes("savePropertyCamConfig") },
  { symbol: "CAMCalculationService", test: (line) => line.includes("CAMCalculationService") },
];

const SCAN_ROOTS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "supabase", "functions"),
  path.join(REPO_ROOT, "scripts"),
];

const EXCLUDED_DIR_NAMES = new Set(["__tests__", "_tests", "node_modules", "dist", "build", ".git", "migrations"]);

const SCAN_EXTENSIONS = /\.(js|jsx|ts|tsx|mjs)$/;

// Whole-file exemptions: files whose entire purpose is documenting/guarding
// the retirement itself, where line-by-line marker annotation would be noise.
const FILE_ALLOWLIST = new Set([
  path.join("src", "services", "camConfig.js"),
  path.join("src", "lib", "__tests__", "cam-canonical-ownership-ci.test.js"),
  // Whole-file retirement stubs -- every line in these files exists to
  // announce the retirement, unlike approved-lease-expense-rules.ts or
  // compute-revenue.ts where retirement is one small part of a large,
  // otherwise-live file that still deserves line-level scanning.
  path.join("supabase", "functions", "approve-cam-profile", "index.ts"),
  path.join("supabase", "functions", "save-cam-profile", "index.ts"),
  // One-off historical codemod scripts (renamed CAMCalculationService
  // references during a past refactor) -- not live application code, and
  // not re-run or extended going forward.
  path.join("scripts", "migrate-components.mjs"),
  path.join("scripts", "migrate-services.mjs"),
]);

const INLINE_ALLOW_MARKER = "cam-legacy-scan-allow:";
// How many lines above a match to search for the marker -- generous enough
// to cover a marker placed once at the top of a multi-line explanatory
// comment block, without being so wide it accidentally exempts unrelated
// code further down in a large, otherwise-live file.
const MARKER_LOOKBACK_LINES = 12;

function getAllFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    if (fs.statSync(entryPath).isDirectory()) {
      if (!EXCLUDED_DIR_NAMES.has(entry)) {
        getAllFiles(entryPath, fileList);
      }
    } else if (SCAN_EXTENSIONS.test(entry)) {
      fileList.push(entryPath);
    }
  }
  return fileList;
}

describe("CAM Canonical Ownership CI Guard", () => {
  it("ensures no runtime code references retired legacy CAM objects outside an explicit allowlist", () => {
    const files = SCAN_ROOTS.flatMap((root) => getAllFiles(root));
    const violations = [];

    for (const filePath of files) {
      const relativePath = path.relative(REPO_ROOT, filePath);
      if (FILE_ALLOWLIST.has(relativePath)) continue;

      const lines = fs.readFileSync(filePath, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const windowStart = Math.max(0, i - MARKER_LOOKBACK_LINES);
        const isAllowed = lines
          .slice(windowStart, i + 1)
          .some((l) => l.includes(INLINE_ALLOW_MARKER));
        if (isAllowed) continue;

        for (const { symbol, test } of RETIRED_SYMBOL_MATCHERS) {
          if (test(line)) {
            violations.push({ file: relativePath, line: i + 1, symbol });
          }
        }
      }
    }

    if (violations.length > 0) {
      console.error("Found retired legacy CAM references in runtime code:", violations);
    }
    expect(violations).toEqual([]);
  });

  it("ensures no new migration (added after this guard's baseline) references retired legacy CAM tables", () => {
    const migrationsDir = path.join(REPO_ROOT, "supabase", "migrations");
    const baselinePath = path.join(__dirname, "__fixtures__", "cam-legacy-guard-migration-baseline.json");
    const baseline = new Set(JSON.parse(fs.readFileSync(baselinePath, "utf-8")));
    const migrationTableSymbols = ["cam_profiles", "cam_calculations"];

    const files = fs.existsSync(migrationsDir)
      ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"))
      : [];
    const violations = [];

    for (const file of files) {
      if (baseline.has(file)) continue;
      const content = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      for (const symbol of migrationTableSymbols) {
        if (content.includes(symbol)) {
          violations.push({ file, symbol });
        }
      }
    }

    if (violations.length > 0) {
      console.error("Found a new migration referencing retired legacy CAM tables outside the frozen baseline:", violations);
    }
    expect(violations).toEqual([]);
  });
});
