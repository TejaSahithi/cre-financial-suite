import { readFieldValue } from "@/lib/leaseReviewSchema";
import {
  entryValue,
  getEvidenceRecordForKey,
  validEvidenceRecord,
} from "./fieldExtractors";

export function buildSearchBlocks(docling) {
  const blocks = [];
  const raw = Array.isArray(docling?.text_blocks) ? docling.text_blocks : [];
  for (const block of raw) {
    const text = String(block?.text ?? "").trim();
    if (!text) continue;
    const explicitPage = block?.page ?? block?.page_number ?? block?.source_page;
    blocks.push({
      text,
      lowered: text.toLowerCase(),
      page: Number.isFinite(Number(explicitPage))
        ? Number(explicitPage)
        : raw.length === 1
          ? 1
        : null,
    });
  }
  // Add full_text as a fallback block with unknown page so single-page
  // documents still resolve.
  if (docling?.full_text && blocks.length === 0) {
    blocks.push({
      text: String(docling.full_text),
      lowered: String(docling.full_text).toLowerCase(),
      page: null,
    });
  }
  return blocks;
}

export function pushDocumentTextBlock(blocks, text, page = null) {
  const cleaned = String(text ?? "").trim();
  if (!cleaned) return;
  blocks.push({
    text: cleaned,
    lowered: cleaned.toLowerCase(),
    page: Number.isFinite(Number(page)) ? Number(page) : null,
  });
}

export function buildSearchBlocksFromSources(...sources) {
  const blocks = [];
  const visit = (source, depth = 0) => {
    if (!source || depth > 4) return;
    if (typeof source === "string") {
      pushDocumentTextBlock(blocks, source, null);
      return;
    }
    if (Array.isArray(source)) {
      for (const item of source) visit(item, depth + 1);
      return;
    }
    if (typeof source !== "object") return;

    for (const block of buildSearchBlocks(source)) {
      pushDocumentTextBlock(blocks, block.text, block.page);
    }
    if (Array.isArray(source.pages)) {
      for (const page of source.pages) {
        pushDocumentTextBlock(
          blocks,
          page?.text ?? page?.content ?? page?.markdown ?? page?.full_text,
          page?.page ?? page?.page_number ?? page?.number,
        );
      }
    }

    pushDocumentTextBlock(blocks, source.full_text, null);
    pushDocumentTextBlock(blocks, source.raw_text, null);
    pushDocumentTextBlock(blocks, source.text, null);
    pushDocumentTextBlock(blocks, source.markdown, null);
    pushDocumentTextBlock(blocks, source.body, null);

    // Visit likely payload containers. metadata is included because some
    // pipeline versions store Docling text or page arrays there.
    visit(source.records, depth + 1);
    visit(source.rows, depth + 1);
    visit(source.standard_fields, depth + 1);
    visit(source.custom_fields, depth + 1);
    visit(source.fields, depth + 1);
    visit(source.evidence, depth + 1);
    visit(source.metadata, depth + 1);
    visit(source.workflow_output, depth + 1);
  };

  for (const source of sources) visit(source);

  const seen = new Set();
  return blocks.filter((block) => {
    const key = `${block.page ?? ""}|${block.text.slice(0, 240)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Generic / sentinel values that produce false matches if we text-search
// for them anywhere in the document. The extractor sometimes stores these
// as a literal string when it couldn't read the field — they should not
// generate evidence.
export const JUNK_NEEDLE_VALUES = new Set([
  "unknown", "n/a", "na", "none", "null", "tbd", "not specified",
  "not applicable", "see lease", "as set forth", "per lease",
  // Internal/category-key shaped strings the workflow sometimes leaks.
  "renewal_options", "tax_responsibility", "insurance_responsibility",
  "maintenance_responsibility", "utilities_responsibility",
  "hvac", "cam", "nnn", "gross", "full_service", "modified_gross",
]);

export function isJunkNeedle(text) {
  if (!text) return true;
  const lowered = String(text).trim().toLowerCase();
  if (lowered.length < 4) return true;             // single words / 3-char tokens match too broadly
  if (JUNK_NEEDLE_VALUES.has(lowered)) return true;
  // category-key shape: lowercase + underscores, no spaces, no digits
  if (/^[a-z]+(?:_[a-z]+)+$/.test(lowered)) return true;
  // pure number under 4 digits (matches in too many places — page numbers, list indices)
  if (/^\d{1,3}$/.test(lowered)) return true;
  return false;
}

// Normalize a value for matching: lowercase, currency stripped, common
// punctuation removed. Produces a set of candidate needles to try, with
// junk filtered out.
export function candidateNeedles(value, field) {
  const needles = [];
  const push = (s) => {
    const t = String(s ?? "").trim();
    if (!t) return;
    if (isJunkNeedle(t)) return;
    if (!needles.includes(t)) needles.push(t);
  };
  const asString = String(value ?? "").trim();
  if (!asString) return needles;
  if (isJunkNeedle(asString)) return needles;
  push(asString);

  // Currency / numeric: try with and without thousands separators, with $.
  if (field?.type === "currency" || field?.type === "number") {
    const num = Number(String(value).replace(/[$,%\s,]/g, ""));
    if (Number.isFinite(num) && num >= 1000) {
      // Skip small numbers — they match too broadly (page numbers, "Unit 5", etc.)
      push(num.toString());
      push(num.toLocaleString("en-US"));
      push(`$${num.toLocaleString("en-US")}`);
      push(`$${num.toFixed(2)}`);
      push(`${num.toLocaleString("en-US")}.00`);
    }
  }

  // Dates: try several human formats around an ISO date.
  if (field?.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(asString)) {
    const d = new Date(`${asString}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const monthsShort = months.map((m) => m.slice(0, 3));
      const y = d.getUTCFullYear();
      const m1 = d.getUTCMonth();
      const day = d.getUTCDate();
      push(`${months[m1]} ${day}, ${y}`);
      push(`${monthsShort[m1]} ${day}, ${y}`);
      push(`${m1 + 1}/${day}/${y}`);
      push(`${String(m1 + 1).padStart(2, "0")}/${String(day).padStart(2, "0")}/${y}`);
    }
  }

  // Entity names: try without trailing punctuation.
  if (field?.type === "text" || field?.type === undefined) {
    push(asString.replace(/[,.]+$/, ""));
  }
  return needles;
}

const SOURCE_SNIPPET_MAX_CHARS = 900;
const SOURCE_SNIPPET_LOOKBACK = 450;
const SOURCE_SNIPPET_LOOKAHEAD = 650;
const SOURCE_ABBREVIATIONS = new Set([
  "co", "corp", "inc", "ltd", "llc", "lp", "llp", "mr", "mrs", "ms", "dr",
  "jr", "sr", "st", "ave", "blvd", "rd", "ste", "suite", "no", "jan", "feb",
  "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

function cleanSourceSnippet(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function skipSourceBoundaryPadding(text, index) {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function isSourceSentenceEnd(text, index) {
  const char = text[index];
  if (!".!?".includes(char)) return false;

  if (char === ".") {
    const before = text[index - 1] || "";
    const after = text[index + 1] || "";
    if (/\d/.test(before) && /\d/.test(after)) return false;

    const wordMatch = text.slice(Math.max(0, index - 16), index).match(/([A-Za-z]+)$/);
    if (wordMatch && SOURCE_ABBREVIATIONS.has(wordMatch[1].toLowerCase())) return false;
  }

  let cursor = index + 1;
  while (cursor < text.length && /["')\]]/.test(text[cursor])) cursor += 1;
  return cursor >= text.length || /\s/.test(text[cursor]);
}

function isCleanSnippetStart(snippet) {
  return (
    /^[A-Za-z][^:]{0,90}:\s\S/.test(snippet) ||
    /^\d+(?:\.\d+)*[.)]?\s+[A-Z]/.test(snippet) ||
    /^[A-Z0-9"'(]/.test(snippet)
  );
}

function boundedSourceSnippet(text, matchStart, matchLength) {
  const source = cleanSourceSnippet(text);
  if (!source) return "";

  if (source.length <= SOURCE_SNIPPET_MAX_CHARS && /^[A-Za-z][^:]{0,90}:\s\S/.test(source)) return source;
  if (source.length <= SOURCE_SNIPPET_MAX_CHARS && /^\d+(?:\.\d+)*[.)]?\s+[A-Z]/.test(source)) return source;

  const safeMatchStart = Math.max(0, Math.min(matchStart, source.length));
  const safeMatchEnd = Math.max(safeMatchStart, Math.min(source.length, safeMatchStart + matchLength));
  const searchStart = Math.max(0, safeMatchStart - SOURCE_SNIPPET_LOOKBACK);
  const searchEnd = Math.min(source.length, safeMatchEnd + SOURCE_SNIPPET_LOOKAHEAD);

  let start = safeMatchStart === 0 ? 0 : null;
  for (let i = safeMatchStart - 1; i >= searchStart; i -= 1) {
    if (isSourceSentenceEnd(source, i)) {
      start = skipSourceBoundaryPadding(source, i + 1);
      break;
    }
  }
  if (start == null && searchStart === 0) start = 0;
  if (start == null) return "";

  let end = null;
  for (let i = safeMatchEnd; i < searchEnd; i += 1) {
    if (isSourceSentenceEnd(source, i)) {
      end = i + 1;
      break;
    }
  }
  if (end == null && searchEnd === source.length) end = source.length;
  if (end == null) return "";

  const snippet = cleanSourceSnippet(source.slice(start, end));
  if (!snippet || snippet.length > SOURCE_SNIPPET_MAX_CHARS || !isCleanSnippetStart(snippet)) return "";
  if (!/[.!?]["')\]]?$/.test(snippet) && !/^[A-Za-z][^:]{0,90}:\s\S/.test(snippet)) return "";
  return snippet;
}

/**
 * Expand a match offset to the nearest complete sentence, labeled-row, or
 * numbered-clause boundary so reviewers always see a full, readable snippet.
 *
 * Priority:
 *   1. Entire block is a short labeled row ("Label: value") → return the
 *      whole row, quality = "exact".
 *   2. Entire block starts with a numbered section ("4.2 Full Service…") and
 *      is short enough to quote in full → return the whole block, quality = "exact".
 *   3. Otherwise walk backward to the nearest newline / sentence-start and
 *      forward to the next sentence-end (period + space/newline).
 *      - If the found start itself begins a numbered clause, extend forward
 *        to the next numbered-clause boundary (next "N. " or "N.N ").
 *   4. Hard-cap LOOKBACK/LOOKAHEAD at 300 chars each direction.
 *
 * Returns `{ snippet, source_quality }` where source_quality is:
 *   "exact"   — labeled row, numbered clause, or sentence ending with punctuation
 *   "partial" — boundary not found; snippet is a mid-sentence fragment
 */
export function expandToSentenceBoundary(text, matchStart, matchLength) {
  const boundedSnippet = boundedSourceSnippet(text, matchStart, matchLength);
  return { snippet: boundedSnippet, source_quality: boundedSnippet ? "exact" : "partial" };

  // 1. Short labeled row — return the whole cleaned block.
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length < 400 && /^[A-Za-z][^:\n]{0,80}:\s\S/.test(singleLine)) {
    return { snippet: singleLine, source_quality: "exact" };
  }

  // 2. Short numbered clause block (e.g., "4.2 Full Service Lease. …").
  if (singleLine.length < 600 && /^\d+(?:\.\d+)*\s+[A-Z]/.test(singleLine)) {
    return { snippet: singleLine, source_quality: "exact" };
  }

  const LOOKBACK = 300;
  const LOOKAHEAD = 300;

  // 3. Walk backward to sentence / row start.
  let start = matchStart;
  for (let i = matchStart - 1; i >= Math.max(0, matchStart - LOOKBACK); i--) {
    const c = text[i];
    if (c === "\n") { start = i + 1; break; }
    if (c === "." && i + 1 < text.length && text[i + 1] === " ") { start = i + 2; break; }
    if (i === Math.max(0, matchStart - LOOKBACK)) { start = i; break; }
  }

  // 3a. If the found start begins a numbered clause, walk forward to the next
  //     numbered-clause header ("\n1." / "\n4.2 ") or to a double-newline so
  //     we capture the full clause rather than just one sentence.
  const fromStart = text.slice(start);
  const startsWithNumberedClause = /^\d+(?:\.\d+)*\s+[A-Z]/.test(fromStart);

  let end = matchStart + matchLength;
  if (startsWithNumberedClause) {
    // Find next numbered-clause boundary — a newline followed by digits+dot.
    const nextClauseRel = fromStart.slice(1).search(/\n\d+(?:\.\d+)*\s/);
    if (nextClauseRel > 0 && nextClauseRel < 500) {
      end = start + 1 + nextClauseRel;
    } else {
      // No next clause found; just take the rest of the block up to 500 chars.
      end = Math.min(text.length, start + 500);
    }
  } else {
    // 4. Walk forward to nearest sentence end (period + space/newline/EOS).
    for (let i = end; i < Math.min(text.length, matchStart + matchLength + LOOKAHEAD); i++) {
      const c = text[i];
      if (c === "\n") { end = i + 1; break; }
      if (c === "!") { end = i + 1; break; }
      if (c === "." && (i + 1 >= text.length || text[i + 1] === " " || text[i + 1] === "\n")) {
        end = i + 1;
        break;
      }
      if (i === Math.min(text.length, matchStart + matchLength + LOOKAHEAD) - 1) {
        end = i + 1;
        break;
      }
    }
  }

  const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();

  // 5. Determine quality.
  const isLabeledRow = /^[A-Za-z][^:\n]{0,80}:\s\S/.test(snippet);
  const isNumberedClause = /^\d+(?:\.\d+)*\s+[A-Z]/.test(snippet);
  const endsWithPunct = /[.!?]["']?\s*$/.test(snippet);
  const source_quality = isLabeledRow || isNumberedClause || endsWithPunct ? "exact" : "partial";

  return { snippet, source_quality };
}

export function findEvidenceForValue(blocks, value, field) {
  const needles = candidateNeedles(value, field);
  if (needles.length === 0) return null;
  for (const needle of needles) {
    const loweredNeedle = needle.toLowerCase();
    for (const block of blocks) {
      const hit = block.lowered.indexOf(loweredNeedle);
      if (hit < 0) continue;
      // Require a word-boundary on at least one side so "1110" doesn't match
      // inside "11102025" or a page footer like "Page 1110".
      const before = hit === 0 ? "" : block.lowered[hit - 1];
      const after = block.lowered[hit + loweredNeedle.length] || "";
      const isWordChar = (c) => /[a-z0-9]/.test(c);
      if (isWordChar(before) && isWordChar(after)) continue;
      const { snippet, source_quality } = expandToSentenceBoundary(block.text, hit, needle.length);
      if (!snippet) continue;
      return {
        raw: block.text.slice(hit, hit + needle.length),
        text: snippet,
        page: block.page,
        source_quality,
      };
    }
  }
  return null;
}

export function numericValue(value) {
  const n = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function buildCalculatedSupportingEvidence({ key, value, lease, ed, fieldEvidence, fieldsWithEvidence }) {
  const monthly = numericValue(value);
  const annual = numericValue(readFieldValue(lease, "annual_rent") ?? entryValue(ed?.fields?.annual_rent));
  const squareFeet = numericValue(readFieldValue(lease, "square_footage") ?? entryValue(ed?.fields?.square_footage));
  const sourceForAnnual = validEvidenceRecord(
    getEvidenceRecordForKey(fieldEvidence, fieldsWithEvidence, ed, "annual_rent")
      || getEvidenceRecordForKey(fieldEvidence, fieldsWithEvidence, ed, "base_rent_annual"),
  );
  const sourceForMonthly = validEvidenceRecord(
    getEvidenceRecordForKey(fieldEvidence, fieldsWithEvidence, ed, "monthly_rent")
      || getEvidenceRecordForKey(fieldEvidence, fieldsWithEvidence, ed, "base_rent_monthly"),
  );
  const sourceForSqft = validEvidenceRecord(
    getEvidenceRecordForKey(fieldEvidence, fieldsWithEvidence, ed, "square_footage")
      || getEvidenceRecordForKey(fieldEvidence, fieldsWithEvidence, ed, "rentable_area_sqft")
      || getEvidenceRecordForKey(fieldEvidence, fieldsWithEvidence, ed, "tenant_rsf"),
  );

  if ((key === "monthly_rent" || key === "base_rent_monthly") && monthly && annual && Math.abs((annual / 12) - monthly) < 1) {
    const supporting = sourceForAnnual || sourceForMonthly;
    if (supporting) {
      return {
        raw_value: supporting.raw_value ?? String(annual),
        source_page: supporting.source_page,
        source_text: supporting.source_text,
        extraction_status: "calculated",
      };
    }
  }

  if ((key === "rent_per_sf" || key === "tenant_rent_per_rsf") && monthly && annual && squareFeet) {
    const expected = annual / squareFeet;
    if (Math.abs(expected - monthly) < 0.25) {
      const supporting = sourceForAnnual || sourceForSqft;
      if (supporting) {
        return {
          raw_value: supporting.raw_value ?? String(annual),
          source_page: supporting.source_page,
          source_text: supporting.source_text,
          extraction_status: "calculated",
        };
      }
    }
  }

  if ((key === "annual_rent" || key === "base_rent_annual") && monthly && sourceForMonthly) {
    const monthlyRent = numericValue(readFieldValue(lease, "monthly_rent") ?? entryValue(ed?.fields?.monthly_rent));
    if (monthlyRent && Math.abs((monthlyRent * 12) - monthly) < 1) {
      return {
        raw_value: sourceForMonthly.raw_value ?? String(monthlyRent),
        source_page: sourceForMonthly.source_page,
        source_text: sourceForMonthly.source_text,
        extraction_status: "calculated",
      };
    }
  }

  return null;
}
