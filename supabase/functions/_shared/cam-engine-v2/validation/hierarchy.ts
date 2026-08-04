// @ts-nocheck
/**
 * Backend organization and hierarchy validation for the polymorphic
 * scope_type/scope_id columns introduced by the Enterprise CAM & Budget
 * Implementation Blueprint v1.0 Phase 1 schema (space_area_measurements,
 * space_occupancy_periods, recovery_pools, recovery_pool_scope_members,
 * cam_runs). None of those columns can carry a real foreign key — a
 * "property vs. building vs. unit vs. custom" scope_id can't reference a
 * single table — so hierarchy validity has to be checked here, in
 * application/RPC code, the same way _shared/scope.ts's
 * assertValidScopeHierarchy already does for compute-cam's own
 * scope_level/scope_id.
 *
 * This module deliberately delegates to assertValidScopeHierarchy for the
 * property/building/unit vocabulary rather than re-implementing the same
 * property/building/unit lookups a second time — the two "scope" concepts
 * (compute-cam's scope_level and this blueprint's scope_type) mean the same
 * thing whenever both use the property/building/unit vocabulary, so there
 * is exactly one hierarchy-lookup implementation in the codebase, not two
 * that could drift apart.
 */
import { assertValidScopeHierarchy, isValidScopeLevel, type ResolvedScope } from "../../scope.ts";

export type PoolScopeType = "property" | "building" | "custom";
export type PoolMemberScopeType = "building" | "unit";

/**
 * space_area_measurements.scope_type / space_occupancy_periods.scope_type
 * use the exact same property | building | unit vocabulary as
 * compute-cam's scope_level — reuse assertValidScopeHierarchy directly.
 */
export async function assertValidSpaceScope(
  supabaseAdmin: any,
  orgId: string,
  propertyId: string,
  scopeType: unknown,
  scopeId: unknown,
): Promise<ResolvedScope> {
  return assertValidScopeHierarchy(supabaseAdmin, orgId, propertyId, scopeType, scopeId);
}

/**
 * recovery_pool_scope_members.scope_type only ever takes "building" or
 * "unit" — a pool's own row already carries the property, and a member
 * can never itself be "the whole property" (that's not membership, that's
 * the pool's own scope). Fails closed for "property" and for anything
 * assertValidScopeHierarchy itself would reject.
 */
export async function assertValidPoolMemberScope(
  supabaseAdmin: any,
  orgId: string,
  propertyId: string,
  scopeType: unknown,
  scopeId: unknown,
): Promise<ResolvedScope> {
  if (scopeType !== "building" && scopeType !== "unit") {
    throw new Error(
      `Invalid pool scope member scope_type "${scopeType}" — must be "building" or "unit" (a pool member cannot itself be the whole property)`,
    );
  }
  return assertValidScopeHierarchy(supabaseAdmin, orgId, propertyId, scopeType, scopeId);
}

/**
 * recovery_pools.scope_type / cam_runs.scope_type add a third option,
 * "custom" — a named participant set with no single physical hierarchy
 * node to validate against (its real membership lives in
 * recovery_pool_scope_members rows, each independently validated via
 * assertValidPoolMemberScope). "custom" scope_id is intentionally not
 * required to resolve to anything; property/building still delegate to the
 * shared hierarchy check.
 */
export async function assertValidPoolScope(
  supabaseAdmin: any,
  orgId: string,
  propertyId: string,
  scopeType: unknown,
  scopeId: unknown,
): Promise<{ scope_type: PoolScopeType; scope_id: string | null; property_id: string }> {
  if (scopeType === "custom") {
    if (!propertyId || typeof propertyId !== "string") {
      throw new Error("property_id is required to resolve a custom-scope pool");
    }
    const { data: property, error } = await supabaseAdmin
      .from("properties")
      .select("id")
      .eq("id", propertyId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) throw new Error(`Property lookup failed while validating pool scope: ${error.message}`);
    if (!property) throw new Error(`Invalid scope: property ${propertyId} was not found in organization ${orgId}`);
    return { scope_type: "custom", scope_id: typeof scopeId === "string" ? scopeId : null, property_id: propertyId };
  }

  if (scopeType !== "property" && scopeType !== "building") {
    throw new Error(`Invalid pool scope_type "${scopeType}" — must be "property", "building", or "custom"`);
  }

  const resolved = await assertValidScopeHierarchy(supabaseAdmin, orgId, propertyId, scopeType, scopeId);
  return { scope_type: resolved.scope_level as PoolScopeType, scope_id: resolved.scope_id, property_id: resolved.property_id };
}

export { isValidScopeLevel };
