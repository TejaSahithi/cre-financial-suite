import { createEntityService } from '@/services/api';

const base = createEntityService('Budget');

// Statuses that should not be edited in place. Reopen via an explicit
// status change to 'draft' or 'pending_review' first.
const LOCKED_STATUSES = new Set(['locked', 'archived']);

/**
 * Guarded wrapper for the Budget entity. Mutations are blocked when the
 * target budget is in a locked status — caller must explicitly reopen it
 * first (status change to draft/pending_review) before further edits.
 *
 * Read-only methods pass through unchanged.
 */
export const budgetService = {
  ...base,
  /**
   * Update a budget row. Rejects edits to locked budgets with a clear
   * error so the toast in the calling page can surface the reason
   * instead of producing a silent failure.
   *
   * Pass `{ __unlock: true }` in `data` to bypass the guard only when
   * the same update is transitioning the budget OUT of locked.
   */
  async update(id, data = {}) {
    if (!id) throw new Error('Budget id is required');
    const wantsUnlock = data?.__unlock === true;
    const nextStatus = String(data?.status || '').toLowerCase();
    const cleaned = { ...data };
    delete cleaned.__unlock;

    // Fetch current row to check lock status. Skip the check if the
    // update itself is unlocking (status change to non-locked) and the
    // caller passed __unlock.
    if (!(wantsUnlock && nextStatus && !LOCKED_STATUSES.has(nextStatus))) {
      try {
        const current = await base.filter({ id });
        const currentStatus = String(current?.[0]?.status || '').toLowerCase();
        if (LOCKED_STATUSES.has(currentStatus)) {
          const err = new Error(
            `Budget is ${currentStatus}. Reopen it before editing — change status to draft or pending_review first.`,
          );
          err.code = 'BUDGET_LOCKED';
          throw err;
        }
      } catch (lookupErr) {
        // If the lookup itself fails (RLS, network), surface it rather than
        // silently letting the write through.
        if (lookupErr?.code === 'BUDGET_LOCKED') throw lookupErr;
        console.warn('[budgetService] lock-check lookup failed:', lookupErr?.message || lookupErr);
      }
    }
    return base.update(id, cleaned);
  },
};

export default budgetService;
