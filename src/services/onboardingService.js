import { invokeEdgeFunction } from "@/services/edgeFunctions";

export async function ensureOnboardingOrganization() {
  try {
    return await invokeEdgeFunction("first-login", {});
  } catch (error) {
    const message = error?.message || "Failed to initialize onboarding organization";
    if (/onboarding-ready state/i.test(message)) {
      throw new Error("Your account is not approved for organization setup yet. Please check that this email was approved for onboarding.");
    }
    if (/Only owners trigger standard first-login/i.test(message)) {
      throw new Error("This account is not marked as an organization owner, so it cannot create a new organization.");
    }
    if (/Profile not found/i.test(message)) {
      throw new Error("Your account profile is still being provisioned. Please wait a moment and try again.");
    }
    throw error instanceof Error ? error : new Error(message);
  }
}
