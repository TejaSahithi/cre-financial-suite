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

import { invokeEdgeFunction } from "@/services/edgeFunctions";

export function useComputeTrigger() {
  const [isTriggering, setIsTriggering] = useState(false);

  const trigger = useCallback(async (functionName, body, opts = {}) => {
    const { silent = false, successMessage } = opts;
    setIsTriggering(true);

    try {
      // Ensure we have a fresh session/JWT before invoking
      const { supabase } = await import("@/services/supabaseClient");
      if (supabase) {
        await supabase.auth.getSession();
      }

      const data = await invokeEdgeFunction(functionName, body);

      if (!silent) {
        toast.success(successMessage ?? "Computation started - dashboard will update shortly");
      }

      return data;
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
