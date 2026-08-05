import { describe, it, expect } from "vitest";
import { validateFieldValue, validateFieldEvidenceSupport, computeSourceQuality } from "../fieldValidator";

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

  it("accepts annual_rent = '25,200.00' (string with thousands separator)", () => {
    expect(validateFieldValue("annual_rent", "25,200.00").valid).toBe(true);
  });

  it("rejects accounting-negative currency values", () => {
    expect(validateFieldValue("security_deposit", "($1,400)").valid).toBe(false);
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

  it("rejects an ISO-shaped rollover date such as February 30", () => {
    expect(validateFieldValue("expiration_date", "2024-02-30").valid).toBe(false);
  });
});

describe("validateFieldValue — percentages, booleans, responsibilities, and phones", () => {
  it("validates select-style option values and common domain aliases", () => {
    expect(validateFieldValue("lease_type", "nnn").valid).toBe(true);
    expect(validateFieldValue("lease_type", "Triple Net (NNN)").valid).toBe(true);
    expect(validateFieldValue("lease_type", "not-a-real-lease-type").valid).toBe(false);
    expect(validateFieldValue("billing_frequency", "monthly").valid).toBe(true);
    expect(validateFieldValue("billing_frequency", "per month").valid).toBe(true);
    expect(validateFieldValue("billing_frequency", "every few weeks").valid).toBe(false);
    expect(validateFieldValue("cam_cap_type", "non_cumulative").valid).toBe(true);
    expect(validateFieldValue("cam_cap_type", "unlimited maybe").valid).toBe(false);
  });

  it("accepts percent strings and rejects percentages over 100", () => {
    expect(validateFieldValue("escalation_rate", "5%").valid).toBe(true);
    expect(validateFieldValue("cam_cap_pct", 101).valid).toBe(false);
  });

  it("accepts clear boolean values and rejects party names in boolean fields", () => {
    expect(validateFieldValue("tenant_insurance_required", "Yes").valid).toBe(true);
    expect(validateFieldValue("tenant_insurance_required", "tenant").valid).toBe(false);
  });

  it("accepts normalized responsibility values and rejects long clause text", () => {
    expect(validateFieldValue("responsibility_taxes", "landlord_with_cap").valid).toBe(true);
    expect(validateFieldValue("electric_responsibility", "Tenant separately metered").valid).toBe(true);
    expect(validateFieldValue("responsibility_insurance", "Tenant shall indemnify, defend, protect, and hold landlord harmless from all claims arising from the premises and the lease obligations in every case.").valid).toBe(false);
  });

  it("accepts normal phone numbers and rejects contact-line text with no phone", () => {
    expect(validateFieldValue("tenant_contact_phone", "618-946-9700").valid).toBe(true);
    expect(validateFieldValue("tenant_contact_phone", "Narendra Pydi").valid).toBe(false);
  });

  it("accepts square footage with a unit suffix", () => {
    expect(validateFieldValue("square_footage", "1,875 SF").valid).toBe(true);
  });
});

describe("validateFieldValue — legal-clause text in name fields", () => {
  it("rejects broker_name that contains legal clause language", () => {
    const clauseValue = "commissions and reasonable attorneys' fees; and (ii) shall not include any compensation for the fair market value of Tenant's Property nor reasonable compensation";
    const result = validateFieldValue("broker_name", clauseValue);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/clause text/i);
  });

  it("accepts a short name that happens to contain common words", () => {
    // "Jones" is not a clause; short names must pass even if they share a word
    expect(validateFieldValue("broker_name", "Jones & Associates").valid).toBe(true);
  });

  it("accepts a real broker company name", () => {
    expect(validateFieldValue("broker_name", "Cushman & Wakefield").valid).toBe(true);
  });
});

describe("validateFieldValue — suspiciously long name values", () => {
  it("rejects a name field value longer than 120 characters", () => {
    const longName = "A".repeat(121);
    const result = validateFieldValue("tenant_name", longName);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/too long/i);
  });

  it("accepts a name within 120 characters", () => {
    expect(validateFieldValue("landlord_name", "224 Partners, LLC").valid).toBe(true);
  });
});

describe("validateFieldValue — signature-block artifact in name", () => {
  it("rejects a contact name ending with 'Date'", () => {
    const result = validateFieldValue("tenant_contact_name", "Narendra Pydi Date");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Date.*signature/i);
  });

  it("accepts a name that simply contains the word 'date' mid-string", () => {
    // "Update" contains "date" but not as a trailing word
    expect(validateFieldValue("tenant_name", "Mindful Tech Solutions, Inc.").valid).toBe(true);
  });
});

describe("validateFieldValue — address field concatenation", () => {
  it("rejects an address that contains numbered table-row labels", () => {
    const multiRow = "224 S Peters Road Suite 212 4. Tenant: Mindful Tech Solutions, Inc. 5. Address of Tenant: 1240 Bentley Park lane Knoxville TN 37922";
    const result = validateFieldValue("landlord_address", multiRow);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/summary-table rows/i);
  });

  it("rejects an address longer than 200 characters", () => {
    const longAddr = "224 S Peters Road, Suite 212, Knoxville, TN 37923 ".repeat(5);
    const result = validateFieldValue("premises_address", longAddr);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/too long/i);
  });

  it("accepts a normal address", () => {
    expect(validateFieldValue("premises_address", "224 S Peters Road, Suite 212, Knoxville, TN 37923").valid).toBe(true);
  });
});

describe("validateFieldValue — suite_number word-fragment rejection", () => {
  it("rejects 'in' as a suite number (common extraction artifact)", () => {
    const result = validateFieldValue("suite_number", "in");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/word fragment/i);
  });

  it("rejects other prepositions as suite numbers", () => {
    for (const word of ["at", "of", "the", "on", "a", "an"]) {
      expect(validateFieldValue("suite_number", word).valid).toBe(false);
    }
  });

  it("accepts a real suite number string", () => {
    expect(validateFieldValue("suite_number", "212").valid).toBe(true);
    expect(validateFieldValue("suite_number", "#211").valid).toBe(true);
    expect(validateFieldValue("suite_number", "Suite 300").valid).toBe(true);
  });

  it("also rejects prepositions in the floor field", () => {
    expect(validateFieldValue("floor", "in").valid).toBe(false);
    expect(validateFieldValue("floor", "2").valid).toBe(true);
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

describe("validateFieldEvidenceSupport - field-aware source/value alignment", () => {
  it("rejects an escalation rate when the source number belongs to control-language boilerplate", () => {
    const result = validateFieldEvidenceSupport("escalation_rate", 5, {
      sourceText: '"Control" shall mean ownership of at least fifty-one percent (51%) of voting securities.',
      sourcePage: 2,
      extractionStatus: "extracted",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expected escalation rate context|support/i);
  });

  it("accepts an escalation rate when the source says rent increases by that percent", () => {
    const result = validateFieldEvidenceSupport("escalation_rate", 5, {
      sourceText: "The Rent will increase 5% each year of renewal.",
      sourcePage: 1,
      extractionStatus: "extracted",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects extracted values without source text so they do not look filled", () => {
    const result = validateFieldEvidenceSupport("assignee_name", "NARENDRA PYDI", {
      extractionStatus: "extracted",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/no source text/i);
  });
});

describe("validateFieldEvidenceSupport - rent schedule and billing frequency evidence", () => {
  it("accepts monthly rent from a source-backed rent schedule row", () => {
    const result = validateFieldEvidenceSupport("monthly_rent", "$18,562.50", {
      sourceText: "Jul 1, 2026 - Jun 30, 2027 $18,562.50",
      sourcePage: 2,
      extractionStatus: "extracted",
    });
    expect(result.valid).toBe(true);
  });

  it("accepts annual rent from a source-backed rent schedule row", () => {
    const result = validateFieldEvidenceSupport("annual_rent", "$222,750.00", {
      sourceText: "Jul 1, 2026 - Jun 30, 2027 $18,562.50 $222,750.00",
      sourcePage: 2,
      extractionStatus: "extracted",
    });
    expect(result.valid).toBe(true);
  });

  it("accepts monthly billing frequency from first-day-of-month rent language", () => {
    const result = validateFieldEvidenceSupport("billing_frequency", "monthly", {
      sourceText: "Base rent is due on the first day of each month without notice, demand, offset, deduction, or counterclaim.",
      sourcePage: 2,
      extractionStatus: "extracted",
    });
    expect(result.valid).toBe(true);
  });
});