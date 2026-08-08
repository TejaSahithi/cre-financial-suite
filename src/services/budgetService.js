import { createEntityService } from '@/services/api';

// Read-only in practice: RLS blocks all direct client writes to `budgets`
// (WITH CHECK(false) — see 20260707000000_budgets_rls_lockdown.sql), so
// every write goes through the compute-budget edge function instead. This
// only exists for the `.list()`/`.filter()` reads used by dashboard widgets.
export const budgetService = createEntityService('Budget');

export default budgetService;
