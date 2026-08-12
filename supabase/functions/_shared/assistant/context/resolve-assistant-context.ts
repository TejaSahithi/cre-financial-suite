// @ts-nocheck
/**
 * resolve-assistant-context.ts — the Assistant's Access Envelope (section 14).
 *
 * Deliberately thin: it does NOT reimplement authentication or organization
 * resolution. It calls straight into the repo's existing, audited primitives
 * (`_shared/supabase.ts`) so the Assistant is bound by the exact same
 * tenant-isolation guarantees as every other edge function — in particular
 * getUserOrgId() never trusts a client-provided org id and never falls back
 * to "the first organization" for a super-admin (see its own header comment,
 * S2 audit finding). This module exists only to give the Assistant a single,
 * named envelope object instead of re-destructuring verifyUser()/
 * getUserOrgId() at every call site.
 */
import { getUserOrgId, verifyUser } from "../../supabase.ts";

export interface AssistantAccessEnvelope {
  req: Request;
  userId: string;
  userEmail: string | null;
  orgId: string;
  supabaseAdmin: any;
}

/** Throws on missing/invalid auth or unresolved organization — callers must
 * let this propagate to a 401/403, never swallow it and proceed unscoped. */
export async function resolveAssistantContext(req: Request): Promise<AssistantAccessEnvelope> {
  const { user, supabaseAdmin } = await verifyUser(req);
  const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

  return {
    req,
    userId: user.id,
    userEmail: user.email ?? null,
    orgId,
    supabaseAdmin,
  };
}
