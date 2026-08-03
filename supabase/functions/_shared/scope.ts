// @ts-nocheck
/**
 * Canonical server-side scope representation for financial calculation
 * engines (CAM today; other engines can adopt the same primitive later).
 *
 * A "scope" identifies exactly which node of the property hierarchy a
 * calculation run applies to:
 *   - scope_level: "property" | "building" | "unit"
 *   - scope_id:    the property/building/unit UUID the run is for
 *   - property_id: the parent property UUID (== scope_id when scope_level
 *                  is "property")
 *
 * This is the single definition other modules should import rather than
 * redeclaring the "property" | "building" | "unit" union locally.
 */

export type ScopeLevel = "property" | "building" | "unit";

export const SCOPE_LEVELS: ScopeLevel[] = ["property", "building", "unit"];

/**
 * Engines whose computation_snapshots inputs never mention scope_level /
 * scope_id at all — they have no building/unit-level granularity yet, so a
 * missing scope on their snapshots is normal and defaults to "property"
 * (see _shared/snapshot.ts's resolveSnapshotScope). This is a closed,
 * reviewed list, not a fallback for any engine that happens to omit scope:
 * adding an engine_type here is a deliberate decision that it's still
 * property-only, not a way to silence a validation error. Verified by
 * repo-wide grep of every saveSnapshot/findMatchingCompletedSnapshot call
 * site as of this PR — six engine_types exist in total: "cam" and "lease"
 * both always provide an explicit, valid scope (compute-cam via this
 * module; compute-lease via _shared/rent-schedule.ts's
 * normalizeScopeSelection, which independently uses the same
 * property/building/unit vocabulary) and are therefore intentionally NOT
 * in this list — a missing scope from either of those two would indicate a
 * bug, not a legacy gap, and must fail closed rather than silently default.
 */
export const LEGACY_SCOPE_DEFAULT_ENGINES: ReadonlySet<string> = new Set([
  "budget",
  "expense",
  "revenue",
  "reconciliation",
]);

export interface ResolvedScope {
  scope_level: ScopeLevel;
  scope_id: string;
  property_id: string;
}

export function isValidScopeLevel(value: unknown): value is ScopeLevel {
  return typeof value === "string" && (SCOPE_LEVELS as string[]).includes(value);
}

/**
 * Validates that (scope_level, scope_id) is a real, org-owned node of the
 * given property's hierarchy, using the admin client directly rather than
 * relying on RLS — Edge Functions read via an administrative Supabase
 * client, so RLS cannot be relied on to catch a scope_id that belongs to a
 * different property/organization.
 *
 * This is a data-integrity/hierarchy check, distinct from
 * assertPropertyAccess (a permission check on whether the calling user may
 * act on the property at all). Call both: assertPropertyAccess for "is this
 * user allowed here", this for "does this scope_id actually belong here".
 *
 * Fails closed (throws) for: unknown scope_level, missing/empty scope_id at
 * building/unit level, a property not owned by the organization, or a
 * building/unit that doesn't belong to both the given property and
 * organization.
 */
export async function assertValidScopeHierarchy(
  supabaseAdmin: any,
  orgId: string,
  propertyId: string,
  scopeLevel: unknown,
  scopeId: unknown,
): Promise<ResolvedScope> {
  if (!isValidScopeLevel(scopeLevel)) {
    throw new Error(
      `Invalid scope_level "${scopeLevel}" — must be one of: ${SCOPE_LEVELS.join(", ")}`,
    );
  }

  if (!propertyId || typeof propertyId !== "string") {
    throw new Error("property_id is required to resolve a scope");
  }

  const { data: property, error: propertyError } = await supabaseAdmin
    .from("properties")
    .select("id")
    .eq("id", propertyId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (propertyError) {
    throw new Error(`Property lookup failed while validating scope: ${propertyError.message}`);
  }
  if (!property) {
    throw new Error(
      `Invalid scope: property ${propertyId} was not found in organization ${orgId}`,
    );
  }

  if (scopeLevel === "property") {
    if (scopeId !== propertyId) {
      throw new Error(
        `Invalid scope: scope_id must equal property_id ("${propertyId}") when scope_level is "property", got "${scopeId}"`,
      );
    }
    return { scope_level: "property", scope_id: propertyId, property_id: propertyId };
  }

  if (!scopeId || typeof scopeId !== "string") {
    throw new Error(`scope_id is required when scope_level is "${scopeLevel}"`);
  }

  if (scopeLevel === "building") {
    const { data: building, error } = await supabaseAdmin
      .from("buildings")
      .select("id")
      .eq("id", scopeId)
      .eq("property_id", propertyId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (error) {
      throw new Error(`Building lookup failed while validating scope: ${error.message}`);
    }
    if (!building) {
      throw new Error(
        `Invalid scope: building ${scopeId} does not belong to property ${propertyId} in organization ${orgId}`,
      );
    }
    return { scope_level: "building", scope_id: scopeId, property_id: propertyId };
  }

  // scopeLevel === "unit"
  const { data: unit, error } = await supabaseAdmin
    .from("units")
    .select("id")
    .eq("id", scopeId)
    .eq("property_id", propertyId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) {
    throw new Error(`Unit lookup failed while validating scope: ${error.message}`);
  }
  if (!unit) {
    throw new Error(
      `Invalid scope: unit ${scopeId} does not belong to property ${propertyId} in organization ${orgId}`,
    );
  }
  return { scope_level: "unit", scope_id: scopeId, property_id: propertyId };
}
