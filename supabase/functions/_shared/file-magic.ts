// @ts-nocheck
/**
 * Cheap magic-byte sniffing — no parsing, no external calls. Used both to
 * guard against sending a non-document (e.g. an HTML error page leaked from
 * a CDN) into the extraction pipeline, and as the "basic document type
 * guess" surfaced in upload-handler's preflight response before a user
 * confirms extraction should proceed.
 */
export function detectFileMagic(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length < 4) return null;
  // %PDF
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "jpeg";
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "png";
  // GIF: 47 49 46 38
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
  // TIFF: 49 49 2A 00 or 4D 4D 00 2A
  if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2A) ||
      (bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[3] === 0x2A)) return "tiff";
  // WEBP: RIFF....WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "webp_or_riff";
  // ZIP-based Office formats (docx/xlsx): PK\x03\x04
  if (bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) return "zip_office";
  // HTML error page leaked from CDN — anything starting with "<" or "<!"
  const lead = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]).toLowerCase();
  if (lead.startsWith("<!do") || lead.startsWith("<htm") || lead.startsWith("<?xm")) return "html_or_xml";
  return null;
}

const MAGIC_TO_DOC_TYPE_GUESS: Record<string, string> = {
  pdf: "pdf",
  jpeg: "image",
  png: "image",
  gif: "image",
  tiff: "image",
  webp_or_riff: "image",
  zip_office: "office_document",
  html_or_xml: "unexpected_content",
};

/** Coarse, cheap "what kind of document is this" guess for preflight display. */
export function guessDocumentType(bytes: Uint8Array, mimeType?: string | null, fileName?: string | null): string {
  const magic = detectFileMagic(bytes);
  if (magic && MAGIC_TO_DOC_TYPE_GUESS[magic]) return MAGIC_TO_DOC_TYPE_GUESS[magic];
  const ext = String(fileName ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (["csv", "tsv"].includes(ext) || mimeType === "text/csv") return "csv";
  if (["xls", "xlsx"].includes(ext) || mimeType?.includes("spreadsheetml") || mimeType === "application/vnd.ms-excel") return "spreadsheet";
  if (["doc", "docx"].includes(ext) || mimeType?.includes("wordprocessingml") || mimeType === "application/msword") return "office_document";
  if (ext === "txt" || mimeType === "text/plain") return "text";
  return "unknown";
}
