import { supabase } from "@/services/supabaseClient";

function buildGatewayCompatibleHeaders(userJwt) {
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!anonKey) {
    throw new Error("Missing Supabase anon key");
  }

  return {
    // Keep the gateway happy with the project key while passing the real user
    // session separately for manual verification inside the function.
    Authorization: `Bearer ${anonKey}`,
    apikey: anonKey,
    "x-user-jwt": userJwt,
  };
}

async function getAuthenticatedHeaders() {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error("Not authenticated");
  }

  return buildGatewayCompatibleHeaders(session.access_token);
}

function isAuthError(error) {
  return /401|unauthorized|jwt/i.test(error?.message || "");
}

export async function invokeEdgeFunction(fnName, body) {
  const attemptInvoke = async () => {
    const headers = await getAuthenticatedHeaders();
    return supabase.functions.invoke(fnName, { body, headers });
  };

  let result = await attemptInvoke();

  if (result.error && isAuthError(result.error)) {
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshData?.session?.access_token) {
      throw result.error;
    }
    result = await attemptInvoke();
  }

  if (result.error) {
    const ctx = result.error?.context;
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
    throw result.error;
  }

  if (result.data?.error === true) {
    throw new Error(result.data.message || "Function returned an error");
  }

  return result.data || {};
}
