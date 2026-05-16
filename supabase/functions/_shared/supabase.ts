// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

/**
 * Creates a Supabase admin client with service role key
 */
export function createAdminClient() {
  return createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

function extractBearerToken(req: Request): string | null {
  const headerSources = ["x-user-jwt", "x-supabase-auth", "Authorization"] as const;
  for (const name of headerSources) {
    const value = req.headers.get(name);
    if (value) {
      return value.replace(/^Bearer\s+/i, "").trim();
    }
  }
  return null;
}

function isInternalServiceRequest(req?: Request): boolean {
  if (!req) return false;
  const internalKey = req.headers.get("x-internal-service-key");
  return Boolean(
    internalKey &&
      SUPABASE_SERVICE_ROLE_KEY &&
      internalKey.trim() === SUPABASE_SERVICE_ROLE_KEY,
  );
}

/**
 * Verifies the user from the Authorization header
 * Returns the authenticated user or throws an error
 */
export async function verifyUser(req: Request) {
  if (isInternalServiceRequest(req)) {
    const supabaseAdmin = createAdminClient();
    return {
      user: {
        id: "internal-compute",
        email: "internal-compute@system.local",
      },
      supabaseAdmin,
      isInternal: true,
    };
  }

  const headerSources = ["x-user-jwt", "x-supabase-auth", "Authorization"] as const;
  let authHeader: string | null = null;
  let usedHeader = "";

  for (const name of headerSources) {
    const value = req.headers.get(name);
    if (value) {
      authHeader = value;
      usedHeader = name;
      break;
    }
  }

  if (!authHeader) {
    console.error("[verifyUser] No auth header found. Checked:", headerSources.join(", "));
    throw new Error("Missing Authorization header");
  }

  const token = authHeader.replace(/^Bearer\s+/i, '');
  const supabaseAdmin = createAdminClient();

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) {
    console.error("[verifyUser] Auth failed via", usedHeader, ":", authError?.message);
    throw new Error(`Unauthorized: ${authError?.message || "Invalid token"}`);
  }

  console.log("[verifyUser] Authenticated", user.email ?? user.id, "via", usedHeader);
  return { user, supabaseAdmin };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractActingOrgId(req?: Request): string | null {
  if (!req) return null;
  const raw = req.headers.get('x-acting-org-id');
  if (!raw) return null;
  const trimmed = raw.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

function extractInternalOrgId(req?: Request): string | null {
  if (!req || !isInternalServiceRequest(req)) return null;
  const raw = req.headers.get("x-internal-org-id");
  if (!raw) return null;
  const trimmed = raw.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

function createUserScopedClient(req: Request) {
  const token = extractBearerToken(req);
  if (!token) {
    throw new Error("Missing Authorization header");
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Missing Supabase anon configuration");
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}

/**
 * Resolve the org_id to use for the current request.
 *
 * Resolution order (strictest first):
 *   1. The first membership row with a real org_id.
 *   2. (Super-admin only) an explicit `x-acting-org-id` header naming a real org.
 *   3. Otherwise THROW.
 *
 * Security note (audit finding S2):
 *   The previous implementation silently fell back to "the first organization
 *   in the system" when a super-admin had no membership with an org_id. That
 *   caused compute / store / export operations to run against an arbitrary
 *   tenant. Do not reintroduce an implicit fallback — super-admins that need
 *   cross-tenant access must name the tenant via the `x-acting-org-id` header
 *   (which is audited at the edge).
 */
export async function getUserOrgId(
  userId: string,
  supabaseAdmin: any,
  req?: Request,
): Promise<string> {
  const internalOrgId = extractInternalOrgId(req);
  if (internalOrgId) {
    return internalOrgId;
  }

  const { data: memberships, error } = await supabaseAdmin
    .from('memberships')
    .select('org_id, role, status')
    .eq('user_id', userId);

  if (error) {
    throw new Error(`Failed to resolve memberships: ${error.message}`);
  }

  const rows = Array.isArray(memberships) ? memberships : [];
  const isSuperAdmin = rows.some((m: any) => m.role === 'super_admin');
  const actingOrgId = extractActingOrgId(req);
  const activeMemberships = rows.filter((m: any) => {
    const status = m?.status ?? 'active';
    return m?.org_id != null && ['active', 'owner'].includes(status);
  });
  const activeOrgIds = [...new Set(activeMemberships.map((m: any) => m.org_id as string))];

  if (isSuperAdmin) {
    if (!actingOrgId) {
      throw new Error(
        'Super-admin request is missing the `x-acting-org-id` header. ' +
        'Cross-tenant operations must name the target organization explicitly.'
      );
    }

    const { data: org, error: orgError } = await supabaseAdmin
      .from('organizations')
      .select('id')
      .eq('id', actingOrgId)
      .maybeSingle();

    if (orgError || !org?.id) {
      throw new Error(`Organization ${actingOrgId} (from x-acting-org-id) not found`);
    }

    console.log('[getUserOrgId] Super-admin acting on org:', org.id, 'user:', userId);
    return org.id as string;
  }

  if (actingOrgId) {
    const matchingMembership = activeMemberships.find((m: any) => m.org_id === actingOrgId);
    if (!matchingMembership) {
      throw new Error('Requested acting organization is not available to this user');
    }
    return actingOrgId;
  }

  if (activeOrgIds.length === 1) {
    return activeOrgIds[0];
  }

  if (activeOrgIds.length > 1) {
    throw new Error(
      'User belongs to multiple organizations. Provide `x-acting-org-id` to select the target organization explicitly.'
    );
  }

  throw new Error('User has no active organization membership');
}

export async function assertPageAccess(
  req: Request,
  orgId: string,
  pageNames: string[],
  access: "read" | "write" = "write",
): Promise<void> {
  if (isInternalServiceRequest(req) || !Array.isArray(pageNames) || pageNames.length === 0) {
    return;
  }

  const scopedClient = createUserScopedClient(req);
  let allowed = false;

  const shouldFallbackToPerPageChecks = (error: any) => {
    const text = [error?.message, error?.details, error?.hint].filter(Boolean).join(" ").toLowerCase();
    return text.includes("can_write_any_page") &&
      (text.includes("could not find") || text.includes("does not exist") || text.includes("function") || text.includes("no function matches"));
  };

  if (access === "write") {
    if (pageNames.length > 1) {
      const { data, error } = await scopedClient.rpc("can_write_any_page", {
        check_org_id: orgId,
        page_names: pageNames,
      });
      if (error) {
        if (!shouldFallbackToPerPageChecks(error)) {
          throw new Error(`Permission check failed: ${error.message}`);
        }
        const checks = await Promise.all(
          pageNames.map(async (pageName) => {
            const single = await scopedClient.rpc("can_write_page", {
              check_org_id: orgId,
              page_name: pageName,
            });
            if (single.error) throw single.error;
            return Boolean(single.data);
          }),
        );
        allowed = checks.some(Boolean);
      } else {
        allowed = Boolean(data);
      }
    } else {
      const { data, error } = await scopedClient.rpc("can_write_page", {
        check_org_id: orgId,
        page_name: pageNames[0],
      });
      if (error) throw new Error(`Permission check failed: ${error.message}`);
      allowed = Boolean(data);
    }
  } else {
    const checks = await Promise.all(
      pageNames.map(async (pageName) => {
        const { data, error } = await scopedClient.rpc("can_read_page", {
          check_org_id: orgId,
          page_name: pageName,
        });
        if (error) throw error;
        return Boolean(data);
      }),
    );
    allowed = checks.some(Boolean);
  }

  if (!allowed) {
    throw new Error(`Access denied for ${access} on ${pageNames.join(", ")}`);
  }
}

export async function assertPropertyAccess(req: Request, propertyId?: string | null): Promise<void> {
  if (isInternalServiceRequest(req) || !propertyId) {
    return;
  }

  const scopedClient = createUserScopedClient(req);
  const { data, error } = await scopedClient.rpc("can_access_property", {
    p_property_id: propertyId,
  });
  if (error) {
    throw new Error(`Property access check failed: ${error.message}`);
  }
  if (!data) {
    throw new Error("Access denied for the requested property");
  }
}
