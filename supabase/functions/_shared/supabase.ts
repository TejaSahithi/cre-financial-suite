import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

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
    .select('org_id')
    .eq('user_id', userId)
    .limit(1);

  if (!error && memberships && memberships.length > 0) {
    return memberships[0].org_id;
  }

  const { data: org, error: orgError } = await supabaseAdmin
    .from('organizations')
    .select('id')
    .limit(1)
    .maybeSingle();

  if (orgError || !org?.id) {
    throw new Error('User has no organization membership');
  }

  return org.id;
}
