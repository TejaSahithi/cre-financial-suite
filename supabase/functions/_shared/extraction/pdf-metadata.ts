// @ts-nocheck

/**
 * Best-effort independent PDF page-count signal.
 *
 * This intentionally logs no document content and never throws. It prefers a
 * conservative structural scan over adding a new parser dependency; compressed
 * or encrypted PDFs may return null, which is safer than a fabricated count.
 */
export function extractPdfPageCountFromBytes(bytes: Uint8Array): number | null {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length < 8) return null;
    const head = ascii(bytes.subarray(0, Math.min(bytes.length, 1024)));
    if (!head.startsWith("%PDF-")) return null;

    const sampleLimit = Math.min(bytes.length, 4_000_000);
    const text = ascii(bytes.subarray(0, sampleLimit));
    if (/\/Encrypt\b/.test(text)) return null;

    const pageObjectMatches = text.match(/\/Type\s*\/Page\b(?!s)/g) ?? [];
    if (pageObjectMatches.length > 0) return pageObjectMatches.length;

    const countMatches = [...text.matchAll(/\/Count\s+(\d{1,6})\b/g)]
      .map((match) => Number(match[1]))
      .filter((n) => Number.isInteger(n) && n > 0 && n < 100000);
    if (countMatches.length > 0) return Math.max(...countMatches);

    return null;
  } catch {
    return null;
  }
}

function ascii(bytes: Uint8Array): string {
  let text = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return text;
}