import { describe, it, expect } from "vitest";
import { validateFieldValue, computeSourceQuality } from "../fieldValidator";

// ── validateFieldValue ────────────────────────────────────────────────────────

describe("validateFieldValue — boolean strings in text fields", () => {
  it("rejects property_name = 'Yes'", () => {
    const result = validateFieldValue("property_name", "Yes");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/boolean or placeholder/i);
  });

  it("rejects property_name = 'True' (case-insensitive)", () => {
    expect(validateFieldValue("property_name", "True").valid).toBe(false);
  });

  it("rejects property_name = 'No'", () => {
    expect(validateFieldValue("property_name", "No").valid).toBe(false);
  });

  it("rejects property_name = 'N/A'", () => {
    expect(validateFieldValue("property_name", "N/A").valid).toBe(false);
  });

  it("accepts a real property name", () => {
    expect(validateFieldValue("property_name", "Montvue Center").valid).toBe(true);
  });
});

describe("validateFieldValue — generic name labels", () => {
  it("rejects tenant_name = 'Tenant'", () => {
    const result = validateFieldValue("tenant_name", "Tenant");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/generic label/i);
  });

  it("rejects landlord_name = 'Landlord'", () => {
    expect(validateFieldValue("landlord_name", "Landlord").valid).toBe(false);
  });

  it("accepts a real entity name", () => {
    expect(validateFieldValue("tenant_name", "Mindful Tech Solutions, Inc.").valid).toBe(true);
  });

  it("accepts a person name (individual tenant)", () => {
    expect(validateFieldValue("tenant_name", "NARENDRA PYDI").valid).toBe(true);
  });
});

describe("validateFieldValue — numeric / square footage", () => {
  it("rejects square_footage = 'unknown'", () => {
    expect(validateFieldValue("square_footage", "unknown").valid).toBe(false);
  });

  it("rejects square_footage = 0", () => {
    expect(validateFieldValue("square_footage", 0).valid).toBe(false);
  });

  it("rejects square_footage = -100", () => {
    expect(validateFieldValue("square_footage", -100).valid).toBe(false);
  });

  it("accepts square_footage = 4200", () => {
    expect(validateFieldValue("square_footage", 4200).valid).toBe(true);
  });
});

describe("validateFieldValue — currency fields", () => {
  it("rejects monthly_rent = 'twelve hundred'", () => {
    expect(validateFieldValue("monthly_rent", "twelve hundred").valid).toBe(false);
  });

  it("accepts monthly_rent = 1400", () => {
    expect(validateFieldValue("monthly_rent", 1400).valid).toBe(true);
  });

  it("accepts monthly_rent = '$1,400' (string with currency symbol)", () => {
    expect(validateFieldValue("monthly_rent", "$1,400").valid).toBe(true);
  });
});

describe("validateFieldValue — date fields", () => {
  it("rejects a plain year like '2024'", () => {
    expect(validateFieldValue("commencement_date", "2024").valid).toBe(false);
  });

  it("rejects a human-readable date not in YYYY-MM-DD format", () => {
    expect(validateFieldValue("commencement_date", "January 1, 2024").valid).toBe(false);
  });

  it("accepts a valid ISO date", () => {
    expect(validateFieldValue("commencement_date", "2024-01-01").valid).toBe(true);
  });

  it("rejects an ISO-shaped but invalid calendar date (month 13)", () => {
    // JS Date silently wraps Feb-30 to Mar-1, but month 13 is truly NaN.
    expect(validateFieldValue("commencement_date", "2024-13-01").valid).toBe(false);
  });
});

describe("validateFieldValue — null/empty values are always valid", () => {
  it("treats null as valid (absence is a missing-field concern, not invalid)", () => {
    expect(validateFieldValue("property_name", null).valid).toBe(true);
  });
  it("treats empty string as valid", () => {
    expect(validateFieldValue("tenant_name", "").valid).toBe(true);
  });
});

// ── computeSourceQuality ──────────────────────────────────────────────────────

describe("computeSourceQuality", () => {
  it("returns 'missing' when value exists but source text is absent", () => {
    expect(computeSourceQuality("4200", null, "extracted")).toBe("missing");
  });

  it("returns 'missing' when there is no value", () => {
    expect(computeSourceQuality(null, null, null)).toBe("missing");
    expect(computeSourceQuality("", "some text", "extracted")).toBe("missing");
  });

  it("returns 'derived' for calculated extraction status", () => {
    expect(computeSourceQuality(9904.13, "Rent: $118,849.50/yr", "calculated")).toBe("derived");
    expect(computeSourceQuality(9904.13, "some text", "derived")).toBe("derived");
  });

  it("returns 'exact' for a labeled row snippet", () => {
    const text = "Tenant: Mindful Tech Solutions, Inc.";
    expect(computeSourceQuality("Mindful Tech Solutions, Inc.", text, "extracted")).toBe("exact");
  });

  it("returns 'exact' for a snippet ending with a period", () => {
    const text = "The Premises contain approximately 4,200 rentable square feet.";
    expect(computeSourceQuality(4200, text, "extracted")).toBe("exact");
  });

  it("returns 'partial' for a mid-sentence fragment", () => {
    const text = "4,200 rentable square feet located";
    expect(computeSourceQuality(4200, text, "extracted")).toBe("partial");
  });
});
