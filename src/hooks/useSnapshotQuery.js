/**
 * useSnapshotQuery
 *
 * Shared hook for reading from computation_snapshots.
 * All dashboard pages use this — no frontend calculations allowed.
 *
 * Usage:
 *   const { snapshot, outputs, isLoading, refetch } = useSnapshotQuery({
 *     engineType: "lease",
 *     propertyId: selectedPropertyId,
 *     fiscalYear: 2026,
 *   });
 *
 * Returns:
 *   snapshot  — the full snapshot row (id, computed_at, status, etc.)
 *   outputs   — snapshot.outputs (the computed data object)
 *   isLoading — true while fetching
 *   isFetching — true on background refetch
 *   refetch   — manually re-fetch
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";

async function fetchSnapshot({ engineType, propertyId, fiscalYear }) {
  if (!supabase) return null;

  let query = supabase
    .from("computation_snapshots")
    .select("*")
    .eq("engine_type", engineType)
    .eq("status", "completed")
    .order("computed_at", { ascending: false })
    .limit(1);

  if (fiscalYear) query = query.eq("fiscal_year", fiscalYear);

  if (propertyId && propertyId !== "all" && propertyId !== "") {
    query = query.eq("property_id", propertyId);
  }

  const { data, error } = await query;
  if (error) {
    console.error(`[useSnapshotQuery] ${engineType} fetch error:`, error.message);
    return null;
  }
  return data?.[0] ?? null;
}

export function useSnapshotQuery({ engineType, propertyId, fiscalYear, autoRefreshMs = 0 }) {
  const queryKey = ["snapshot", engineType, propertyId ?? "all", fiscalYear ?? "any"];

  const { data: snapshot, isLoading, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: () => fetchSnapshot({ engineType, propertyId, fiscalYear }),
    // Auto-refresh if no snapshot yet (compute may still be running)
    refetchInterval: (data) => {
      if (autoRefreshMs > 0) return autoRefreshMs;
      return data ? false : 5000;
    },
    staleTime: 30_000, // treat snapshot as fresh for 30s
  });

  return {
    snapshot,
    outputs: snapshot?.outputs ?? null,
    computedAt: snapshot?.computed_at ?? null,
    isLoading,
    isFetching,
    refetch,
    hasSnapshot: !!snapshot,
  };
}
