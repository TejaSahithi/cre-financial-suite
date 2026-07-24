// @ts-nocheck
/**
 * EvidenceIndex — builds page/keyword-indexed structures over a document's
 * `pages` + `text_blocks` ONCE per request (WeakMap-cached on the docling_raw
 * object reference), so per-field source-page verification no longer
 * re-normalizes the same candidate text and re-scans every candidate for
 * every field. This was the dominant O(fields × all-candidates) cost behind
 * the "not enough compute resources" failures on long Azure-parsed leases —
 * amplified there because Azure fields previously came back with
 * source_page=null (see azure-layout-adapter.ts page-marker fix), forcing
 * every field through the expensive global scan.
 *
 * Public functions keep the same `doclingRaw`-based signatures the call
 * sites already use — this is a drop-in optimization, not a signature
 * change, other than the new optional `proposedPage` parameter on
 * findPageForSnippet.
 */

export interface EvidenceCandidate {
  text: string;
  normalized: string;
  compact: string;
  page: number;
  source: string;
}

export interface EvidenceIndex {
  all: EvidenceCandidate[];
  blocksByPage: Map<number, EvidenceCandidate[]>;
}

export function cleanEvidenceSnippet(value: unknown): string {
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

export function positivePageNumber(value: unknown): number | null {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? page : null;
}

export function normalizeForPageMatch(value: unknown): string {
  return cleanEvidenceSnippet(value)
    .toLowerCase()
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactForPageMatch(value: unknown): string {
  return normalizeForPageMatch(value).replace(/[^a-z0-9]+/g, "");
}

const _indexCache = new WeakMap<object, EvidenceIndex>();

export function buildEvidenceIndex(doclingRaw: Record<string, unknown> | null | undefined): EvidenceIndex {
  if (doclingRaw && _indexCache.has(doclingRaw)) {
    return _indexCache.get(doclingRaw)!;
  }

  const candidates: EvidenceCandidate[] = [];
  const push = (value: unknown, pageValue: unknown, source: string) => {
    const page = positivePageNumber(pageValue);
    const text = cleanEvidenceSnippet(value);
    if (!page || !text) return;
    candidates.push({
      text,
      normalized: normalizeForPageMatch(text),
      compact: compactForPageMatch(text),
      page,
      source,
    });
  };

  const pages = Array.isArray((doclingRaw as any)?.pages) ? (doclingRaw as any).pages : [];
  pages.forEach((page: any, index: number) => {
    push(
      page?.text ?? page?.content ?? page?.markdown ?? page?.full_text,
      page?.page ?? page?.page_number ?? page?.number ?? index + 1,
      "page",
    );
  });

  for (const block of Array.isArray((doclingRaw as any)?.text_blocks) ? (doclingRaw as any).text_blocks : []) {
    push(block?.text, block?.page ?? block?.page_number ?? block?.source_page, "text_block");
  }

  const seen = new Set<string>();
  const all = candidates.filter((candidate) => {
    const key = `${candidate.page}|${candidate.source}|${candidate.normalized.slice(0, 240)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const blocksByPage = new Map<number, EvidenceCandidate[]>();
  for (const candidate of all) {
    if (!blocksByPage.has(candidate.page)) blocksByPage.set(candidate.page, []);
    blocksByPage.get(candidate.page)!.push(candidate);
  }

  const index: EvidenceIndex = { all, blocksByPage };
  if (doclingRaw) _indexCache.set(doclingRaw, index);
  return index;
}

/**
 * Score a candidate against an ALREADY-NORMALIZED snippet. Callers must
 * normalize the snippet once (via normalizeForPageMatch/compactForPageMatch)
 * before looping over candidates — the original implementation re-normalized
 * the same unchanging snippet on every candidate iteration.
 */
function scoreCandidateAgainstSnippet(
  candidate: { normalized: string; compact: string; source: string },
  normalizedSnippet: string,
  compactSnippet: string,
): number {
  if (normalizedSnippet.length < 8) return 0;
  if (candidate.normalized.includes(normalizedSnippet)) return 1000 + Math.min(normalizedSnippet.length, 400);

  if (compactSnippet.length >= 24 && candidate.compact.includes(compactSnippet)) {
    return 900 + Math.min(compactSnippet.length, 300);
  }

  const anchors = [
    normalizedSnippet.slice(0, Math.min(120, normalizedSnippet.length)),
    normalizedSnippet.slice(Math.max(0, normalizedSnippet.length - 120)),
  ].filter((anchor) => anchor.length >= 45);
  for (const anchor of anchors) {
    if (candidate.normalized.includes(anchor)) return 500 + anchor.length;
  }

  const tokens = [...new Set(normalizedSnippet.match(/[a-z0-9$%]{4,}/g) || [])]
    .filter((token) => !["this", "that", "with", "from", "shall", "tenant", "landlord"].includes(token));
  if (tokens.length < 6) return 0;
  const matched = tokens.filter((token) => candidate.normalized.includes(token)).length;
  const ratio = matched / tokens.length;
  if (matched >= 6 && ratio >= 0.82) return 120 + matched * 8 + (candidate.source === "page" ? 6 : 0);
  return 0;
}

// A match at/above this score is a literal or near-literal substring hit —
// strong enough to trust without checking every other page in the document.
const STRONG_MATCH_THRESHOLD = 900;

/**
 * Find the parsed page containing a source snippet. This only trusts real
 * page/text blocks, not LLM field metadata, so a default source_page=1 does
 * not leak into review rows unless the snippet is actually found on page 1.
 *
 * When `proposedPage` is given (e.g. the LLM's or workflow's claimed
 * source_page), that page's candidates are checked FIRST; a strong match
 * short-circuits immediately. Falls back to the full global scan otherwise —
 * identical result surface to always scanning globally, just cheaper for the
 * common case where the proposed page is correct.
 */
export function findPageForSnippet(
  doclingRaw: Record<string, unknown> | null | undefined,
  snippet: string,
  proposedPage?: number | null,
): number | null {
  if (!doclingRaw || !snippet) return null;
  const normalizedSnippet = normalizeForPageMatch(snippet);
  if (normalizedSnippet.length < 8) return null;
  const compactSnippet = compactForPageMatch(snippet);

  const index = buildEvidenceIndex(doclingRaw);

  if (proposedPage != null) {
    const onPage = index.blocksByPage.get(proposedPage);
    if (onPage && onPage.length > 0) {
      let bestOnPage: { page: number; score: number } | null = null;
      for (const candidate of onPage) {
        const score = scoreCandidateAgainstSnippet(candidate, normalizedSnippet, compactSnippet);
        if (score <= 0) continue;
        if (!bestOnPage || score > bestOnPage.score) bestOnPage = { page: candidate.page, score };
      }
      if (bestOnPage && bestOnPage.score >= STRONG_MATCH_THRESHOLD) return bestOnPage.page;
    }
  }

  let best: { page: number; score: number } | null = null;
  for (const candidate of index.all) {
    const score = scoreCandidateAgainstSnippet(candidate, normalizedSnippet, compactSnippet);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { page: candidate.page, score };
  }
  return best?.page ?? null;
}

export function resolveVerifiedSourcePage(
  doclingRaw: Record<string, unknown> | null | undefined,
  sourceText: string | null,
  proposedPage: unknown,
): number | null {
  const proposed = positivePageNumber(proposedPage);
  if (sourceText) {
    const verified = findPageForSnippet(doclingRaw, sourceText, proposed);
    if (verified != null) return verified;
  }

  if (!proposed) return null;
  const index = buildEvidenceIndex(doclingRaw);
  const pageNumbers = new Set(index.all.map((candidate) => candidate.page));
  return pageNumbers.size === 1 && pageNumbers.has(proposed) ? proposed : null;
}
