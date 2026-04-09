import { supabase } from "@/services/supabaseClient";

export async function invokeEdgeFunction(fnName, body) {
  const { data, error } = await supabase.functions.invoke(fnName, { body });

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
