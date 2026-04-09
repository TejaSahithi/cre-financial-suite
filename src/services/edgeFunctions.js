import { supabase } from "@/services/supabaseClient";

export async function invokeEdgeFunction(fnName, body) {
  // Refresh the session so the edge function never receives an expired JWT.
  // supabase.functions.invoke reads the token from the client's internal state,
  // but that state can go stale if the tab was idle.
  const { data: refreshData, error: refreshErr } = await supabase.auth.refreshSession();
  if (refreshErr) {
    console.warn("[invokeEdgeFunction] session refresh failed:", refreshErr.message);
  }

  // Explicitly pass the access token so the invocation uses the refreshed JWT
  // even if the client's internal state hasn't propagated yet.
  const accessToken = refreshData?.session?.access_token;
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};

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
