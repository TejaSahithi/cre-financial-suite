import { describe, it, expect } from "vitest";
import {
  LEASE_FIELD_CONTRACT,
  STANDARD_FIELD_GROUPS,
  resolveCanonicalFieldKey,
  getFieldContract,
  getFieldsForGroup,
  getFieldGroup,
} from "@/lib/leaseFieldContract";

describe("leaseFieldContract", () => {
  it("resolves canonical keys to themselves", () => {
    expect(resolveCanonicalFieldKey("monthly_rent")).toBe("monthly_rent");
    expect(resolveCanonicalFieldKey("square_footage")).toBe("square_footage");
  });

  it("resolves the base_rent_monthly alias to canonical monthly_rent", () => {
    expect(resolveCanonicalFieldKey("base_rent_monthly")).toBe("monthly_rent");
  });

  it("resolves the tenant_rsf alias to canonical square_footage", () => {
    expect(resolveCanonicalFieldKey("tenant_rsf")).toBe("square_footage");
    expect(resolveCanonicalFieldKey("rentable_area_sqft")).toBe("square_footage");
  });

  it("returns an unknown key unchanged rather than throwing", () => {
    expect(resolveCanonicalFieldKey("totally_made_up_key")).toBe("totally_made_up_key");
  });

  it("effective_date resolves to assignment_effective_date, not lease_date", () => {
    expect(resolveCanonicalFieldKey("effective_date")).toBe("assignment_effective_date");
  });

  it("does not conflate alternateFieldKeys with aliases", () => {
    // start_date and commencement_date are two distinct, independently
    // extracted LEASE_SCHEMA fields (OR-alternates for core readiness),
    // not aliases of a single field.
    expect(resolveCanonicalFieldKey("start_date")).toBe("start_date");
    expect(resolveCanonicalFieldKey("commencement_date")).toBe("commencement_date");
    const startDate = getFieldContract("start_date");
    expect(startDate.alternateFieldKeys).toContain("commencement_date");
  });

  it("getFieldContract resolves through an alias", () => {
    const contract = getFieldContract("base_rent_monthly");
    expect(contract.canonicalKey).toBe("monthly_rent");
    expect(contract.group).toBe("rent_charges");
  });

  it("getFieldsForGroup returns only fields in that group", () => {
    const parties = getFieldsForGroup("parties");
    expect(parties.length).toBeGreaterThan(0);
    expect(parties.every((f) => f.group === "parties")).toBe(true);
  });

  it("getFieldGroup is a convenience wrapper matching getFieldContract().group", () => {
    expect(getFieldGroup("tenant_name")).toBe("parties");
    expect(getFieldGroup("base_rent_monthly")).toBe("rent_charges");
    expect(getFieldGroup("not_a_real_field")).toBeNull();
  });

  it("STANDARD_FIELD_GROUPS has all 17 groups, each represented in LEASE_FIELD_CONTRACT", () => {
    expect(STANDARD_FIELD_GROUPS.length).toBe(17);
    const usedGroups = new Set(LEASE_FIELD_CONTRACT.map((e) => e.group));
    for (const group of STANDARD_FIELD_GROUPS) {
      expect(usedGroups.has(group.key)).toBe(true);
    }
  });

  it("has no duplicate canonicalKeys", () => {
    const keys = LEASE_FIELD_CONTRACT.map((e) => e.canonicalKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("tenant_pro_rata_share is computed, not a real LEASE_SCHEMA field", () => {
    const entry = getFieldContract("tenant_pro_rata_share");
    expect(entry.computed).toBe(true);
    expect(entry.inLeaseSchema).toBe(false);
  });
});

describe("leaseFieldContract: canonical tab ownership", () => {
  it("assigns each standard field exactly one editable canonical tab", () => {
    for (const entry of LEASE_FIELD_CONTRACT) {
      const contract = getFieldContract(entry.canonicalKey);
      expect(contract.canonicalTab).toBeTruthy();
      expect(Array.isArray(contract.readOnlyReferences)).toBe(true);
      expect(contract.readOnlyReferences).not.toContain(contract.canonicalTab);
    }
  });

  it("keeps rent and square footage in one editable home with read-only references", () => {
    expect(getFieldContract("monthly_rent").canonicalTab).toBe("rent_charges");
    expect(getFieldContract("monthly_rent").readOnlyReferences).toContain("budget_preview");
    expect(getFieldContract("square_footage").canonicalTab).toBe("parties_premises");
    expect(getFieldContract("square_footage").readOnlyReferences).toContain("cam_rules");
  });
});
