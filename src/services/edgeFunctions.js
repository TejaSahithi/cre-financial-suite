import { supabase } from "@/services/supabaseClient";
import { getStoredActingOrgId } from "@/lib/actingOrg";
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

async function getActingOrgHeaders() {
  const actingOrgId = getStoredActingOrgId() || await resolveWritableOrgId(null);
  return actingOrgId ? { "x-acting-org-id": actingOrgId } : {};
}

export async function invokeEdgeFunction(fnName, body, customHeaders = {}, uiContext = null) {
  const accessToken = await getFreshAccessToken();
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};

  // Super-admin edge functions that operate across org data now require an
  // explicit acting org header instead of silently resolving to an arbitrary
  // tenant. If we have an active org context (membership or app_metadata),
  // forward it; otherwise the function will fail loudly and ask the caller to
  // pick an organization first.
  Object.assign(headers, await getActingOrgHeaders(), customHeaders);

  // Optional: tag the request with which page/action triggered it, so
  // server-side pipeline_logs rows can record not just what happened but
  // what UI action caused it. Purely additive — omitted entirely when the
  // caller doesn't pass uiContext, so every other call site is unaffected.
  const requestBody = uiContext ? { ...body, _uiContext: uiContext } : body;

  const { data, error } = await supabase.functions.invoke(fnName, { body: requestBody, headers });

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

export async function invokeEdgeFunctionFormData(fnName, formData, customHeaders = {}, uiContext = null) {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const accessToken = await getFreshAccessToken();

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing Supabase configuration. Please check environment variables.");
  }

  const actingOrgHeaders = await getActingOrgHeaders();

  // See invokeEdgeFunction's matching comment — same optional UI-action tag,
  // just carried as a form field since this path sends multipart bodies.
  if (uiContext) {
    formData.set("_uiContext", JSON.stringify(uiContext));
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/${fnName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: supabaseAnonKey,
      ...actingOrgHeaders,
      ...customHeaders,
    },
    body: formData,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    throw new Error(payload?.message || payload?.error || `${fnName} failed with HTTP ${response.status}`);
  }

  return payload;
}
