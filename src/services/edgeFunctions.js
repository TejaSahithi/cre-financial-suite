import { supabase } from "@/services/supabaseClient";
import { resolveWritableOrgId } from "@/lib/orgUtils";

export async function getFreshAccessToken() {
  // Refresh the session so the edge function never receives an expired JWT.
  // supabase.functions.invoke reads the token from the client's internal state,
  // but that state can go stale if the tab was idle.
  const { data: refreshData, error: refreshErr } = await supabase.auth.refreshSession();
  if (refreshErr) {
    console.warn("[invokeEdgeFunction] session refresh failed:", refreshErr.message);
  }

  // Explicitly pass the access token so the invocation uses the refreshed JWT
  // even if the client's internal state hasn't propagated yet.
  let accessToken = refreshData?.session?.access_token;
  if (!accessToken) {
    const { data: sessionData } = await supabase.auth.getSession();
    accessToken = sessionData?.session?.access_token;
  }

  if (!accessToken) {
    throw new Error("Missing Supabase session. Please refresh and sign in again.");
  }

  return accessToken;
}

export async function invokeEdgeFunction(fnName, body) {
  const accessToken = await getFreshAccessToken();
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};

  // Super-admin edge functions that operate across org data now require an
  // explicit acting org header instead of silently resolving to an arbitrary
  // tenant. If we have an active org context (membership or app_metadata),
  // forward it; otherwise the function will fail loudly and ask the caller to
  // pick an organization first.
  const actingOrgId = await resolveWritableOrgId(null);
  if (actingOrgId) {
    headers["x-acting-org-id"] = actingOrgId;
  }

  const { data, error } = await supabase.functions.invoke(fnName, { body, headers });

  if (error) {
    const ctx = error?.context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const payload = await ctx.json();
        if (payload?.message) {
          throw new Error(payload.message);
        }
        if (payload?.error) {
          throw new Error(payload.error);
        }
      } catch (parseError) {
        if (parseError instanceof Error && parseError.message) {
          throw parseError;
        }
      }
    }
    throw error;
  }

  if (data?.error === true) {
    throw new Error(data.message || "Function returned an error");
  }

  return data || {};
}

export async function invokeEdgeFunctionFormData(fnName, formData) {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const accessToken = await getFreshAccessToken();

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing Supabase configuration. Please check environment variables.");
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/${fnName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: supabaseAnonKey,
    },
    body: formData,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    throw new Error(payload?.message || payload?.error || `${fnName} failed with HTTP ${response.status}`);
  }

  return payload;
}
