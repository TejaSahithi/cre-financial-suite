// @ts-nocheck
/**
 * File Type & Module Type Detection
 *
 * Detects:
 *   - fileFormat: 'csv' | 'xlsx' | 'xls' | 'pdf' | 'text' | 'unknown'
 *   - moduleType: 'leases' | 'expenses' | 'properties' | 'revenue' | 'cam' | 'budgets' | 'unknown'
 *
 * Detection strategy (in priority order):
 *   1. MIME type (most reliable when set correctly)
 *   2. File extension from filename
 *   3. Magic bytes (first 8 bytes of file content)
 *   4. Keyword heuristics on filename / content preview
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileFormat = 'csv' | 'xlsx' | 'xls' | 'pdf' | 'text' | 'docx' | 'doc' | 'image' | 'unknown';

export type ModuleType =
  | 'leases'
  | 'expenses'
  | 'properties'
  | 'revenue'
  | 'cam'
  | 'budgets'
  | 'unknown';

export interface DetectionResult {
  fileFormat: FileFormat;
  moduleType: ModuleType;
  /** How the format was determined */
  formatSource: 'mime' | 'extension' | 'magic_bytes' | 'fallback';
  /** How the module was determined */
  moduleSource: 'explicit' | 'filename_keyword' | 'content_keyword' | 'fallback';
  /** Confidence 0–1 */
  confidence: number;
}

// ---------------------------------------------------------------------------
// MIME → format map
// ---------------------------------------------------------------------------

/** Enhanced MIME type to format mapping with more comprehensive coverage */
const MIME_TO_FORMAT: Record<string, FileFormat> = {
  'text/csv': 'csv',
  'application/csv': 'csv',
  'text/comma-separated-values': 'csv',
  'text/plain': 'text',
  'text/tab-separated-values': 'text',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/rtf': 'text',
  'text/rtf': 'text',
  // Image formats
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/png': 'image',
  'image/tiff': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'image/bmp': 'image',
  'image/svg+xml': 'image',
  'image/x-icon': 'image',
  'image/vnd.microsoft.icon': 'image',
  // Additional text formats
  'text/markdown': 'text',
  'text/x-log': 'text',
  'application/x-log': 'text',
  // Generic fallbacks
  'application/octet-stream': 'unknown', // Will be refined by extension/magic bytes
};

// ---------------------------------------------------------------------------
// Extension → format map
// ---------------------------------------------------------------------------

/** Enhanced file extension to format mapping with more formats */
const EXT_TO_FORMAT: Record<string, FileFormat> = {
  csv: 'csv',
  xls: 'xls',
  xlsx: 'xlsx',
  pdf: 'pdf',
  txt: 'text',
  tsv: 'text',
  tab: 'text',
  doc: 'doc',
  docx: 'docx',
  rtf: 'text', // Rich Text Format - treat as text
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  tiff: 'image',
  tif: 'image',
  webp: 'image',
  gif: 'image',
  bmp: 'image',
  svg: 'image',
  ico: 'image',
  // Additional text formats
  log: 'text',
  md: 'text',
  markdown: 'text',
  // Additional office formats
  ppt: 'unknown', // PowerPoint - not supported yet but recognized
  pptx: 'unknown',
  // Archive formats that might contain documents
  zip: 'unknown',
  rar: 'unknown',
  '7z': 'unknown',
};

// ---------------------------------------------------------------------------
// Magic bytes
// ---------------------------------------------------------------------------

/** Returns true if the bytes start with the given hex prefix */
function startsWith(bytes: Uint8Array, hex: string): boolean {
  const expected = hex.match(/.{2}/g)!.map(h => parseInt(h, 16));
  for (let i = 0; i < expected.length; i++) {
    if (bytes[i] !== expected[i]) return false;
  }
  return true;
}

/** Enhanced magic bytes detection with more comprehensive format support */
function detectFormatFromMagicBytes(bytes: Uint8Array): FileFormat | null {
  if (bytes.length < 4) return null;

  // PDF: %PDF
  if (startsWith(bytes, '25504446')) return 'pdf';

  // XLSX / DOCX (ZIP-based Office): PK\x03\x04
  // We can't distinguish xlsx from docx by magic bytes alone — use extension as tiebreaker
  if (startsWith(bytes, '504B0304')) return 'xlsx'; // caller refines to docx via extension

  // XLS (Compound Document): D0CF11E0 — also used by .doc
  if (startsWith(bytes, 'D0CF11E0')) return 'xls'; // caller refines to doc via extension

  // JPEG: FF D8 FF
  if (startsWith(bytes, 'FFD8FF')) return 'image';

  // PNG: 89 50 4E 47
  if (startsWith(bytes, '89504E47')) return 'image';

  // GIF: GIF8 (GIF87a or GIF89a)
  if (startsWith(bytes, '47494638')) return 'image';

  // TIFF: 49 49 2A 00 (little-endian) or 4D 4D 00 2A (big-endian)
  if (startsWith(bytes, '49492A00') || startsWith(bytes, '4D4D002A')) return 'image';

  // BMP: BM
  if (startsWith(bytes, '424D')) return 'image';

  // WebP: RIFF....WEBP
  if (bytes.length >= 12 && startsWith(bytes, '52494646') && 
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image';
  }

  // UTF-8 BOM (often CSV)
  if (startsWith(bytes, 'EFBBBF')) return 'csv';

  // UTF-16 BOM (little-endian and big-endian)
  if (startsWith(bytes, 'FFFE') || startsWith(bytes, 'FEFF')) return 'text';

  // Enhanced plain text heuristic with better detection
  const sample = bytes.slice(0, Math.min(1024, bytes.length)); // Increased sample size
  let printableCount = 0;
  let totalCount = 0;
  
  for (const b of sample) {
    totalCount++;
    // Allow common text characters: tab, newline, carriage return, printable ASCII
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) {
      printableCount++;
    }
    // Allow common UTF-8 continuation bytes
    else if (b >= 128 && b <= 191) {
      printableCount += 0.5; // Partial credit for UTF-8
    }
  }
  
  const printableRatio = printableCount / totalCount;
  
  // If >90% printable characters, likely text/CSV
  if (printableRatio > 0.9) {
    // Check for CSV indicators
    const text = new TextDecoder("utf-8", { fatal: false }).decode(sample);
    const hasCommas = (text.match(/,/g) || []).length > 3;
    const hasQuotes = (text.match(/"/g) || []).length > 1;
    const hasNewlines = (text.match(/\n/g) || []).length > 0;
    
    if (hasCommas && (hasQuotes || hasNewlines)) {
      return 'csv';
    }
    return 'text';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Module type keyword maps
// ---------------------------------------------------------------------------

const MODULE_FILENAME_KEYWORDS: Record<ModuleType, string[]> = {
  leases: ['lease', 'leas', 'tenant', 'rent', 'lessee', 'rental'],
  expenses: ['expense', 'cost', 'vendor', 'invoice', 'payable', 'opex'],
  properties: ['property', 'properties', 'building', 'asset', 'portfolio'],
  revenue: ['revenue', 'income', 'receipt', 'billing'],
  cam: ['cam', 'common area', 'maintenance', 'reconcil'],
  budgets: ['budget', 'forecast', 'plan', 'projection'],
  unknown: [],
};

const MODULE_CONTENT_KEYWORDS: Record<ModuleType, string[]> = {
  leases: ['tenant_name', 'tenant name', 'lessee', 'lease start', 'commencement', 'monthly rent', 'base rent'],
  expenses: ['expense_category', 'category', 'vendor', 'gl_code', 'gl code', 'classification', 'recoverable'],
  properties: ['property_name', 'property name', 'address', 'square_footage', 'sqft', 'property_type'],
  revenue: ['revenue_type', 'revenue type', 'income_type', 'cam_recovery', 'base_rent'],
  cam: ['cam_calculation', 'cam_per_sf', 'admin_fee', 'gross_up', 'cam_cap'],
  budgets: ['budget_year', 'fiscal_year', 'total_revenue', 'total_expenses', 'noi'],
  unknown: [],
};

function detectModuleFromKeywords(
  text: string,
  keywordMap: Record<ModuleType, string[]>,
): { module: ModuleType; score: number } {
  const lower = text.toLowerCase();
  let bestModule: ModuleType = 'unknown';
  let bestScore = 0;

  for (const [module, keywords] of Object.entries(keywordMap) as [ModuleType, string[]][]) {
    if (module === 'unknown') continue;
    const score = keywords.filter(kw => lower.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestModule = module;
    }
  }

  return { module: bestModule, score: bestScore };
}

// ---------------------------------------------------------------------------
// Main detection function
// ---------------------------------------------------------------------------

export interface DetectOptions {
  /** MIME type from the upload (may be empty/wrong) */
  mimeType?: string;
  /** Original filename */
  fileName?: string;
  /** Explicit module type provided by the caller (highest priority) */
  explicitModuleType?: string;
  /** First N bytes of the file for magic-byte detection */
  fileBytes?: Uint8Array;
  /** First ~2KB of text content for keyword detection */
  contentPreview?: string;
}

/** Enhanced main detection function with better fallback logic */
export function detectFileType(opts: DetectOptions): DetectionResult {
  const { mimeType = '', fileName = '', explicitModuleType, fileBytes, contentPreview = '' } = opts;

  // ── 1. File format detection with enhanced logic ────────────────────────

  let fileFormat: FileFormat = 'unknown';
  let formatSource: DetectionResult['formatSource'] = 'fallback';

  // 1a. MIME type (but be more selective about trusting it)
  if (mimeType && MIME_TO_FORMAT[mimeType] && mimeType !== 'application/octet-stream') {
    fileFormat = MIME_TO_FORMAT[mimeType];
    formatSource = 'mime';
  }

  // 1b. Magic bytes (highest priority when available - most reliable)
  if (fileBytes && fileBytes.length >= 4) {
    const magic = detectFormatFromMagicBytes(fileBytes);
    if (magic) {
      fileFormat = magic;
      formatSource = 'magic_bytes';
    }
  }

  // 1c. File extension (fallback when MIME is generic or magic bytes unavailable)
  if (fileFormat === 'unknown' || (mimeType === 'application/octet-stream' && formatSource !== 'magic_bytes')) {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    if (EXT_TO_FORMAT[ext]) {
      // Only override if we don't have a confident magic byte detection
      if (formatSource !== 'magic_bytes') {
        fileFormat = EXT_TO_FORMAT[ext];
        formatSource = 'extension';
      }
    }
  }

  // 1d. Enhanced refinement for ZIP-based and compound document formats
  if (fileFormat === 'xlsx' && formatSource === 'magic_bytes') {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'docx') { 
      fileFormat = 'docx'; 
    } else if (ext === 'doc') { 
      fileFormat = 'doc'; 
    }
    // Keep xlsx as default for PK magic bytes
  }
  
  // Refine compound-doc formats (xls vs doc both start with D0CF11E0)
  if (fileFormat === 'xls' && formatSource === 'magic_bytes') {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'doc') { 
      fileFormat = 'doc'; 
    }
    // Keep xls as default for compound document magic bytes
  }

  // 1e. Content-based fallback detection for edge cases
  if (fileFormat === 'unknown' && contentPreview) {
    // Check for CSV patterns in content
    const csvIndicators = [',', '"', '\n'].every(char => contentPreview.includes(char));
    const tabIndicators = contentPreview.includes('\t') && contentPreview.includes('\n');
    
    if (csvIndicators) {
      fileFormat = 'csv';
      formatSource = 'fallback';
    } else if (tabIndicators) {
      fileFormat = 'text';
      formatSource = 'fallback';
    } else if (contentPreview.trim().length > 0) {
      // Has readable content, likely text
      fileFormat = 'text';
      formatSource = 'fallback';
    }
  }

  // ── 2. Module type detection (unchanged but with better confidence) ──────

  let moduleType: ModuleType = 'unknown';
  let moduleSource: DetectionResult['moduleSource'] = 'fallback';

  // 2a. Explicit module type from caller (highest priority)
  if (explicitModuleType) {
    const valid: ModuleType[] = ['leases', 'expenses', 'properties', 'revenue', 'cam', 'budgets'];
    if (valid.includes(explicitModuleType as ModuleType)) {
      moduleType = explicitModuleType as ModuleType;
      moduleSource = 'explicit';
    }
  }

  // 2b. Filename keywords
  if (moduleType === 'unknown') {
    const { module, score } = detectModuleFromKeywords(fileName, MODULE_FILENAME_KEYWORDS);
    if (score > 0) {
      moduleType = module;
      moduleSource = 'filename_keyword';
    }
  }

  // 2c. Content keywords (CSV header row or PDF text preview)
  if (moduleType === 'unknown' && contentPreview) {
    const { module, score } = detectModuleFromKeywords(contentPreview, MODULE_CONTENT_KEYWORDS);
    if (score > 0) {
      moduleType = module;
      moduleSource = 'content_keyword';
    }
  }

  // ── 3. Enhanced confidence scoring ───────────────────────────────────────

  const formatConfidence =
    formatSource === 'magic_bytes' ? 0.95 :
    formatSource === 'mime' ? 0.85 :
    formatSource === 'extension' ? 0.75 : 0.4;

  const moduleConfidence =
    moduleSource === 'explicit' ? 1.0 :
    moduleSource === 'content_keyword' ? 0.85 :
    moduleSource === 'filename_keyword' ? 0.70 : 0.3;

  // Boost confidence if multiple detection methods agree
  let confidenceBoost = 0;
  if (formatSource === 'magic_bytes' && fileName.split('.').pop()?.toLowerCase() === fileFormat) {
    confidenceBoost += 0.05; // Magic bytes and extension agree
  }
  if (formatSource === 'mime' && fileName.split('.').pop()?.toLowerCase() === fileFormat) {
    confidenceBoost += 0.03; // MIME and extension agree
  }

  const confidence = Math.min(1.0, (formatConfidence + moduleConfidence) / 2 + confidenceBoost);

  return { fileFormat, moduleType, formatSource, moduleSource, confidence };
}

// ---------------------------------------------------------------------------
// DocumentSubtype classifier
// ---------------------------------------------------------------------------

/**
 * Document subtype: narrower than moduleType. Drives the review gate and
 * the document_links / lease_amendments / lease_assignments routing in
 * the canonical pipeline.
 *
 * Source of truth for accepted values: the `uploaded_files_document_subtype_check`
 * constraint in 20260416_review_pipeline.sql. Keep them in sync.
 */
export type DocumentSubtype =
  | 'base_lease'
  | 'amendment'
  | 'assignment'
  | 'consent'
  | 'extension'
  | 'addendum'
  | 'expense_backup'
  | 'cam_support'
  | 'budget_support'
  | 'rent_roll'
  | 'generic';

export interface SubtypeDetectionResult {
  subtype: DocumentSubtype;
  /** Whether this subtype must go through the human review gate. */
  reviewRequired: boolean;
  /** How the subtype was determined. */
  source: 'filename_keyword' | 'content_keyword' | 'module_default' | 'fallback';
  /** Confidence 0–1 */
  confidence: number;
}

/**
 * Keyword rules are deliberately specific to avoid false matches with
 * the base lease. Order matters: the more specific subtypes are listed
 * before "base_lease" so that an amendment is never misclassified as a
 * base lease just because it contains the word "lease".
 */
const SUBTYPE_FILENAME_RULES: Array<{ subtype: DocumentSubtype; keywords: string[] }> = [
  { subtype: 'assignment',     keywords: ['assignment', 'assign ', 'novation', 'substitution'] },
  { subtype: 'consent',        keywords: ['consent', 'landlord approval', 'landlord consent'] },
  { subtype: 'amendment',      keywords: ['amendment', 'amended', 'modification', 'modif'] },
  { subtype: 'extension',      keywords: ['extension', 'renewal', 'renew '] },
  { subtype: 'addendum',       keywords: ['addendum', 'addenda', 'rider'] },
  { subtype: 'expense_backup', keywords: ['invoice', 'receipt', 'utility bill', 'expense backup', 'ap backup'] },
  { subtype: 'cam_support',    keywords: ['cam recon', 'cam reconciliation', 'cam support', 'common area'] },
  { subtype: 'budget_support', keywords: ['budget memo', 'budget support', 'budget narrative'] },
  { subtype: 'rent_roll',      keywords: ['rent roll', 'rent-roll', 'rentroll'] },
  { subtype: 'base_lease',     keywords: ['lease agreement', 'lease contract', 'base lease', 'original lease'] },
];

const SUBTYPE_CONTENT_RULES: Array<{ subtype: DocumentSubtype; keywords: string[] }> = [
  { subtype: 'assignment',     keywords: ['assignment of lease', 'hereby assigns', 'assignor', 'assignee'] },
  { subtype: 'consent',        keywords: ['landlord hereby consents', 'consent to assignment', 'consent of landlord'] },
  { subtype: 'amendment',      keywords: ['this amendment', 'hereby amended', 'amendment no.', 'first amendment', 'second amendment'] },
  { subtype: 'extension',      keywords: ['option to extend', 'extension term', 'renewal term', 'hereby extended'] },
  { subtype: 'addendum',       keywords: ['this addendum', 'addendum to lease'] },
  { subtype: 'expense_backup', keywords: ['invoice number', 'invoice date', 'remit to', 'amount due', 'bill date'] },
  { subtype: 'cam_support',    keywords: ['cam reconciliation', 'common area maintenance reconciliation', 'pro rata share'] },
  { subtype: 'budget_support', keywords: ['annual budget', 'operating budget', 'budget variance'] },
  { subtype: 'rent_roll',      keywords: ['rent roll', 'monthly rent', 'tenant suite', 'lease expiration'] },
  { subtype: 'base_lease',     keywords: ['lease agreement', 'this lease', 'premises demised', 'commencement date'] },
];

/**
 * Subtypes that should route to the human-review UI before storing.
 * Anything that could rewrite an existing lease record is in here.
 */
const REVIEW_REQUIRED_SUBTYPES = new Set<DocumentSubtype>([
  'base_lease',
  'amendment',
  'assignment',
  'consent',
  'extension',
  'addendum',
]);

/**
 * Fallback subtype when keyword rules don't match. We pick the least
 * destructive subtype for the given module so the document still gets
 * attached to the right entity.
 */
function defaultSubtypeForModule(moduleType: ModuleType): DocumentSubtype {
  switch (moduleType) {
    case 'leases':     return 'base_lease';
    case 'expenses':   return 'expense_backup';
    case 'cam':        return 'cam_support';
    case 'budgets':    return 'budget_support';
    case 'revenue':    return 'rent_roll';
    case 'properties': return 'generic';
    default:           return 'generic';
  }
}

function matchSubtype(
  text: string,
  rules: Array<{ subtype: DocumentSubtype; keywords: string[] }>,
): { subtype: DocumentSubtype; score: number } | null {
  const lower = text.toLowerCase();
  let best: { subtype: DocumentSubtype; score: number } | null = null;
  for (const { subtype, keywords } of rules) {
    const score = keywords.filter(kw => lower.includes(kw)).length;
    if (score > 0 && (!best || score > best.score)) {
      best = { subtype, score };
    }
  }
  return best;
}

export interface ClassifySubtypeOptions {
  fileName?: string;
  contentPreview?: string;
  moduleType: ModuleType;
  explicitSubtype?: DocumentSubtype | string;
}

/**
 * Classify a document's subtype given the filename, a preview of its
 * contents, and the already-known moduleType. Called from ingest-file
 * immediately after detectFileType() so the subtype is persisted on the
 * `uploaded_files` row before extraction begins.
 */
export function classifyDocumentSubtype(opts: ClassifySubtypeOptions): SubtypeDetectionResult {
  const { fileName = '', contentPreview = '', moduleType, explicitSubtype } = opts;

  // Explicit override wins (e.g. caller already knows from UI context).
  if (explicitSubtype) {
    const valid: DocumentSubtype[] = [
      'base_lease', 'amendment', 'assignment', 'consent', 'extension', 'addendum',
      'expense_backup', 'cam_support', 'budget_support', 'rent_roll', 'generic',
    ];
    if (valid.includes(explicitSubtype as DocumentSubtype)) {
      const subtype = explicitSubtype as DocumentSubtype;
      return {
        subtype,
        reviewRequired: REVIEW_REQUIRED_SUBTYPES.has(subtype),
        source: 'filename_keyword',
        confidence: 1.0,
      };
    }
  }

  // Filename rules first — usually the strongest signal.
  const fromName = matchSubtype(fileName, SUBTYPE_FILENAME_RULES);
  if (fromName && fromName.score > 0) {
    return {
      subtype: fromName.subtype,
      reviewRequired: REVIEW_REQUIRED_SUBTYPES.has(fromName.subtype),
      source: 'filename_keyword',
      confidence: Math.min(0.9, 0.5 + 0.1 * fromName.score),
    };
  }

  // Content rules next — works well once the PDF/Docling preview is available.
  const fromContent = contentPreview
    ? matchSubtype(contentPreview, SUBTYPE_CONTENT_RULES)
    : null;
  if (fromContent && fromContent.score > 0) {
    return {
      subtype: fromContent.subtype,
      reviewRequired: REVIEW_REQUIRED_SUBTYPES.has(fromContent.subtype),
      source: 'content_keyword',
      confidence: Math.min(0.85, 0.45 + 0.1 * fromContent.score),
    };
  }

  // Fall back to the module default so downstream linking still works.
  const fallback = defaultSubtypeForModule(moduleType);
  return {
    subtype: fallback,
    reviewRequired: REVIEW_REQUIRED_SUBTYPES.has(fallback),
    source: 'module_default',
    confidence: 0.35,
  };
}

/** Exposed for callers that need to check the gate without re-classifying. */
export function isReviewRequiredSubtype(subtype: DocumentSubtype): boolean {
  return REVIEW_REQUIRED_SUBTYPES.has(subtype);
}
