const FIELD_ALIASES = {
  date: ["date", "expense_date", "invoice_date", "transaction_date", "issued_date", "posted_date"],
  amount: ["amount", "expense_amount", "invoice_amount", "total", "total_amount", "balance_due", "cost"],
  category: ["category", "expense_category", "expense_type", "type", "account"],
  subcategory: ["subcategory", "expense_subcategory", "expense_sub_type", "service_type", "line_item_type"],
  gl_code: ["gl_code", "gl_account", "gl_account_no", "account_code", "cost_code", "account_number"],
  vendor: ["vendor", "vendor_name", "supplier", "supplier_name", "payee", "merchant"],
  description: ["description", "expense_description", "memo", "detail", "details", "notes"],
  classification: ["classification", "recovery_type", "recoverability"],
  property_name: ["property_name", "property", "site_name", "location"],
  building_name: ["building_name", "building"],
  unit_number: ["unit_number", "unit", "suite", "suite_number", "space"],
  tenant_name: ["tenant_name", "tenant", "occupant", "lessee"],
  invoice_number: ["invoice_number", "invoice_no", "invoice", "invoice_id", "reference", "ref"],
};

const CATEGORY_ALIASES = {
  maintenance: "general_repairs",
  repairs: "general_repairs",
  repair: "general_repairs",
  cam: "general_repairs",
  common_area_maintenance: "general_repairs",
  taxes: "property_tax",
  tax: "property_tax",
  property_taxes: "property_tax",
  utility: "utilities",
  electric: "electrical",
  electricity: "electrical",
  hvac: "hvac_maintenance",
  landscaping_services: "landscaping",
  janitorial_services: "janitorial",
  cleaning_services: "cleaning",
  legal: "legal_fees",
  accounting_fees: "accounting",
};

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function unwrapFieldValue(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return value;
  return value.value ?? value.normalized_value ?? value.original_value ?? null;
}

function rowFromReviewRecord(record) {
  if (!record || typeof record !== "object") return null;
  if (record.values && typeof record.values === "object") return record.values;
  if (record.row && typeof record.row === "object") return record.row;

  const output = {};
  const addField = (key, entry) => {
    if (entry?.status === "rejected" || entry?.accepted === false || entry?.rejected === true) return;
    const normalizedKey = normalizeKey(key);
    const value = unwrapFieldValue(entry);
    if (normalizedKey && value != null && value !== "") output[normalizedKey] = value;
  };

  if (record.fields && typeof record.fields === "object" && !Array.isArray(record.fields)) {
    Object.entries(record.fields).forEach(([key, entry]) => addField(key, entry));
  }
  for (const collection of [record.standard_fields, record.custom_fields, record.extracted_fields]) {
    if (!Array.isArray(collection)) continue;
    collection.forEach((entry) => addField(entry?.field_key || entry?.key || entry?.name || entry?.label, entry));
  }

  if (Object.keys(output).length > 0) return output;
  const cleaned = {};
  Object.entries(record).forEach(([key, value]) => {
    if (key.startsWith("_")) return;
    const unwrapped = unwrapFieldValue(value);
    if (unwrapped != null && unwrapped !== "") cleaned[normalizeKey(key)] = unwrapped;
  });
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

export function extractExpenseRowsFromUploadedFile(record) {
  const candidates = [
    record?.valid_data,
    record?.parsed_data,
    record?.normalized_output?.records,
    record?.normalized_output?.rows,
    record?.ui_review_payload?.records,
    record?.ui_review_payload?.rows,
    record?.reviewed_output?.final_records,
    record?.reviewed_output?.records,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue;
    const rows = candidate.map(rowFromReviewRecord).filter(Boolean);
    if (rows.length > 0) return rows;
  }

  const single = rowFromReviewRecord(record?.ui_review_payload?.record || record?.normalized_output?.record);
  return single ? [single] : [];
}

function firstValue(row, aliases) {
  const normalized = new Map(
    Object.entries(row || {}).map(([key, value]) => [normalizeKey(key), unwrapFieldValue(value)])
  );
  for (const alias of aliases) {
    const value = normalized.get(alias);
    if (value != null && value !== "") return value;
  }
  return null;
}

function normalizeDate(value) {
  if (!value) return "";
  const raw = String(value).trim();
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeAmount(value) {
  if (value == null || value === "") return "";
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : "";
}

function normalizeClassification(value) {
  const normalized = normalizeKey(value);
  if (["recoverable", "non_recoverable", "conditional"].includes(normalized)) return normalized;
  if (["nonrecoverable", "owner", "landlord"].includes(normalized)) return "non_recoverable";
  return "";
}

export function normalizeExpenseCategory(value, allowedCategories = []) {
  const normalized = normalizeKey(value);
  if (!normalized) return "";
  if (allowedCategories.includes(normalized)) return normalized;
  const aliased = CATEGORY_ALIASES[normalized];
  return aliased && allowedCategories.includes(aliased) ? aliased : "";
}

export function buildInvoiceExpenseCandidate(row, allowedCategories = []) {
  return {
    date: normalizeDate(firstValue(row, FIELD_ALIASES.date)),
    amount: normalizeAmount(firstValue(row, FIELD_ALIASES.amount)),
    category: normalizeExpenseCategory(firstValue(row, FIELD_ALIASES.category), allowedCategories),
    expense_subcategory: String(firstValue(row, FIELD_ALIASES.subcategory) || "").trim(),
    gl_code: String(firstValue(row, FIELD_ALIASES.gl_code) || "").trim(),
    vendor: String(firstValue(row, FIELD_ALIASES.vendor) || "").trim(),
    description: String(firstValue(row, FIELD_ALIASES.description) || "").trim(),
    classification: normalizeClassification(firstValue(row, FIELD_ALIASES.classification)),
    property_name: String(firstValue(row, FIELD_ALIASES.property_name) || "").trim(),
    building_name: String(firstValue(row, FIELD_ALIASES.building_name) || "").trim(),
    unit_number: String(firstValue(row, FIELD_ALIASES.unit_number) || "").trim(),
    tenant_name: String(firstValue(row, FIELD_ALIASES.tenant_name) || "").trim(),
    invoice_number: String(firstValue(row, FIELD_ALIASES.invoice_number) || "").trim(),
  };
}

export function findEntityByName(rows, candidate, selectors = []) {
  const needle = normalizeKey(candidate);
  if (!needle) return null;
  const scored = (rows || []).flatMap((row) => {
    const names = selectors.map((selector) => normalizeKey(selector(row))).filter(Boolean);
    const exact = names.some((name) => name === needle);
    const partial = names.some((name) => name.includes(needle) || needle.includes(name));
    return exact || partial ? [{ row, score: exact ? 2 : 1 }] : [];
  });
  scored.sort((left, right) => right.score - left.score);
  if (scored.length === 0 || (scored.length > 1 && scored[0].score === scored[1].score)) return null;
  return scored[0].row;
}
