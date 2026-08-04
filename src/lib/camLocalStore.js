/**
 * Local Fallback Store for CAM Domain objects.
 *
 * Provides instant in-memory & localStorage fallback for CAM domain tables
 * (recovery_calendars, recovery_periods, recovery_pools, recovery_pool_lease_participants,
 * cam_estimate_schedules, cam_runs, cam_run_lease_results) when running against a remote
 * Supabase instance where database migrations have not yet been applied.
 */

const STORAGE_KEY = "cre_cam_local_store_v1";

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { calendars: [], periods: [], pools: [], poolCategories: [], participants: [], estimates: [], runs: [], leaseResults: [] };
    return JSON.parse(raw);
  } catch {
    return { calendars: [], periods: [], pools: [], poolCategories: [], participants: [], estimates: [], runs: [], leaseResults: [] };
  }
}

function saveStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Memory fallback if localStorage unavailable
  }
}

export const camLocalStore = {
  getCalendars(propertyId) {
    const store = loadStore();
    return store.calendars.filter((c) => !propertyId || c.property_id === propertyId);
  },
  addCalendar(payload) {
    const store = loadStore();
    const newCal = {
      id: `local-cal-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      property_id: payload.property_id,
      name: payload.name,
      calendar_type: payload.calendar_type || "calendar_year",
      fiscal_start_month: payload.fiscal_start_month || 1,
      created_at: new Date().toISOString(),
    };
    store.calendars.push(newCal);
    saveStore(store);
    return newCal;
  },

  getPeriods(calendarIds = []) {
    const store = loadStore();
    if (!calendarIds || calendarIds.length === 0) return store.periods;
    return store.periods.filter((p) => calendarIds.includes(p.calendar_id));
  },
  addPeriod(payload) {
    const store = loadStore();
    const newPeriod = {
      id: `local-per-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      calendar_id: payload.calendar_id,
      name: payload.name,
      start_date: payload.start_date,
      end_date: payload.end_date,
      created_at: new Date().toISOString(),
    };
    store.periods.push(newPeriod);
    saveStore(store);
    return newPeriod;
  },

  getPools(propertyId, periodId) {
    const store = loadStore();
    return store.pools.filter((p) => {
      if (periodId && p.period_id === periodId) return true;
      if (propertyId && p.property_id === propertyId) return true;
      return false;
    });
  },
  addPool(payload) {
    const store = loadStore();
    const newPool = {
      id: `local-pool-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      property_id: payload.property_id,
      period_id: payload.period_id || null,
      name: payload.name,
      pool_type: payload.pool_type || "property",
      scope_type: payload.scope_type || "property",
      default_gross_up_target_pct: 95,
      recovery_pool_categories: [],
      recovery_pool_scope_members: [],
      created_at: new Date().toISOString(),
    };
    store.pools.push(newPool);
    saveStore(store);
    return newPool;
  },

  getParticipants(poolId) {
    const store = loadStore();
    return store.participants.filter((pt) => pt.pool_id === poolId || pt.recovery_pool_id === poolId);
  },
  addParticipant(payload) {
    const store = loadStore();
    const newPt = {
      id: `local-pt-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      pool_id: payload.pool_id,
      recovery_pool_id: payload.pool_id,
      lease_id: payload.lease_id,
      status: "active",
      leases: { tenant_name: payload.tenant_name || "Active Tenant" },
      created_at: new Date().toISOString(),
    };
    store.participants.push(newPt);
    saveStore(store);
    return newPt;
  },

  getEstimateSchedules(periodId) {
    const store = loadStore();
    return store.estimates.filter((e) => !periodId || e.recovery_period_id === periodId);
  },
  addEstimate(payload) {
    const store = loadStore();
    const newEst = {
      id: `local-est-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      lease_id: payload.lease_id,
      recovery_period_id: payload.recovery_period_id,
      month: payload.month,
      month_date: payload.month,
      amount: Number(payload.amount || 0),
      leases: { tenant_name: payload.tenant_name || "Active Tenant" },
      created_at: new Date().toISOString(),
    };
    store.estimates.push(newEst);
    saveStore(store);
    return newEst;
  },

  getRuns(propertyId, periodId) {
    const store = loadStore();
    return store.runs.filter((r) => {
      if (periodId && r.recovery_period_id === periodId) return true;
      if (propertyId && (r.scope_id === propertyId || r.property_id === propertyId)) return true;
      return true;
    });
  },
  addRun(payload) {
    const store = loadStore();
    const newRun = {
      id: `local-run-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      scope_type: "property",
      scope_id: payload.property_id,
      property_id: payload.property_id,
      recovery_period_id: payload.recovery_period_id,
      run_mode: payload.run_mode || "posting_eligible",
      status: "calculated",
      created_at: new Date().toISOString(),
    };
    store.runs.push(newRun);
    saveStore(store);
    return newRun;
  },
};
