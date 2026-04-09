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

function scopeMatches(snapshot, scopeLevel, scopeId) {
  const inputScopeLevel = snapshot?.inputs?.scope_level ?? snapshot?.outputs?.scope_level ?? "property";
  const inputScopeId = snapshot?.inputs?.scope_id ?? snapshot?.outputs?.scope_id ?? snapshot?.property_id ?? null;
  if (!scopeLevel || scopeLevel === "property") {
    return inputScopeLevel === "property" || inputScopeId === snapshot?.property_id;
  }
  return inputScopeLevel === scopeLevel && inputScopeId === scopeId;
}

async function fetchSnapshot({ engineType, propertyId, fiscalYear, scopeLevel, scopeId }) {
  if (!supabase) return null;

  let query = supabase
    .from("computation_snapshots")
    .select("*")
    .eq("engine_type", engineType)
    .eq("status", "completed")
    .order("computed_at", { ascending: false })
    .limit(scopeLevel && scopeLevel !== "property" ? 20 : 5);

  if (fiscalYear) query = query.eq("fiscal_year", fiscalYear);

  if (propertyId && propertyId !== "all" && propertyId !== "") {
    query = query.eq("property_id", propertyId);
  }

  const { data, error } = await query;
  if (error) {
    console.error(`[useSnapshotQuery] ${engineType} fetch error:`, error.message);
    return null;
  }

  const rows = data ?? [];
  if (!rows.length) return null;

  return rows.find((row) => scopeMatches(row, scopeLevel, scopeId)) ?? null;
}

export function useSnapshotQuery({
  engineType,
  propertyId,
  fiscalYear,
  scopeLevel,
  scopeId,
  autoRefreshMs = 0,
}) {
  const queryKey = [
    "snapshot",
    engineType,
    propertyId ?? "all",
    fiscalYear ?? "any",
    scopeLevel ?? "property",
    scopeId ?? "all",
  ];

  const { data: snapshot, isLoading, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: () => fetchSnapshot({ engineType, propertyId, fiscalYear, scopeLevel, scopeId }),
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
