const EXACT_HEADER_MAPPINGS = new Map([
  ["date", "expense_date"],
  ["expense date", "expense_date"],
  ["transaction date", "expense_date"],
  ["trans date", "expense_date"],
  ["category", "category"],
  ["expense category", "category"],
  ["expense_category", "category"],
  ["subcategory", "expense_subcategory"],
  ["sub category", "expense_subcategory"],
  ["expense subcategory", "expense_subcategory"],
  ["expense_subcategory", "expense_subcategory"],
  ["service type", "expense_subcategory"],
  ["amount", "amount"],
  ["cost", "amount"],
  ["total", "amount"],
  ["vendor", "vendor"],
  ["vendor name", "vendor"],
  ["supplier", "vendor"],
  ["payee", "vendor"],
  ["recoverable", "recoverable_flag"],
  ["recovery", "recoverable_flag"],
  ["recovery type", "recoverable_flag"],
  ["classification", "recoverable_flag"],
  ["description", "description"],
  ["desc", "description"],
  ["note", "description"],
  ["notes", "description"],
  ["memo", "description"],
  ["gl", "gl_code"],
  ["gl code", "gl_code"],
  ["gl_code", "gl_code"],
  ["gl account", "gl_code"],
  ["account", "gl_code"],
  ["account code", "gl_code"],
  ["cost_center", "gl_code"],
  ["cost center", "gl_code"],
  ["invoice", "invoice_number"],
  ["invoice number", "invoice_number"],
  ["invoice no", "invoice_number"],
  ["invoice no.", "invoice_number"],
  ["invoice #", "invoice_number"],
  ["ref no", "invoice_number"],
  ["reference", "invoice_number"],
  ["source", "source_type"],
  ["source type", "source_type"],
  ["source_type", "source_type"],
  ["data source", "source_type"],
  ["data_source", "source_type"],
  ["origin", "source_type"],
]);

function normalizeHeader(header) {
  return String(header || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function genericFieldForHeader(header) {
  const normalized = normalizeHeader(header);
  if (!normalized) return null;
  if (EXACT_HEADER_MAPPINGS.has(normalized)) return EXACT_HEADER_MAPPINGS.get(normalized);

  if (/\bdate\b/.test(normalized)) return "expense_date";
  if (/\bsub\s*category\b/.test(normalized)) return "expense_subcategory";
  if (/\bcategory\b/.test(normalized)) return "category";
  if (/\b(amount|cost|total)\b/.test(normalized)) return "amount";
  if (/\b(vendor|supplier|payee)\b/.test(normalized)) return "vendor";
  if (/\b(recoverable|recovery|classification)\b/.test(normalized)) return "recoverable_flag";
  if (/\b(description|desc|note|memo)\b/.test(normalized)) return "description";
  if (/\b(gl|account|cost center)\b/.test(normalized)) return "gl_code";
  if (/\b(invoice|reference|ref no)\b/.test(normalized)) return "invoice_number";
  if (/\bsource\b/.test(normalized)) return "source_type";
  return null;
}

export function buildExpenseBulkImportColumnMap(headers = [], preset = {}) {
  const autoMap = {};
  const presetMap = preset?.autoMap || {};

  for (const header of headers) {
    const field = genericFieldForHeader(header);
    if (field) autoMap[header] = field;
  }

  for (const header of headers) {
    const normalized = normalizeHeader(header);
    const field = presetMap[normalized] ?? presetMap[String(header || "").toLowerCase()];
    if (field !== undefined && !autoMap[header]) {
      if (field !== null) autoMap[header] = field;
    }
  }

  return autoMap;
}

export { genericFieldForHeader, normalizeHeader };
