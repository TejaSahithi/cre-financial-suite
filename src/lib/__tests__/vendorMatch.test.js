import { describe, it, expect } from "vitest";
import { expenseMatchesVendor } from "../vendorMatch";

describe("expenseMatchesVendor", () => {
  const vendor = { id: "vendor-1", name: "Sevier County Trustee" };

  it("matches on vendor_id even when name fields are absent", () => {
    expect(expenseMatchesVendor({ vendor_id: "vendor-1" }, vendor)).toBe(true);
  });

  it("matches on the vendor text field", () => {
    expect(expenseMatchesVendor({ vendor: "Sevier County Trustee" }, vendor)).toBe(true);
  });

  it("matches on vendor_name when vendor is null -- the VendorProfile.jsx regression", () => {
    // bulk_create_expenses_workflow / create_expense_workflow only COALESCE
    // vendor_name from vendor, never the reverse, so a row imported with
    // only vendor_name set has vendor === null. VendorProfile.jsx used to
    // check e.vendor alone and silently drop rows like this from a
    // vendor's total while Vendors.jsx's list page still counted them.
    expect(expenseMatchesVendor({ vendor: null, vendor_name: "Sevier County Trustee" }, vendor)).toBe(true);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(expenseMatchesVendor({ vendor: "  sevier county trustee  " }, vendor)).toBe(true);
  });

  it("does not match an unrelated vendor", () => {
    expect(expenseMatchesVendor({ vendor: "Knoxville Lease Counsel", vendor_id: "vendor-2" }, vendor)).toBe(false);
  });

  it("does not match when both sides have no name and no shared id", () => {
    expect(expenseMatchesVendor({ vendor: null, vendor_name: null }, { id: null, name: null })).toBe(false);
  });
});
