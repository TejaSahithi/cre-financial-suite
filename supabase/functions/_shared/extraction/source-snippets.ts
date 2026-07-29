// @ts-nocheck

export const SOURCE_SNIPPET_MAX_CHARS = 900;
const SOURCE_SNIPPET_LOOKBACK = 450;
const SOURCE_SNIPPET_LOOKAHEAD = 650;

const SOURCE_ABBREVIATIONS = new Set([
  "co", "corp", "inc", "ltd", "llc", "lp", "llp", "mr", "mrs", "ms", "dr",
  "jr", "sr", "st", "ave", "blvd", "rd", "ste", "suite", "no", "jan", "feb",
  "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

export function cleanSourceSnippetText(value: unknown) {
  return String(value ?? "")
    .replace(/\[\[\s*PAGE\s+\d+\s*\]\]/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(?:td|th|tr|p|div|li|h[1-6])>/gi, " ")
    .replace(/<(?:td|th|tr|table|tbody|thead|p|div|span|li|ul|ol|h[1-6])\b[^>]*>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function skipSourceBoundaryPadding(text: string, index: number) {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function isSourceSentenceEnd(text: string, index: number) {
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

export function isCleanSnippetStart(snippet: string) {
  return (
    /^[A-Za-z][^:]{0,90}:\s\S/.test(snippet) ||
    /^\d+(?:\.\d+)*[.)]?\s+[A-Z]/.test(snippet) ||
    /^[A-Z0-9"'(]/.test(snippet) ||
    /^(approximately|suite|unit|space|monthly|annual|base rent|rent|permitted use|broker|address|landlord|tenant)\b/i.test(snippet)
  );
}

export function isShortCompleteSourceRow(
  snippet: string,
  options: { requireLabelOrNumbered?: boolean } = {},
) {
  if (!snippet || snippet.length > 260) return false;
  if (/\.{3}|…/.test(snippet)) return false;
  const isLabeledRow = /^[A-Za-z][^:]{0,90}:\s\S/.test(snippet);
  const isNumberedRow = /^\d+(?:\.\d+)*[.)]?\s+[A-Z]/.test(snippet);
  const isShortValueRow =
    /^(suite|unit|space|monthly|annual|base rent|rent|permitted use|broker|address|landlord|tenant)\b/i.test(snippet) &&
    !/[.!?]\s+\S/.test(snippet);
  if (options.requireLabelOrNumbered && !isLabeledRow && !isNumberedRow && !isShortValueRow) return false;
  if (!options.requireLabelOrNumbered && !isCleanSnippetStart(snippet)) return false;
  const partyMarkerCount = (snippet.match(/\b(?:landlord|tenant|lessee|lessor|address of landlord|address of tenant)\b/gi) || []).length;
  return partyMarkerCount <= 2;
}

export function expandSourceSnippetFromMatch(
  text: string,
  matchStart: number,
  matchLength: number,
  options: number | {
    maxChars?: number;
    clean?: (value: unknown) => string;
    requireLabelOrNumberedShortRow?: boolean;
  } = {},
) {
  const normalizedOptions = typeof options === "number" ? { maxChars: options } : options;
  const clean = normalizedOptions.clean ?? cleanSourceSnippetText;
  const source = clean(text);
  if (!source) return null;
  const limit = Math.max(420, Math.min(normalizedOptions.maxChars ?? SOURCE_SNIPPET_MAX_CHARS, SOURCE_SNIPPET_MAX_CHARS));

  if (isShortCompleteSourceRow(source, { requireLabelOrNumbered: normalizedOptions.requireLabelOrNumberedShortRow })) return source;
  if (source.length <= limit && isCleanSnippetStart(source)) return source;

  const safeMatchStart = Math.max(0, Math.min(matchStart, source.length));
  const safeMatchEnd = Math.max(safeMatchStart, Math.min(source.length, safeMatchStart + matchLength));
  const searchStart = Math.max(0, safeMatchStart - SOURCE_SNIPPET_LOOKBACK);
  const searchEnd = Math.min(source.length, safeMatchEnd + SOURCE_SNIPPET_LOOKAHEAD);

  let start: number | null = safeMatchStart === 0 ? 0 : null;
  for (let i = safeMatchStart - 1; i >= searchStart; i -= 1) {
    if (isSourceSentenceEnd(source, i)) {
      start = skipSourceBoundaryPadding(source, i + 1);
      break;
    }
  }
  if (start == null && searchStart === 0) start = 0;
  if (start == null) return null;

  let end: number | null = null;
  for (let i = safeMatchEnd; i < searchEnd; i += 1) {
    if (isSourceSentenceEnd(source, i)) {
      end = i + 1;
      break;
    }
  }
  if (end == null && searchEnd === source.length) end = source.length;
  if (end == null) return null;

  const snippet = clean(source.slice(start, end));
  if (!snippet || snippet.length > limit || !isCleanSnippetStart(snippet)) return null;
  if (!/[.!?]["')\]]?$/.test(snippet) && !/^[A-Za-z][^:]{0,90}:\s\S/.test(snippet)) return null;
  return snippet;
}
