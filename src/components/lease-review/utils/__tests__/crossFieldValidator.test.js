import { describe, it, expect } from "vitest";
import { validateCrossFieldWarnings } from "../crossFieldValidator";

// Build a minimal rowByKey map from a plain key→value object.
function makeMap(fields) {
  const m = new Map();
  for (const [key, value] of Object.entries(fields)) {
    m.set(key, { key, field_key: key, normalized_value: value, value });
  }
  return m;
}

// Convenience: get all check codes for a key.
function checks(warnings, key) {
  return (warnings.get(key) ?? []).map((w) => w.check);
}

describe("validateCrossFieldWarnings", () => {

  // ── G1: Rent math ──────────────────────────────────────────────────────────

  describe("G1 — monthly_rent × 12 vs annual_rent", () => {
    it("warns both fields when mismatch exceeds 2%", () => {
      // 5000 × 12 = 60000 vs 70000 → 14.3% mismatch
      const w = validateCrossFieldWarnings(
        makeMap({ monthly_rent: 5000, annual_rent: 70000 }),
        {},
      );
      expect(checks(w, "monthly_rent")).toContain("G1");
      expect(checks(w, "annual_rent")).toContain("G1");
      expect(w.get("monthly_rent")[0].reason).toMatch(/\$60,000/);
      expect(w.get("monthly_rent")[0].reason).toMatch(/\$70,000/);
    });

    it("does not warn when values match within 2%", () => {
      // 5000 × 12 = 60000, annual = 60000 — exact match
      const w = validateCrossFieldWarnings(
        makeMap({ monthly_rent: 5000, annual_rent: 60000 }),
        {},
      );
      expect(w.has("monthly_rent")).toBe(false);
      expect(w.has("annual_rent")).toBe(false);
    });

    it("does not warn when within 2% tolerance (rounding case)", () => {
      // 5001 × 12 = 60012 vs 60000 → 0.02% mismatch
      const w = validateCrossFieldWarnings(
        makeMap({ monthly_rent: 5001, annual_rent: 60000 }),
        {},
      );
      expect(w.has("monthly_rent")).toBe(false);
    });

    it("does not warn when annual_rent is absent", () => {
      const w = validateCrossFieldWarnings(makeMap({ monthly_rent: 5000 }), {});
      expect(w.has("monthly_rent")).toBe(false);
    });

    it("does not warn when monthly_rent is absent", () => {
      const w = validateCrossFieldWarnings(makeMap({ annual_rent: 60000 }), {});
      expect(w.has("annual_rent")).toBe(false);
    });

    it("does not warn when both are absent", () => {
      const w = validateCrossFieldWarnings(new Map(), {});
      expect(w.size).toBe(0);
    });

    it("does not warn when either value is non-numeric", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ monthly_rent: "not a number", annual_rent: 60000 }),
        {},
      );
      expect(w.has("monthly_rent")).toBe(false);
    });

    it("handles string currency values with $ sign", () => {
      // $5,000 × 12 = $60,000 — matches
      const w = validateCrossFieldWarnings(
        makeMap({ monthly_rent: "$5,000", annual_rent: "$60,000" }),
        {},
      );
      expect(w.has("monthly_rent")).toBe(false);
    });
  });

  // ── H1: Commencement ≥ expiration ─────────────────────────────────────────

  describe("H1 — commencement_date must be before expiration_date", () => {
    it("warns both dates when commencement is after expiration", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ commencement_date: "2025-12-01", expiration_date: "2024-12-01" }),
        {},
      );
      expect(checks(w, "commencement_date")).toContain("H1");
      expect(checks(w, "expiration_date")).toContain("H1");
      expect(w.get("commencement_date")[0].reason).toMatch(/on or after/i);
    });

    it("warns when commencement equals expiration", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ commencement_date: "2024-06-01", expiration_date: "2024-06-01" }),
        {},
      );
      expect(checks(w, "commencement_date")).toContain("H1");
    });

    it("does not warn with normal date order", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ commencement_date: "2024-01-01", expiration_date: "2029-01-01" }),
        {},
      );
      expect(checks(w, "commencement_date")).not.toContain("H1");
      expect(checks(w, "expiration_date")).not.toContain("H1");
    });

    it("does not warn when either date is missing", () => {
      const w = validateCrossFieldWarnings(makeMap({ commencement_date: "2024-01-01" }), {});
      expect(w.has("commencement_date")).toBe(false);
    });

    it("does not warn when dates are unparseable", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ commencement_date: "not-a-date", expiration_date: "also-bad" }),
        {},
      );
      expect(w.has("commencement_date")).toBe(false);
    });
  });

  // ── H2: Suspiciously short term ───────────────────────────────────────────

  describe("H2 — computed date span under 30 days", () => {
    it("warns both dates when span is only 14 days", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ commencement_date: "2024-01-01", expiration_date: "2024-01-15" }),
        {},
      );
      expect(checks(w, "commencement_date")).toContain("H2");
      expect(checks(w, "expiration_date")).toContain("H2");
      expect(w.get("expiration_date")[0].reason).toMatch(/\d+ day/i);
    });

    it("does not warn for a 30-day span", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ commencement_date: "2024-01-01", expiration_date: "2024-01-31" }),
        {},
      );
      expect(checks(w, "commencement_date")).not.toContain("H2");
    });

    it("does not emit H2 when dates are reversed (H1 fires instead)", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ commencement_date: "2024-06-01", expiration_date: "2024-01-01" }),
        {},
      );
      // H1 fires; H2 must not also fire since days <= 0
      expect(checks(w, "commencement_date")).toContain("H1");
      expect(checks(w, "commencement_date")).not.toContain("H2");
    });
  });

  // ── H3: lease_term text vs. computed date span ────────────────────────────

  describe("H3 — lease_term text should align with commencement → expiration span", () => {
    it("warns all three fields when stated months text differs by > 2 months", () => {
      // ~60-month span, but states 36 months
      const w = validateCrossFieldWarnings(
        makeMap({
          commencement_date: "2024-01-01",
          expiration_date: "2029-01-01",
          lease_term: "36 months",
        }),
        {},
      );
      expect(checks(w, "lease_term")).toContain("H3");
      expect(checks(w, "commencement_date")).toContain("H3");
      expect(checks(w, "expiration_date")).toContain("H3");
      expect(w.get("lease_term")[0].reason).toMatch(/36 month/i);
    });

    it("warns when lease_term is in years and differs from date span", () => {
      // ~60-month span, but states 3 years = 36 months
      const w = validateCrossFieldWarnings(
        makeMap({
          commencement_date: "2024-01-01",
          expiration_date: "2029-01-01",
          lease_term: "3 years",
        }),
        {},
      );
      expect(checks(w, "lease_term")).toContain("H3");
    });

    it("does not warn when lease_term text aligns with date span", () => {
      // ~60-month span, states 60 months
      const w = validateCrossFieldWarnings(
        makeMap({
          commencement_date: "2024-01-01",
          expiration_date: "2029-01-01",
          lease_term: "60 months",
        }),
        {},
      );
      expect(checks(w, "lease_term")).not.toContain("H3");
    });

    it("does not warn when lease_term text is unparseable", () => {
      const w = validateCrossFieldWarnings(
        makeMap({
          commencement_date: "2024-01-01",
          expiration_date: "2029-01-01",
          lease_term: "as described in Exhibit A",
        }),
        {},
      );
      expect(w.has("lease_term")).toBe(false);
    });

    it("does not warn when dates are missing even if lease_term is present", () => {
      const w = validateCrossFieldWarnings(makeMap({ lease_term: "36 months" }), {});
      expect(w.has("lease_term")).toBe(false);
    });

    it("does not emit H3 when H1 fires (dates reversed)", () => {
      const w = validateCrossFieldWarnings(
        makeMap({
          commencement_date: "2025-01-01",
          expiration_date: "2020-01-01",
          lease_term: "60 months",
        }),
        {},
      );
      // When dates are reversed H1 fires and H3 is skipped (days <= 0 branch)
      expect(checks(w, "commencement_date")).toContain("H1");
      expect(checks(w, "lease_term")).not.toContain("H3");
    });
  });

  // ── I1: Square footage consistency ───────────────────────────────────────

  describe("I1 — tenant square footage vs building/property RSF", () => {
    it("warns both fields when tenant SF exceeds building RSF", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ square_footage: 15000, building_rsf: 10000 }),
        {},
      );
      expect(checks(w, "square_footage")).toContain("I1");
      expect(checks(w, "building_rsf")).toContain("I1");
      expect(w.get("square_footage")[0].reason).toMatch(/15,000 SF/);
      expect(w.get("square_footage")[0].reason).toMatch(/10,000 SF/);
    });

    it("does not warn when tenant SF is less than building RSF", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ square_footage: 5000, building_rsf: 50000 }),
        {},
      );
      expect(w.has("square_footage")).toBe(false);
    });

    it("does not warn when tenant SF equals building RSF (edge: exact match is allowed)", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ square_footage: 10000, building_rsf: 10000 }),
        {},
      );
      expect(w.has("square_footage")).toBe(false);
    });

    it("does not warn when building_rsf is absent", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ square_footage: 15000 }),
        {},
      );
      expect(w.has("square_footage")).toBe(false);
    });

    it("does not warn when square_footage is absent", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ building_rsf: 50000 }),
        {},
      );
      expect(w.has("building_rsf")).toBe(false);
    });

    it("does not warn when either value is non-numeric", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ square_footage: "not-a-number", building_rsf: 50000 }),
        {},
      );
      expect(w.has("square_footage")).toBe(false);
    });

    it("handles string-formatted numbers with commas", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ square_footage: "15,000", building_rsf: "10,000" }),
        {},
      );
      expect(checks(w, "square_footage")).toContain("I1");
    });
  });

  // ── K1: Full Service/Gross lease + Tenant responsibility ─────────────────

  describe("K1 — Full Service/Gross lease with Tenant expense responsibility", () => {
    it("warns on full_service lease type + Tenant taxes responsibility", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ lease_type: "full_service", responsibility_taxes: "Tenant" }),
        {},
      );
      expect(checks(w, "responsibility_taxes")).toContain("K1");
      expect(checks(w, "lease_type")).toContain("K1");
      expect(w.get("responsibility_taxes")[0].reason).toMatch(/Full Service\/Gross/);
      expect(w.get("responsibility_taxes")[0].reason).toMatch(/Taxes Responsibility/);
    });

    it("warns on gross lease type + Tenant insurance responsibility", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ lease_type: "gross", responsibility_insurance: "Tenant" }),
        {},
      );
      expect(checks(w, "responsibility_insurance")).toContain("K1");
      expect(checks(w, "lease_type")).toContain("K1");
    });

    it("warns on 'Full Service Gross' free-form text + Tenant repairs", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ lease_type: "Full Service Gross", responsibility_repairs: "tenant" }),
        {},
      );
      expect(checks(w, "responsibility_repairs")).toContain("K1");
    });

    it("does not warn for full_service lease when responsibility is Landlord (correct)", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ lease_type: "full_service", responsibility_taxes: "Landlord" }),
        {},
      );
      expect(checks(w, "responsibility_taxes")).not.toContain("K1");
    });

    it("does not warn for full_service lease when responsibility is Shared (ambiguous)", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ lease_type: "full_service", responsibility_taxes: "Shared" }),
        {},
      );
      expect(checks(w, "responsibility_taxes")).not.toContain("K1");
    });

    it("does not warn for modified_gross lease type (not considered Full Service/Gross)", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ lease_type: "modified_gross", responsibility_taxes: "Tenant" }),
        {},
      );
      expect(checks(w, "responsibility_taxes")).not.toContain("K1");
    });

    it("does not warn when responsibility field is absent", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ lease_type: "full_service" }),
        {},
      );
      expect(w.has("responsibility_taxes")).toBe(false);
    });

    it("does not warn when lease_type is absent", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ responsibility_taxes: "Tenant" }),
        {},
      );
      expect(checks(w, "responsibility_taxes")).not.toContain("K1");
    });

    it("falls back to alias key tax_responsibility in rowByKey", () => {
      const m = new Map();
      m.set("lease_type", { key: "lease_type", normalized_value: "full_service" });
      m.set("tax_responsibility", { key: "tax_responsibility", normalized_value: "Tenant" });
      const w = validateCrossFieldWarnings(m, {});
      expect(checks(w, "responsibility_taxes")).toContain("K1");
    });
  });

  // ── K2: Triple Net/NNN lease + Landlord responsibility ───────────────────

  describe("K2 — Triple Net/NNN lease with Landlord expense responsibility", () => {
    it("warns on triple_net lease type + Landlord taxes responsibility", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ lease_type: "triple_net", responsibility_taxes: "Landlord" }),
        {},
      );
      expect(checks(w, "responsibility_taxes")).toContain("K2");
      expect(checks(w, "lease_type")).toContain("K2");
      expect(w.get("responsibility_taxes")[0].reason).toMatch(/Triple Net\/NNN/);
    });

    it("warns on 'NNN' free-form text + Landlord insurance responsibility", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ lease_type: "NNN", responsibility_insurance: "Landlord" }),
        {},
      );
      expect(checks(w, "responsibility_insurance")).toContain("K2");
    });

    it("warns on 'Triple Net (NNN)' label text + Landlord repairs", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ lease_type: "Triple Net (NNN)", responsibility_repairs: "landlord" }),
        {},
      );
      expect(checks(w, "responsibility_repairs")).toContain("K2");
    });

    it("does not warn for triple_net lease when responsibility is Tenant (correct)", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ lease_type: "triple_net", responsibility_taxes: "Tenant" }),
        {},
      );
      expect(checks(w, "responsibility_taxes")).not.toContain("K2");
    });

    it("does not warn for triple_net when responsibility is Shared (ambiguous)", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ lease_type: "triple_net", responsibility_taxes: "Shared" }),
        {},
      );
      expect(checks(w, "responsibility_taxes")).not.toContain("K2");
    });

    it("does not warn for double_net lease type (not triple net)", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ lease_type: "double_net", responsibility_taxes: "Landlord" }),
        {},
      );
      expect(checks(w, "responsibility_taxes")).not.toContain("K2");
    });

    it("falls back to alias key maintenance_responsibility in rowByKey", () => {
      const m = new Map();
      m.set("lease_type", { key: "lease_type", normalized_value: "triple_net" });
      m.set("maintenance_responsibility", { key: "maintenance_responsibility", normalized_value: "Landlord" });
      const w = validateCrossFieldWarnings(m, {});
      expect(checks(w, "responsibility_repairs")).toContain("K2");
    });
  });

  // ── J1: Security deposit evidence mismatch ───────────────────────────────

  describe("J1 — security deposit consistency_warning", () => {
    it("warns when security_deposit row has consistency_warning true", () => {
      const m = new Map();
      m.set("security_deposit", {
        key: "security_deposit",
        normalized_value: "5000",
        consistency_warning: true,
      });
      const w = validateCrossFieldWarnings(m, {});
      expect(checks(w, "security_deposit")).toContain("J1");
      expect(w.get("security_deposit")[0].reason).toMatch(/not confirmed/i);
    });

    it("does not warn when consistency_warning is false", () => {
      const m = new Map();
      m.set("security_deposit", {
        key: "security_deposit",
        normalized_value: "5000",
        consistency_warning: false,
      });
      const w = validateCrossFieldWarnings(m, {});
      expect(checks(w, "security_deposit")).not.toContain("J1");
    });

    it("does not warn when security_deposit row is absent", () => {
      const w = validateCrossFieldWarnings(new Map(), {});
      expect(w.has("security_deposit")).toBe(false);
    });

    it("does not warn when consistency_warning is undefined (row exists but flag absent)", () => {
      const m = new Map();
      m.set("security_deposit", { key: "security_deposit", normalized_value: "5000" });
      const w = validateCrossFieldWarnings(m, {});
      expect(checks(w, "security_deposit")).not.toContain("J1");
    });
  });

  // ── L1: Escalation rate unusually high ───────────────────────────────────

  describe("L1 — escalation rate > 25%", () => {
    it("warns when escalation_rate is 30 (integer percent)", () => {
      const w = validateCrossFieldWarnings(makeMap({ escalation_rate: 30 }), {});
      expect(checks(w, "escalation_rate")).toContain("L1");
      expect(w.get("escalation_rate")[0].reason).toMatch(/30%/);
    });

    it("warns when escalation_rate is '30%' (string with percent sign)", () => {
      const w = validateCrossFieldWarnings(makeMap({ escalation_rate: "30%" }), {});
      expect(checks(w, "escalation_rate")).toContain("L1");
    });

    it("warns when escalation_rate is 0.30 (decimal fraction → 30%)", () => {
      const w = validateCrossFieldWarnings(makeMap({ escalation_rate: 0.30 }), {});
      expect(checks(w, "escalation_rate")).toContain("L1");
    });

    it("does not warn when rate is 3 (3%)", () => {
      const w = validateCrossFieldWarnings(makeMap({ escalation_rate: 3 }), {});
      expect(w.has("escalation_rate")).toBe(false);
    });

    it("does not warn when rate is exactly 25 (boundary — not strictly greater)", () => {
      const w = validateCrossFieldWarnings(makeMap({ escalation_rate: 25 }), {});
      expect(checks(w, "escalation_rate")).not.toContain("L1");
    });

    it("does not warn when rate is 0.03 (decimal fraction → 3%)", () => {
      const w = validateCrossFieldWarnings(makeMap({ escalation_rate: 0.03 }), {});
      expect(w.has("escalation_rate")).toBe(false);
    });

    it("does not warn when escalation_rate is absent", () => {
      const w = validateCrossFieldWarnings(new Map(), {});
      expect(w.has("escalation_rate")).toBe(false);
    });

    it("does not warn when escalation_rate is non-numeric text", () => {
      const w = validateCrossFieldWarnings(makeMap({ escalation_rate: "CPI" }), {});
      expect(w.has("escalation_rate")).toBe(false);
    });
  });

  // ── L2: Annual escalation with short lease term ──────────────────────────

  describe("L2 — annual escalation timing with term under 12 months", () => {
    it("warns when timing is annual and term is under 12 months", () => {
      const w = validateCrossFieldWarnings(
        makeMap({
          escalation_timing: "Annual",
          commencement_date: "2024-01-01",
          expiration_date: "2024-06-01",
        }),
        {},
      );
      expect(checks(w, "escalation_timing")).toContain("L2");
      expect(w.get("escalation_timing")[0].reason).toMatch(/under 12 months/i);
    });

    it("warns when timing is canonical slug lease_anniversary and term is short", () => {
      const w = validateCrossFieldWarnings(
        makeMap({
          escalation_timing: "lease_anniversary",
          commencement_date: "2024-01-01",
          expiration_date: "2024-09-01",
        }),
        {},
      );
      expect(checks(w, "escalation_timing")).toContain("L2");
    });

    it("warns when timing is calendar_year and term is under 12 months", () => {
      const w = validateCrossFieldWarnings(
        makeMap({
          escalation_timing: "calendar_year",
          commencement_date: "2024-01-01",
          expiration_date: "2024-06-01",
        }),
        {},
      );
      expect(checks(w, "escalation_timing")).toContain("L2");
    });

    it("does not warn when term is exactly 365 days (≥ 12 months)", () => {
      const w = validateCrossFieldWarnings(
        makeMap({
          escalation_timing: "Annual",
          commencement_date: "2024-01-01",
          expiration_date: "2025-01-01",
        }),
        {},
      );
      expect(checks(w, "escalation_timing")).not.toContain("L2");
    });

    it("does not warn when timing is not annual-type text", () => {
      const w = validateCrossFieldWarnings(
        makeMap({
          escalation_timing: "monthly",
          commencement_date: "2024-01-01",
          expiration_date: "2024-06-01",
        }),
        {},
      );
      expect(checks(w, "escalation_timing")).not.toContain("L2");
    });

    it("does not warn when escalation_timing is absent", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ commencement_date: "2024-01-01", expiration_date: "2024-06-01" }),
        {},
      );
      expect(w.has("escalation_timing")).toBe(false);
    });

    it("does not warn when dates are absent", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ escalation_timing: "Annual" }),
        {},
      );
      expect(w.has("escalation_timing")).toBe(false);
    });

    it("does not warn when dates are reversed (H1 territory, term is not > 0)", () => {
      const w = validateCrossFieldWarnings(
        makeMap({
          escalation_timing: "Annual",
          commencement_date: "2025-01-01",
          expiration_date: "2024-01-01",
        }),
        {},
      );
      expect(checks(w, "escalation_timing")).not.toContain("L2");
    });
  });

  // ── L3: Escalation date outside lease term ────────────────────────────────

  describe("L3 — escalation date outside lease term", () => {
    it("warns when escalation date is before commencement date", () => {
      const w = validateCrossFieldWarnings(
        makeMap({
          escalation_date: "2023-06-01",
          commencement_date: "2024-01-01",
          expiration_date: "2029-01-01",
        }),
        {},
      );
      expect(checks(w, "escalation_date")).toContain("L3");
      expect(w.get("escalation_date")[0].reason).toMatch(/outside the lease term/i);
    });

    it("warns when escalation date is after expiration date", () => {
      const w = validateCrossFieldWarnings(
        makeMap({
          escalation_date: "2030-01-01",
          commencement_date: "2024-01-01",
          expiration_date: "2029-01-01",
        }),
        {},
      );
      expect(checks(w, "escalation_date")).toContain("L3");
    });

    it("does not warn when escalation date is within lease term", () => {
      const w = validateCrossFieldWarnings(
        makeMap({
          escalation_date: "2025-01-01",
          commencement_date: "2024-01-01",
          expiration_date: "2029-01-01",
        }),
        {},
      );
      expect(w.has("escalation_date")).toBe(false);
    });

    it("does not warn when escalation date is absent", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ commencement_date: "2024-01-01", expiration_date: "2029-01-01" }),
        {},
      );
      expect(w.has("escalation_date")).toBe(false);
    });

    it("does not warn when commencement or expiration date is absent", () => {
      const w = validateCrossFieldWarnings(
        makeMap({ escalation_date: "2023-06-01", commencement_date: "2024-01-01" }),
        {},
      );
      expect(checks(w, "escalation_date")).not.toContain("L3");
    });

    it("does not warn when escalation date is unparseable", () => {
      const w = validateCrossFieldWarnings(
        makeMap({
          escalation_date: "not-a-date",
          commencement_date: "2024-01-01",
          expiration_date: "2029-01-01",
        }),
        {},
      );
      expect(w.has("escalation_date")).toBe(false);
    });

    it("does not warn when lease dates are reversed (L3 guard: termDays > 0)", () => {
      const w = validateCrossFieldWarnings(
        makeMap({
          escalation_date: "2030-01-01",
          commencement_date: "2029-01-01",
          expiration_date: "2024-01-01",
        }),
        {},
      );
      expect(checks(w, "escalation_date")).not.toContain("L3");
    });
  });

  // ── General robustness ────────────────────────────────────────────────────

  describe("robustness", () => {
    it("returns an empty Map when no fields are present", () => {
      const w = validateCrossFieldWarnings(new Map(), {});
      expect(w.size).toBe(0);
    });

    it("returns an empty Map when rowByKey is null", () => {
      const w = validateCrossFieldWarnings(null, {});
      expect(w.size).toBe(0);
    });

    it("does not throw when lease is null", () => {
      expect(() => validateCrossFieldWarnings(new Map(), null)).not.toThrow();
    });
  });
});
