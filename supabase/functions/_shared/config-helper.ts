// @ts-nocheck
/**
 * Configuration Helper Module
 * Task 14: Configuration layer for business rules
 * Requirements: 13.1, 13.2, 13.3, 13.5
 *
 * Centralizes reading property_config and lease_config with defaults.
 * Computation engines import this module to resolve effective configuration
 * for any property/lease combination.
 */

// ============================================================
// System-wide defaults — used when no property_config row exists
// or when individual fields are NULL.
// ============================================================

export const SYSTEM_DEFAULTS = {
  cam_calculation_method: 'pro_rata',
  expense_recovery_method: 'base_year',
  fiscal_year_start: 1,
  admin_fee_pct: 10,
  gross_up_pct: 0,
  escalation_rate: 3,
  cam_per_sf: 0,
};

// ============================================================
// Allowed enum values for validation
// ============================================================

const VALID_CAM_METHODS = ['pro_rata', 'fixed', 'capped'] as const;
const VALID_EXPENSE_RECOVERY_METHODS = ['base_year', 'full', 'none'] as const;

// ============================================================
// Type definitions
// ============================================================

export interface PropertyConfig {
  cam_calculation_method: string;
  expense_recovery_method: string;
  fiscal_year_start: number;
  admin_fee_pct: number;
  gross_up_pct: number;
  escalation_rate: number;
  cam_per_sf: number;
  [key: string]: any;
}

export interface LeaseConfig {
  lease_id: string;
  org_id: string;
  cam_cap: number | null;
  base_year: number | null;
  excluded_expenses: string[] | null;
  config_values: Record<string, any>;
  [key: string]: any;
}

export interface EffectiveConfig extends PropertyConfig {
  cam_cap?: number | null;
  base_year?: number | null;
  excluded_expenses?: string[] | null;
}

export interface ValidationError {
  field: string;
  message: string;
  value: any;
}

// ============================================================
// getPropertyConfig
// ============================================================

/**
 * Fetches property-level configuration and merges with SYSTEM_DEFAULTS.
 *
 * @param supabaseAdmin - Supabase admin client (service-role)
 * @param propertyId    - UUID of the property
 * @param orgId         - UUID of the organization (for RLS / ownership check)
 * @returns Merged property configuration with all fields guaranteed present
 */
export async function getPropertyConfig(
  supabaseAdmin: any,
  propertyId: string,
  orgId: string,
): Promise<PropertyConfig> {
  const { data, error } = await supabaseAdmin
    .from('property_config')
    .select('cam_calculation_method, expense_recovery_method, fiscal_year_start, config_values')
    .eq('property_id', propertyId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (error) {
    console.error('[config-helper] property_config query error:', error.message);
  }

  // Start from system defaults
  const merged: PropertyConfig = { ...SYSTEM_DEFAULTS };

  if (data) {
    // Overlay explicit column values (only when non-null)
    if (data.cam_calculation_method != null) {
      merged.cam_calculation_method = data.cam_calculation_method;
    }
    if (data.expense_recovery_method != null) {
      merged.expense_recovery_method = data.expense_recovery_method;
    }
    if (data.fiscal_year_start != null) {
      merged.fiscal_year_start = data.fiscal_year_start;
    }

    // Overlay JSONB config_values (may contain admin_fee_pct, gross_up_pct, etc.)
    const cv = data.config_values ?? {};
    if (cv.admin_fee_pct != null) merged.admin_fee_pct = Number(cv.admin_fee_pct);
    if (cv.gross_up_pct != null) merged.gross_up_pct = Number(cv.gross_up_pct);
    if (cv.escalation_rate != null) merged.escalation_rate = Number(cv.escalation_rate);
    if (cv.cam_per_sf != null) merged.cam_per_sf = Number(cv.cam_per_sf);

    // Spread any remaining config_values so callers have access
    for (const [key, value] of Object.entries(cv)) {
      if (!(key in merged)) {
        merged[key] = value;
      }
    }
  }

  // --- Validation ---
  if (!VALID_CAM_METHODS.includes(merged.cam_calculation_method as any)) {
    console.warn(
      `[config-helper] Invalid cam_calculation_method "${merged.cam_calculation_method}", falling back to "${SYSTEM_DEFAULTS.cam_calculation_method}"`,
    );
    merged.cam_calculation_method = SYSTEM_DEFAULTS.cam_calculation_method;
  }

  if (!VALID_EXPENSE_RECOVERY_METHODS.includes(merged.expense_recovery_method as any)) {
    console.warn(
      `[config-helper] Invalid expense_recovery_method "${merged.expense_recovery_method}", falling back to "${SYSTEM_DEFAULTS.expense_recovery_method}"`,
    );
    merged.expense_recovery_method = SYSTEM_DEFAULTS.expense_recovery_method;
  }

  if (merged.fiscal_year_start < 1 || merged.fiscal_year_start > 12) {
    console.warn(
      `[config-helper] fiscal_year_start ${merged.fiscal_year_start} out of range 1-12, falling back to ${SYSTEM_DEFAULTS.fiscal_year_start}`,
    );
    merged.fiscal_year_start = SYSTEM_DEFAULTS.fiscal_year_start;
  }

  return merged;
}

// ============================================================
// getLeaseConfig
// ============================================================

/**
 * Fetches lease-level configuration overrides.
 *
 * @param supabaseAdmin - Supabase admin client (service-role)
 * @param leaseId       - UUID of the lease
 * @param orgId         - UUID of the organization
 * @returns LeaseConfig or null if no config row exists
 */
export async function getLeaseConfig(
  supabaseAdmin: any,
  leaseId: string,
  orgId: string,
): Promise<LeaseConfig | null> {
  const { data, error } = await supabaseAdmin
    .from('lease_config')
    .select('lease_id, org_id, cam_cap, base_year, excluded_expenses, config_values')
    .eq('lease_id', leaseId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (error) {
    console.error('[config-helper] lease_config query error:', error.message);
    return null;
  }

  if (!data) {
    return null;
  }

  const leaseConfig: LeaseConfig = {
    lease_id: data.lease_id,
    org_id: data.org_id,
    cam_cap: data.cam_cap != null ? Number(data.cam_cap) : null,
    base_year: data.base_year != null ? Number(data.base_year) : null,
    excluded_expenses: data.excluded_expenses ?? null,
    config_values: data.config_values ?? {},
  };

  // --- Validation ---
  if (leaseConfig.cam_cap != null && leaseConfig.cam_cap < 0) {
    console.warn(
      `[config-helper] cam_cap ${leaseConfig.cam_cap} is negative, setting to null`,
    );
    leaseConfig.cam_cap = null;
  }

  if (leaseConfig.base_year != null && (leaseConfig.base_year < 1900 || leaseConfig.base_year > 2100)) {
    console.warn(
      `[config-helper] base_year ${leaseConfig.base_year} out of range 1900-2100, setting to null`,
    );
    leaseConfig.base_year = null;
  }

  return leaseConfig;
}

// ============================================================
// getConfigWithDefaults
// ============================================================

/**
 * Merges property config with system defaults, then overlays lease-specific
 * overrides to produce the final effective configuration for a given lease.
 *
 * @param propertyConfig - Resolved property config (from getPropertyConfig)
 * @param leaseConfig    - Lease-specific overrides (may be null)
 * @returns Final effective config with all values resolved
 */
export function getConfigWithDefaults(
  propertyConfig: PropertyConfig,
  leaseConfig: LeaseConfig | null,
): EffectiveConfig {
  // Start with system defaults, then overlay property config
  const effective: EffectiveConfig = {
    ...SYSTEM_DEFAULTS,
    ...propertyConfig,
  };

  // Overlay lease-specific overrides
  if (leaseConfig) {
    if (leaseConfig.cam_cap != null) {
      effective.cam_cap = leaseConfig.cam_cap;
    }
    if (leaseConfig.base_year != null) {
      effective.base_year = leaseConfig.base_year;
    }
    if (leaseConfig.excluded_expenses != null) {
      effective.excluded_expenses = leaseConfig.excluded_expenses;
    }

    // Overlay any additional config_values from the lease
    const lcv = leaseConfig.config_values ?? {};
    for (const [key, value] of Object.entries(lcv)) {
      if (value != null) {
        effective[key] = value;
      }
    }
  }

  return effective;
}

// ============================================================
// validateConfigValues
// ============================================================

/**
 * Validates that all config values are within acceptable ranges.
 *
 * @param config - Configuration object to validate
 * @returns Array of validation errors (empty array if all values are valid)
 */
export function validateConfigValues(config: Record<string, any>): ValidationError[] {
  const errors: ValidationError[] = [];

  // cam_calculation_method
  if (
    config.cam_calculation_method != null &&
    !VALID_CAM_METHODS.includes(config.cam_calculation_method)
  ) {
    errors.push({
      field: 'cam_calculation_method',
      message: `Must be one of: ${VALID_CAM_METHODS.join(', ')}`,
      value: config.cam_calculation_method,
    });
  }

  // expense_recovery_method
  if (
    config.expense_recovery_method != null &&
    !VALID_EXPENSE_RECOVERY_METHODS.includes(config.expense_recovery_method)
  ) {
    errors.push({
      field: 'expense_recovery_method',
      message: `Must be one of: ${VALID_EXPENSE_RECOVERY_METHODS.join(', ')}`,
      value: config.expense_recovery_method,
    });
  }

  // fiscal_year_start: 1-12
  if (config.fiscal_year_start != null) {
    const fys = Number(config.fiscal_year_start);
    if (!Number.isInteger(fys) || fys < 1 || fys > 12) {
      errors.push({
        field: 'fiscal_year_start',
        message: 'Must be an integer between 1 and 12',
        value: config.fiscal_year_start,
      });
    }
  }

  // admin_fee_pct: 0-100
  if (config.admin_fee_pct != null) {
    const afp = Number(config.admin_fee_pct);
    if (isNaN(afp) || afp < 0 || afp > 100) {
      errors.push({
        field: 'admin_fee_pct',
        message: 'Must be a number between 0 and 100',
        value: config.admin_fee_pct,
      });
    }
  }

  // gross_up_pct: 0-100
  if (config.gross_up_pct != null) {
    const gup = Number(config.gross_up_pct);
    if (isNaN(gup) || gup < 0 || gup > 100) {
      errors.push({
        field: 'gross_up_pct',
        message: 'Must be a number between 0 and 100',
        value: config.gross_up_pct,
      });
    }
  }

  // escalation_rate: 0-50 (reasonable cap)
  if (config.escalation_rate != null) {
    const er = Number(config.escalation_rate);
    if (isNaN(er) || er < 0 || er > 50) {
      errors.push({
        field: 'escalation_rate',
        message: 'Must be a number between 0 and 50',
        value: config.escalation_rate,
      });
    }
  }

  // cam_per_sf: >= 0
  if (config.cam_per_sf != null) {
    const cps = Number(config.cam_per_sf);
    if (isNaN(cps) || cps < 0) {
      errors.push({
        field: 'cam_per_sf',
        message: 'Must be a non-negative number',
        value: config.cam_per_sf,
      });
    }
  }

  // cam_cap: >= 0 (if present)
  if (config.cam_cap != null) {
    const cc = Number(config.cam_cap);
    if (isNaN(cc) || cc < 0) {
      errors.push({
        field: 'cam_cap',
        message: 'Must be a non-negative number',
        value: config.cam_cap,
      });
    }
  }

  // base_year: 1900-2100 (if present)
  if (config.base_year != null) {
    const by = Number(config.base_year);
    if (!Number.isInteger(by) || by < 1900 || by > 2100) {
      errors.push({
        field: 'base_year',
        message: 'Must be an integer between 1900 and 2100',
        value: config.base_year,
      });
    }
  }

  return errors;
}
