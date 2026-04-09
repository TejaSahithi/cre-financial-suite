import { supabase } from "@/services/supabaseClient";

async function getAccessToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data?.session?.access_token || null;
}

export async function ensureOnboardingOrganization() {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    throw new Error("Your session is not ready yet. Please refresh and try onboarding again.");
  }

  const { data, error } = await supabase.functions.invoke("first-login", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (error || data?.error) {
    throw new Error(error?.message || data?.error || "Failed to initialize onboarding organization");
  }

  return data;
}

