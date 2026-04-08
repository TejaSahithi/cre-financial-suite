/**
 * useComputeTrigger
 *
 * Shared hook for triggering compute-* Edge Functions from the frontend.
 * Used after any lease/expense/budget edit to refresh computation snapshots.
 *
 * Usage:
 *   const { trigger, isTriggering } = useComputeTrigger();
 *   await trigger("compute-lease", { property_id: id, fiscal_year: 2026 });
 */

import { useCallback, useState } from "react";
import { toast } from "sonner";

import { supabase } from "@/services/supabaseClient";

export function useComputeTrigger() {
  const [isTriggering, setIsTriggering] = useState(false);

  const trigger = useCallback(async (functionName, body, opts = {}) => {
    const { silent = false, successMessage } = opts;
    setIsTriggering(true);

    try {
      const attemptInvoke = async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session?.access_token) {
          throw new Error("Not authenticated");
        }

        return supabase.functions.invoke(functionName, {
          body,
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });
      };

      let result = await attemptInvoke();
      const needsRetry = result.error && /401|unauthorized|jwt/i.test(result.error.message || "");

      if (needsRetry) {
        const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
        if (refreshError || !refreshData?.session?.access_token) {
          throw result.error;
        }
        result = await attemptInvoke();
      }

      if (result.error) {
        throw result.error;
      }

      if (!silent) {
        toast.success(successMessage ?? "Computation started - dashboard will update shortly");
      }

      return result.data || {};
    } catch (error) {
      console.error(`[useComputeTrigger] ${functionName} error:`, error?.message || error);
      if (!silent) {
        toast.error(`Compute failed: ${error?.message || "Unexpected error"}`);
      }
      throw error;
    } finally {
      setIsTriggering(false);
    }
  }, []);

  return { trigger, isTriggering };
}
