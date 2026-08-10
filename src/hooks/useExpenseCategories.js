import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";
import useOrgId from "./useOrgId";

/**
 * expense_categories rows are org-specific OR global (org_id IS NULL, seeded
 * defaults shared by every org). useOrgQuery's plain `.eq('org_id', orgId)`
 * filter silently drops the global rows, which breaks lookups for any
 * expense resolved against a global category (resolve_actual_expense_category_id
 * and friends already treat org_id IS NULL as valid). Mirrors the
 * `.or('org_id.eq.X,org_id.is.null')` pattern already used in
 * leaseExpenseRuleService.js.
 */
export default function useExpenseCategories() {
  const { orgId, loading: orgLoading } = useOrgId();

  return useQuery({
    queryKey: ["ExpenseCategory", orgId, "org-or-global"],
    queryFn: async () => {
      if (orgId === "__none__") return [];
      let query = supabase.from("expense_categories").select("*").order("display_order", { ascending: true });
      if (orgId) query = query.or(`org_id.eq.${orgId},org_id.is.null`);
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    enabled: !orgLoading,
    initialData: [],
  });
}
