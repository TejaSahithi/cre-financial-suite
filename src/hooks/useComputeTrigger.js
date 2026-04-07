/**
 * useComputeTrigger
 *
 * Shared hook for triggering compute-* Edge Functions from the frontend.
 * Used after any lease/expense/budget edit to refresh computation_snapshots.
 *
 * Usage:
 *   const { trigger, isTriggering } = useComputeTrigger();
 *   await trigger("compute-lease", { property_id: id, fiscal_year: 2026 });
 */

import { useState, useCallback } from "react";
import { supabase } from "@/services/supabaseClient";
import { toast } from "sonner";

export function useComputeTrigger() {
  const [isTriggering, setIsTriggering] = useState(false);

  const trigger = useCallback(async (functionName, body, opts = {}) => {
    const { silent = false, successMessage } = opts;
    setIsTriggering(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error("Not authenticated");
      }

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const res = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
          "apikey": import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "unknown error");
        throw new Error(`${functionName} failed: ${res.status} ${errText.slice(0, 100)}`);
      }

      if (!silent) {
        toast.success(successMessage ?? "Computation started — dashboard will update shortly");
      }

      return await res.json().catch(() => ({}));
    } catch (err) {
      console.error(`[useComputeTrigger] ${functionName} error:`, err.message);
      if (!silent) {
        toast.error(`Compute failed: ${err.message}`);
      }
      throw err;
    } finally {
      setIsTriggering(false);
    }
  }, []);

  return { trigger, isTriggering };
}
