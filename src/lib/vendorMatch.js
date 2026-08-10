/**
 * Whether an expense row belongs to a given vendor. Checks vendor OR
 * vendor_name -- the bulk-create RPCs (bulk_create_expenses_workflow,
 * create_expense_workflow) only COALESCE vendor_name from vendor, never the
 * reverse, so a row imported with only vendor_name set has vendor === null.
 * Checking vendor alone (as VendorProfile.jsx used to) silently drops those
 * rows from a vendor's total while Vendors.jsx's list page still counted
 * them, producing a mismatch between the two pages for the same vendor.
 * Single shared implementation so the two pages can't drift apart again.
 */
export function expenseMatchesVendor(expense = {}, vendor = {}) {
  const expenseVendorName = String(expense?.vendor || expense?.vendor_name || "").trim().toLowerCase();
  const vendorName = String(vendor?.name || "").trim().toLowerCase();
  const nameMatches = Boolean(expenseVendorName) && expenseVendorName === vendorName;
  const idMatches = Boolean(vendor?.id) && expense?.vendor_id === vendor.id;
  return nameMatches || idMatches;
}
