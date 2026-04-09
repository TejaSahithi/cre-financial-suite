/**
 * Shared dropdown options for lease fields.
 *
 * Each entry is an array of { value, label }. The UI presents these as a
 * dropdown plus a "Custom..." entry that lets the user type a free-form value.
 * Free-form values are persisted as-is on the lease record.
 */

export const LEASE_FIELD_OPTIONS = {
  lease_type: [
    { value: "triple_net", label: "Triple Net (NNN)" },
    { value: "modified_gross", label: "Modified Gross" },
    { value: "gross", label: "Gross" },
    { value: "full_service", label: "Full Service" },
    { value: "double_net", label: "Double Net (NN)" },
    { value: "single_net", label: "Single Net (N)" },
    { value: "absolute_net", label: "Absolute Net" },
    { value: "percentage", label: "Percentage Lease" },
    { value: "ground", label: "Ground Lease" },
  ],

  renewal_type: [
    { value: "fixed_term", label: "Fixed Term" },
    { value: "fair_market", label: "Fair Market Value" },
    { value: "fixed_increase", label: "Fixed % Increase" },
    { value: "cpi_indexed", label: "CPI Indexed" },
    { value: "negotiated", label: "Negotiated at Renewal" },
    { value: "automatic", label: "Automatic Renewal" },
    { value: "none", label: "No Renewal Option" },
  ],

  renewal_options: [
    { value: "1x5", label: "1 × 5 years" },
    { value: "2x5", label: "2 × 5 years" },
    { value: "3x5", label: "3 × 5 years" },
    { value: "1x3", label: "1 × 3 years" },
    { value: "2x3", label: "2 × 3 years" },
    { value: "1x10", label: "1 × 10 years" },
    { value: "month_to_month", label: "Month-to-Month" },
    { value: "none", label: "No Renewal" },
  ],

  escalation_type: [
    { value: "fixed_pct", label: "Fixed %" },
    { value: "cpi", label: "CPI" },
    { value: "stepped", label: "Stepped Increase" },
    { value: "fmv", label: "Fair Market Value" },
    { value: "none", label: "None" },
  ],

  escalation_timing: [
    { value: "lease_anniversary", label: "Lease Anniversary" },
    { value: "calendar_year", label: "Calendar Year (Jan 1)" },
    { value: "fiscal_year", label: "Fiscal Year" },
  ],

  cam_cap_type: [
    { value: "none", label: "None" },
    { value: "cumulative", label: "Cumulative" },
    { value: "non_cumulative", label: "Non-Cumulative" },
    { value: "compounding", label: "Compounding" },
  ],

  hvac_responsibility: [
    { value: "landlord", label: "Landlord" },
    { value: "tenant", label: "Tenant" },
    { value: "shared", label: "Shared" },
    { value: "landlord_with_cap", label: "Landlord (with cap)" },
  ],

  management_fee_basis: [
    { value: "cam_pool_pro_rata", label: "CAM Pool Pro-Rata" },
    { value: "tenant_annual_rent", label: "% of Tenant Annual Rent" },
    { value: "gross_rent", label: "% of Gross Rent" },
    { value: "fixed", label: "Fixed Amount" },
  ],

  sales_reporting_frequency: [
    { value: "monthly", label: "Monthly" },
    { value: "quarterly", label: "Quarterly" },
    { value: "annual", label: "Annual" },
    { value: "none", label: "None" },
  ],
};

/**
 * Resolve a stored value to its display label, falling back to the raw value
 * (so custom user-entered strings render verbatim).
 */
export function getLeaseFieldLabel(field, value) {
  if (value == null || value === "") return "";
  const options = LEASE_FIELD_OPTIONS[field];
  if (!options) return String(value);
  const match = options.find((option) => option.value === value);
  return match ? match.label : String(value);
}

export function hasLeaseFieldOptions(field) {
  return Boolean(LEASE_FIELD_OPTIONS[field]);
}
