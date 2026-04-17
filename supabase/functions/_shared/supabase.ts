import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

/**
 * Creates a Supabase admin client with service role key
 */
export function createAdminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

/**
 * Verifies the user from the Authorization header
 * Returns the authenticated user or throws an error
 */
export async function verifyUser(req: Request) {
  const headerSources = ['x-user-jwt', 'x-supabase-auth', 'Authorization'] as const;
  let authHeader: string | null = null;
  let usedHeader = '';

  for (const name of headerSources) {
    const value = req.headers.get(name);
    if (value) {
      authHeader = value;
      usedHeader = name;
      break;
    }
  }

  if (!authHeader) {
    console.error("[verifyUser] No auth header found. Checked:", headerSources.join(', '));
    throw new Error('Missing Authorization header');
  }

  const token = authHeader.replace(/^Bearer\s+/i, '');
  const supabaseAdmin = createAdminClient();

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) {
    console.error("[verifyUser] Auth failed via", usedHeader, ":", authError?.message);
    throw new Error(`Unauthorized: ${authError?.message || 'Invalid token'}`);
  }

  console.log("[verifyUser] Authenticated", user.email ?? user.id, "via", usedHeader);
  return { user, supabaseAdmin };
}

/**
 * Gets the org_id for the authenticated user
 */
export async function getUserOrgId(userId: string, supabaseAdmin: any): Promise<string> {
  const { data: memberships, error } = await supabaseAdmin
    .from('memberships')
    .select('org_id, role')
    .eq('user_id', userId);

  if (!error && memberships && memberships.length > 0) {
    // Super admins may have a membership with org_id = NULL.
    // Try to find a membership with a real org_id first.
    const withOrg = memberships.find((m: any) => m.org_id != null);
    if (withOrg) return withOrg.org_id;

    // Super admin with no org_id — fall through to pick the first org in the system.
    const isSuperAdmin = memberships.some((m: any) => m.role === 'super_admin');
    if (!isSuperAdmin) {
      throw new Error('User membership has no organization');
    }
  }

  // Fallback: pick the first organization (for super admins or users with no membership)
  const { data: org, error: orgError } = await supabaseAdmin
    .from('organizations')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (orgError || !org?.id) {
    throw new Error('User has no organization membership');
  }

  console.log("[getUserOrgId] Resolved org_id via fallback:", org.id, "for user:", userId);
  return org.id;
}
