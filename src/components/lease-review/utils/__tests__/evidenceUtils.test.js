import { describe, it, expect, vi } from "vitest";

// ── Module mocks (must come before imports that depend on them) ──────────────

vi.mock("@/lib/leaseReviewSchema", () => ({
  LEASE_REVIEW_FIELDS: [],
  hasValidSourceEvidence: ({ sourceText, sourcePage } = {}) => !!(sourceText || sourcePage != null),
  isCalculatedExtractionStatus: (s) => s === "calculated",
  isManualExtractionStatus: (s) => s === "manual_required",
  canAcceptCalculatedReviewField: () => false,
  isResolvedReview: (review) => review && ["accepted","edited","n_a","manual_required"].includes(review.status),
  readFieldValue: vi.fn(() => null),
  readFieldEvidence: vi.fn(() => ({ sourceText: null, sourcePage: null, extractionStatus: null })),
  REVIEW_STATUSES: { PENDING: "pending", ACCEPTED: "accepted", EDITED: "edited", N_A: "n_a", MANUAL_REQUIRED: "manual_required" },
  cleanSourceEvidenceText: (value) => {
    const text = String(value ?? "").trim();
    if (!text) return null;
    if (/^(llm extracted|extracted|manual_review|not found|unknown|n\/a|na|null|none|missing)$/i.test(text)) return null;
    if (/(^|\b)(derived from|calculated from|workflow placeholder|fallback|internal)(\b|$)/i.test(text)) return null;
    if (/^[a-z][a-z0-9_]{2,60}$/.test(text)) return null;
    return text;
  },
  readFieldValue: vi.fn(() => null),
}));

vi.mock("@/lib/leaseFieldResolver", () => ({
  getFieldAliases: (key) => [key],
}));

vi.mock("@/components/lease-review/utils/fieldExtractors", () => ({
  entryValue: (entry) => {
    if (entry == null) return null;
    if (typeof entry !== "object") return entry;
    return entry.normalized_value ?? entry.value ?? entry.raw_value ?? null;
  },
  entrySourceText: (entry) => {
    if (!entry || typeof entry !== "object") return null;
    const raw = entry.exact_source_text ?? entry.source_clause ?? entry.source_text ?? null;
    if (!raw) return null;
    const text = String(raw).trim();
    return text || null;
  },
  entrySourcePage: (entry) => {
    if (!entry || typeof entry !== "object") return null;
    // Avoid ?? null — Number(null) === 0 which isFinite accepts as a page.
    const p = entry.source_page ?? entry.page_number ?? entry.page;
    if (p == null) return null;
    const n = Number(p);
    return Number.isFinite(n) ? n : null;
  },
  getEvidenceRecordForKey: vi.fn(() => null),
  validEvidenceRecord: vi.fn(() => null),
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import {
  cleanExtractedSourceText,
  isGenericExtractedSourceText,
  inferDynamicItemTab,
  inferDynamicItemType,
  collectExtractedDocumentItems,
} from "../dynamicFields";

import { detectDocumentMismatch, detectFieldConflicts } from "../validation";
import { expandToSentenceBoundary } from "../evidenceResolver";
import { fieldMatchesFilter } from "../../FieldTableFilter";

// ── 1. cleanExtractedSourceText ───────────────────────────────────────────────

describe("cleanExtractedSourceText", () => {
  it("is exported and callable", () => {
    expect(typeof cleanExtractedSourceText).toBe("function");
  });

  it("returns null for generic placeholder values", () => {
    expect(cleanExtractedSourceText("llm extracted")).toBeNull();
    expect(cleanExtractedSourceText("not found")).toBeNull();
    expect(cleanExtractedSourceText("unknown")).toBeNull();
    expect(cleanExtractedSourceText("n/a")).toBeNull();
    expect(cleanExtractedSourceText(null)).toBeNull();
    expect(cleanExtractedSourceText("")).toBeNull();
  });

  it("returns null for bare camelCase/snake_case identifiers", () => {
    expect(cleanExtractedSourceText("tenant_name")).toBeNull();
    expect(cleanExtractedSourceText("annual_rent")).toBeNull();
  });

  it("returns real text unchanged", () => {
    expect(cleanExtractedSourceText("Landlord: 224 Partners, LLC")).toBe("Landlord: 224 Partners, LLC");
    expect(cleanExtractedSourceText("Tenant shall pay $1,400 per month")).toBe("Tenant shall pay $1,400 per month");
  });
});

// ── 2. Evidence backfill — missing source text ────────────────────────────────

describe("isGenericExtractedSourceText", () => {
  it("returns true for generic text", () => {
    expect(isGenericExtractedSourceText("extracted")).toBe(true);
    expect(isGenericExtractedSourceText("derived from annual_rent")).toBe(true);
  });

  it("returns false for real source text", () => {
    expect(isGenericExtractedSourceText("The Premises contain 4,200 rentable square feet")).toBe(false);
  });
});

// ── 3. Standard field with value but no source → missing_source_evidence ─────

describe("collectExtractedDocumentItems — extraction_status", () => {
  it("marks a field with value but no source_text as missing_source_evidence", () => {
    // Omit source_page entirely — passing null would convert to 0 via Number(null),
    // which Number.isFinite accepts, incorrectly triggering the "has page" branch.
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_fields: {
            square_footage: { value: 4200 },
          },
        },
      },
    };
    const items = collectExtractedDocumentItems(lease);
    const sqftItem = items.find((i) => i.field_key === "square_footage");
    expect(sqftItem).toBeTruthy();
    expect(sqftItem.extraction_status).toBe("missing_source_evidence");
  });

  it("marks a field as extracted when source_text and confidence are present", () => {
    // A numeric confidence is required for the status to be "extracted" rather
    // than the fallback "extracted_no_confidence".
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_fields: {
            landlord_name: {
              value: "MONTVUE, LLC",
              source_text: 'Landlord: MONTVUE, LLC, a Tennessee LLC ("Landlord")',
              source_page: 1,
              confidence: 0.95,
            },
          },
        },
      },
    };
    const items = collectExtractedDocumentItems(lease);
    const item = items.find((i) => i.field_key === "landlord_name");
    expect(item).toBeTruthy();
    expect(item.extraction_status).toBe("extracted");
  });
});

// ── 4. Dynamic lease_clauses create review rows ───────────────────────────────

describe("collectExtractedDocumentItems — lease_clauses", () => {
  it("creates a dynamic row for each lease_clause with a value or source_text", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_clauses: [
            {
              clause_type: "landlord_consent",
              value: true,
              source_text: "Landlord hereby consents to the Assignment.",
              source_page: 2,
              confidence: 0.95,
              category: "assignment",
            },
          ],
        },
      },
    };
    const items = collectExtractedDocumentItems(lease);
    const clauseItem = items.find((i) => i.item_type === "landlord_consent");
    expect(clauseItem).toBeTruthy();
    expect(clauseItem.field_key).toBe("clause_landlord_consent");
    expect(clauseItem.value).toBe(true);
    expect(clauseItem.creates_dynamic_row).toBe(true);
    expect(clauseItem.review_status).toBe("pending");
  });

  it("drops a clause with no value and no source_text", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_clauses: [
            { clause_type: "rofr", value: null, source_text: null },
          ],
        },
      },
    };
    const items = collectExtractedDocumentItems(lease);
    const rofr = items.find((i) => i.item_type === "rofr");
    expect(rofr).toBeUndefined();
  });
});

// ── 5. Clause tab routing ─────────────────────────────────────────────────────

describe("inferDynamicItemTab — clause routing", () => {
  const cases = [
    ["grease_trap_payment", "rent_charges"],
    ["cam_cap_pct", "cam_rules"],
    ["insurance_requirements", "insurance"],
    ["assignment_and_subletting", "legal_options"],
    ["operating_expenses", "expenses_recoveries"],
    ["commencement_date", "dates_term"],
    ["premises_address", "parties_premises"],
  ];

  for (const [key, expectedTab] of cases) {
    it(`maps "${key}" → "${expectedTab}"`, () => {
      expect(inferDynamicItemTab({}, key)).toBe(expectedTab);
    });
  }
});

// ── 6. inferDynamicItemType ───────────────────────────────────────────────────

describe("inferDynamicItemType", () => {
  it("returns 'currency' for rent/fee keys", () => {
    expect(inferDynamicItemType({}, "monthly_rent")).toBe("currency");
    expect(inferDynamicItemType({}, "late_fee")).toBe("currency");
  });
  it("returns 'date' for date keys", () => {
    expect(inferDynamicItemType({}, "commencement_date")).toBe("date");
  });
  it("returns 'boolean' for boolean values", () => {
    expect(inferDynamicItemType({ value: true }, "landlord_consent")).toBe("boolean");
  });
  it("returns 'text' as fallback", () => {
    expect(inferDynamicItemType({}, "assignment_provisions")).toBe("text");
  });
});

// ── 7. detectDocumentMismatch ─────────────────────────────────────────────────

describe("detectDocumentMismatch", () => {
  const makeUploadedFile = (fields) => ({
    ui_review_payload: {
      records: [{ fields }],
    },
  });

  it("returns [] when there are no conflicts", () => {
    const lease = { square_footage: 4200, tenant_name: "NARENDRA PYDI" };
    const file = makeUploadedFile({
      square_footage: { value: 4200 },
      tenant_name: { value: "NARENDRA PYDI" },
    });
    expect(detectDocumentMismatch(lease, file)).toHaveLength(0);
  });

  it("flags square footage mismatch > 10%", () => {
    const lease = { square_footage: 1110 };
    const file = makeUploadedFile({ square_footage: { value: 4200 } });
    const result = detectDocumentMismatch(lease, file);
    expect(result.some((m) => m.field === "square_footage")).toBe(true);
  });

  it("does not flag square footage difference <= 10%", () => {
    const lease = { square_footage: 4200 };
    const file = makeUploadedFile({ square_footage: { value: 4300 } });
    expect(detectDocumentMismatch(lease, file)).toHaveLength(0);
  });

  it("flags address mismatch when street numbers differ", () => {
    const lease = { property_address: "224 S Peters Road, Knoxville TN" };
    const file = makeUploadedFile({
      property_address: { value: "7804 Montvue Center Way, Knoxville TN" },
    });
    const result = detectDocumentMismatch(lease, file);
    expect(result.some((m) => m.field === "property_address")).toBe(true);
  });

  it("flags completely different tenant names", () => {
    const lease = { tenant_name: "BKW @ Montvue" };
    const file = makeUploadedFile({ tenant_name: { value: "NARENDRA PYDI" } });
    const result = detectDocumentMismatch(lease, file);
    expect(result.some((m) => m.field === "tenant_name")).toBe(true);
  });

  it("does not flag tenant names that are substrings (same person different casing)", () => {
    const lease = { tenant_name: "Narendra Pydi" };
    const file = makeUploadedFile({ tenant_name: { value: "NARENDRA PYDI" } });
    expect(detectDocumentMismatch(lease, file)).toHaveLength(0);
  });

  it("flags expiration date mismatch > 30 days", () => {
    const lease = { expiration_date: "2025-01-31" };
    const file = makeUploadedFile({ expiration_date: { value: "2029-09-30" } });
    const result = detectDocumentMismatch(lease, file);
    expect(result.some((m) => m.field === "expiration_date")).toBe(true);
  });

  it("returns [] when either argument is null", () => {
    expect(detectDocumentMismatch(null, {})).toHaveLength(0);
    expect(detectDocumentMismatch({}, null)).toHaveLength(0);
  });
});

// ── 8. expandToSentenceBoundary ──────────────────────────────────────────────

describe("expandToSentenceBoundary", () => {
  it("returns the whole block when it is a labeled row", () => {
    const text = "Tenant: Mindful Tech Solutions, Inc.";
    const hit = text.indexOf("Mindful");
    const { snippet, source_quality } = expandToSentenceBoundary(text, hit, "Mindful".length);
    expect(snippet).toBe(text);
    expect(source_quality).toBe("exact");
  });

  it("expands to the surrounding sentence ending with a period", () => {
    const text = "The parties agree. The Premises contain 4,200 rentable square feet. Tenant shall pay rent.";
    const hit = text.indexOf("4,200");
    const { snippet, source_quality } = expandToSentenceBoundary(text, hit, "4,200".length);
    expect(snippet).toContain("4,200");
    expect(snippet.startsWith("The Premises")).toBe(true);
    expect(source_quality).toBe("exact");
  });

  it("marks mid-sentence fragments as partial", () => {
    // No sentence boundaries around the match
    const text = "approximately 4200 rentable square feet located at the building";
    const hit = text.indexOf("4200");
    const { snippet, source_quality } = expandToSentenceBoundary(text, hit, "4200".length);
    expect(snippet).toContain("4200");
    expect(source_quality).toBe("partial");
  });

  it("does not blow up on empty text", () => {
    const { snippet, source_quality } = expandToSentenceBoundary("", 0, 0);
    expect(snippet).toBe("");
    expect(source_quality).toBe("partial");
  });
});

// ── 9. fieldMatchesFilter ────────────────────────────────────────────────────

describe("fieldMatchesFilter", () => {
  const makeField = (overrides) => ({ key: "test", required: false, dynamic_document_item: false, ...overrides });

  it("'all' matches every field", () => {
    expect(fieldMatchesFilter(makeField(), "all", null, null, null, new Set())).toBe(true);
  });

  it("'required' matches only required fields", () => {
    expect(fieldMatchesFilter(makeField({ required: true }),  "required", "v", "s", null, new Set())).toBe(true);
    expect(fieldMatchesFilter(makeField({ required: false }), "required", "v", "s", null, new Set())).toBe(false);
  });

  it("'missing' matches fields with no value", () => {
    expect(fieldMatchesFilter(makeField(), "missing", null, null, null, new Set())).toBe(true);
    expect(fieldMatchesFilter(makeField(), "missing", "value", null, null, new Set())).toBe(false);
  });

  it("'no_source' matches fields that have a value but no source text", () => {
    expect(fieldMatchesFilter(makeField(), "no_source", "value", null, null, new Set())).toBe(true);
    expect(fieldMatchesFilter(makeField(), "no_source", "value", "some text", null, new Set())).toBe(false);
    expect(fieldMatchesFilter(makeField(), "no_source", null, null, null, new Set())).toBe(false);
  });

  it("'dynamic' matches only dynamic_document_item fields", () => {
    expect(fieldMatchesFilter(makeField({ dynamic_document_item: true }),  "dynamic", "v", "s", null, new Set())).toBe(true);
    expect(fieldMatchesFilter(makeField({ dynamic_document_item: false }), "dynamic", "v", "s", null, new Set())).toBe(false);
  });

  it("'conflicts' matches fields in the conflict set", () => {
    const keys = new Set(["monthly_rent"]);
    expect(fieldMatchesFilter(makeField({ key: "monthly_rent" }), "conflicts", "v", "s", null, keys)).toBe(true);
    expect(fieldMatchesFilter(makeField({ key: "tenant_name" }),  "conflicts", "v", "s", null, keys)).toBe(false);
  });
});

// ── 11. detectFieldConflicts (existing, regression guard) ───────────────────

describe("detectFieldConflicts", () => {
  it("flags monthly × 12 ≠ annual", () => {
    const lease = { monthly_rent: 5000, annual_rent: 100000 }; // 5000*12=60000 ≠ 100000
    const result = detectFieldConflicts(lease);
    expect(result.some((c) => c.field_key === "monthly_rent")).toBe(true);
  });

  it("returns [] for consistent rent values", () => {
    const lease = { monthly_rent: 9904.13, annual_rent: 118849.5 }; // ~12×
    expect(detectFieldConflicts(lease)).toHaveLength(0);
  });
});
