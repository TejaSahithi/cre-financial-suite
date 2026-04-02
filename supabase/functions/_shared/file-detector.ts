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

export type FileFormat = 'csv' | 'xlsx' | 'xls' | 'pdf' | 'text' | 'unknown';

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

const MIME_TO_FORMAT: Record<string, FileFormat> = {
  'text/csv': 'csv',
  'application/csv': 'csv',
  'text/plain': 'text',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/pdf': 'pdf',
};

// ---------------------------------------------------------------------------
// Extension → format map
// ---------------------------------------------------------------------------

const EXT_TO_FORMAT: Record<string, FileFormat> = {
  csv: 'csv',
  xls: 'xls',
  xlsx: 'xlsx',
  pdf: 'pdf',
  txt: 'text',
  tsv: 'text',
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

function detectFormatFromMagicBytes(bytes: Uint8Array): FileFormat | null {
  if (bytes.length < 4) return null;

  // PDF: %PDF
  if (startsWith(bytes, '25504446')) return 'pdf';

  // XLSX / DOCX (ZIP-based Office): PK\x03\x04
  if (startsWith(bytes, '504B0304')) return 'xlsx';

  // XLS (Compound Document): D0CF11E0
  if (startsWith(bytes, 'D0CF11E0')) return 'xls';

  // UTF-8 BOM (often CSV)
  if (startsWith(bytes, 'EFBBBF')) return 'csv';

  // Plain text heuristic: all bytes in printable ASCII range
  const sample = bytes.slice(0, Math.min(512, bytes.length));
  const isPrintable = Array.from(sample).every(b => b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126));
  if (isPrintable) return 'csv'; // assume CSV for printable text

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

export function detectFileType(opts: DetectOptions): DetectionResult {
  const { mimeType = '', fileName = '', explicitModuleType, fileBytes, contentPreview = '' } = opts;

  // ── 1. File format detection ─────────────────────────────────────────────

  let fileFormat: FileFormat = 'unknown';
  let formatSource: DetectionResult['formatSource'] = 'fallback';

  // 1a. MIME type
  if (mimeType && MIME_TO_FORMAT[mimeType]) {
    fileFormat = MIME_TO_FORMAT[mimeType];
    formatSource = 'mime';
  }

  // 1b. File extension (overrides only if MIME was unknown/generic)
  if (fileFormat === 'unknown' || mimeType === 'application/octet-stream') {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    if (EXT_TO_FORMAT[ext]) {
      fileFormat = EXT_TO_FORMAT[ext];
      formatSource = 'extension';
    }
  }

  // 1c. Magic bytes (overrides extension if we have bytes)
  if (fileBytes && fileBytes.length >= 4) {
    const magic = detectFormatFromMagicBytes(fileBytes);
    if (magic) {
      fileFormat = magic;
      formatSource = 'magic_bytes';
    }
  }

  // ── 2. Module type detection ─────────────────────────────────────────────

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

  // ── 3. Confidence score ──────────────────────────────────────────────────

  const formatConfidence =
    formatSource === 'magic_bytes' ? 0.95 :
    formatSource === 'mime' ? 0.85 :
    formatSource === 'extension' ? 0.75 : 0.4;

  const moduleConfidence =
    moduleSource === 'explicit' ? 1.0 :
    moduleSource === 'content_keyword' ? 0.85 :
    moduleSource === 'filename_keyword' ? 0.70 : 0.3;

  const confidence = (formatConfidence + moduleConfidence) / 2;

  return { fileFormat, moduleType, formatSource, moduleSource, confidence };
}
