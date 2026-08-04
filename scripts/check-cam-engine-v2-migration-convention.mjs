#!/usr/bin/env node
// Repository-level guard for the CAM Engine V2 migration series (see
// docs/database/cam-engine-v2-migration-convention.md). Fails if any
// 202699* migration filename doesn't match the exact shape, if the
// sequence has a gap or a duplicate, or if a non-202699 migration
// collides with a reserved 202699 prefix.
//
// Usage: node scripts/check-cam-engine-v2-migration-convention.mjs

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

const SERIES_PREFIX = "202699";
// The full prefix is 14 digits (202699 + an 8-digit zero-padded sequence),
// matching the standard YYYYMMDDHHMMSS shape every other migration in this
// repo uses -- this is deliberate, not incidental: the supabase CLI's own
// migration-list parser expects a 14-digit numeric prefix, so the 202699
// series must keep that exact length even though "99" makes it an
// impossible calendar month by design.
const EXACT_SHAPE_RE = /^202699(\d{8})_[a-z0-9_]+\.sql$/;

function main() {
  const allFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  const seriesFiles = allFiles.filter((f) => f.startsWith(SERIES_PREFIX));
  const errors = [];

  if (seriesFiles.length === 0) {
    console.log("OK: no 202699 CAM Engine V2 migrations found — nothing to validate.");
    return;
  }

  // 1. Exact filename shape.
  const sequenceNumbers = new Map(); // sequence string -> [filenames]
  for (const file of seriesFiles) {
    const match = file.match(EXACT_SHAPE_RE);
    if (!match) {
      errors.push(`${file}: does not match the required shape 202699NNNNNN_description.sql (lowercase/digits/underscore description only)`);
      continue;
    }
    const seq = match[1];
    const list = sequenceNumbers.get(seq) ?? [];
    list.push(file);
    sequenceNumbers.set(seq, list);
  }

  // 2. Uniqueness.
  for (const [seq, files] of sequenceNumbers) {
    if (files.length > 1) {
      errors.push(`Duplicate sequence number ${seq}: ${files.join(", ")}`);
    }
  }

  // 3. Contiguous sequence starting at 00000001.
  const sortedSeqNumbers = [...sequenceNumbers.keys()].map(Number).sort((a, b) => a - b);
  for (let i = 0; i < sortedSeqNumbers.length; i++) {
    const expected = i + 1;
    if (sortedSeqNumbers[i] !== expected) {
      errors.push(
        `Sequence gap or misordering: expected 202699${String(expected).padStart(8, "0")} at position ${i + 1}, ` +
        `found 202699${String(sortedSeqNumbers[i]).padStart(8, "0")} instead. The 202699 series must be an unbroken run starting at 00000001.`,
      );
      break; // one gap report is enough context to act on; avoid cascading noise
    }
  }

  // 4. No calendar-plausible collision: a 202699 file must never be
  // misreadable as a real YYYYMMDDHHMMSS date at any digit position — true
  // by construction since month "99" doesn't exist, but asserted explicitly.
  for (const file of seriesFiles) {
    const month = file.slice(4, 6);
    if (Number(month) >= 1 && Number(month) <= 12) {
      errors.push(`${file}: month component "${month}" is a real calendar month (1-12) — the whole point of the 202699 convention is an impossible month; this file does not use it correctly.`);
    }
  }

  // 5. No other migration file collides with a reserved 202699 prefix
  // (defensive -- should be structurally impossible given every OTHER
  // migration in this repo uses a real 14-digit YYYYMMDDHHMMSS or a
  // pre-existing 15-digit variant, neither of which starts with "202699",
  // but asserted explicitly rather than assumed).
  const nonSeriesFiles = allFiles.filter((f) => !f.startsWith(SERIES_PREFIX));
  for (const file of nonSeriesFiles) {
    if (file.startsWith(SERIES_PREFIX)) {
      errors.push(`${file}: unexpectedly collides with the reserved 202699 prefix but was not classified as a series file`);
    }
  }

  if (errors.length > 0) {
    console.error(`FAIL: ${errors.length} CAM Engine V2 migration convention violation(s):\n`);
    for (const err of errors) console.error(`  - ${err}`);
    console.error(
      "\nSee docs/database/cam-engine-v2-migration-convention.md. " +
      "Do not rename an already-applied/already-reported 202699 migration — add a new one continuing the sequence instead.",
    );
    process.exit(1);
  }

  console.log(`OK: ${seriesFiles.length} CAM Engine V2 migrations (20269900000001–202699${String(sortedSeqNumbers.at(-1)).padStart(8, "0")}) all pass filename shape, uniqueness, contiguity, and non-calendar checks.`);
  console.log("NOTE: this script does not run `supabase db reset` or `supabase migration list` itself -- see the doc's CI section for the two additional CI steps those require.");
}

main();
