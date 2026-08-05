// CAM Enhancement and Budget Readiness Specification v2.0 — LOCAL full-flow
// verification and manual financial tie-out, against the real local database.
//
// Chain exercised end to end:
//   lease rule -> materialized policy -> recovery pool -> participant ->
//   published expense -> canonical category -> pool assignment -> readiness ->
//   CAM calculation -> lease result -> calculation lines
//
// ============================ FIXTURE =======================================
// Property "Meridian Center", FY2026 (2026-01-01..2026-12-31, 365 days).
//   Property rentable area ............ 100,000 RSF
//   Occupied area ......................  80,000 RSF  (80% occupancy)
//   Gross-up target (operating/utilities pools only) ......... 100%
//     -> gross-up factor 100/80 = 1.25 on the VARIABLE portion only.
//        Taxes and insurance are fixed and are never grossed up
//        (specification 6.6).
//
// Leases:
//   Lease A "Northwind" — TWO premises (multi-premises):
//       A1 10,000 RSF + A2 5,000 RSF = 15,000 RSF -> 15% share
//   Lease B "Contoso" — one premises 5,000 RSF -> 5% share
//
// Published expenses (6):
//   Operating   $100,000  variable    -> Operating pool
//   Taxes        $60,000  fixed       -> Taxes pool
//   Insurance    $20,000  fixed       -> Insurance pool
//   Utilities    $30,000  variable    -> Utilities pool
//   Capital      $50,000  fixed       -> assigned to Operating pool but the
//                                        pool EXCLUDES the Capital category,
//                                        so it is excluded from recovery.
//                                        (Pre-fix this exclude rule silently
//                                        never matched — see migration 039.)
//   Ambiguous     $7,500              -> label matches TWO categories, so
//                                        expense_category_id stays NULL. The
//                                        run is BLOCKED (readiness_failed)
//                                        until a human resolves it through
//                                        resolve_cam_input_category; it then
//                                        resolves to Variant A, which the
//                                        operating pool also excludes.
//
// ---------------------------- ADJUSTED POOLS --------------------------------
//   Operating : 100,000 variable x 1.25 = 125,000.00   (Capital 50,000 excluded)
//   Taxes     :  60,000 fixed           =  60,000.00
//   Insurance :  20,000 fixed           =  20,000.00
//   Utilities :  30,000 variable x 1.25 =  37,500.00
//
// ---------------------------- LEASE A (15%) ---------------------------------
//   Operating share      125,000 x 15%            = 18,750.00
//     - base year        100,000 x 15% = 15,000   =  3,750.00
//     - cap (fixed $3,675)                        =  3,675.00
//     + admin fee 10%    3,675 x 0.10 =   367.50  =  4,042.50
//   Taxes                 60,000 x 15%            =  9,000.00
//   Insurance             20,000 x 15%            =  3,000.00
//   Utilities             37,500 x 15%            =  5,625.00
//                                          TOTAL  = 21,667.50
//   Estimates billed     12 x 1,700.00            = 20,400.00
//                                     AMOUNT DUE  =  1,267.50
//
// ---------------------------- LEASE B (5%) ----------------------------------
//   Operating            125,000 x 5%             =  6,250.00
//   Taxes                 60,000 x 5%             =  3,000.00
//   Insurance             20,000 x 5%             =  1,000.00
//   Utilities             37,500 x 5%             =  1,875.00
//                                          TOTAL  = 12,125.00
//   Estimates billed     12 x 1,100.00            = 13,200.00
//                                        CREDIT   = -1,075.00
//
// ---------------------------- TIE-OUT ---------------------------------------
//   BEFORE resolution
//     Published total    100,000+60,000+20,000+30,000+50,000+7,500 = 267,500.00
//     Assigned total     (all but the unresolved ambiguous 7,500)  = 260,000.00
//     Unassigned         (ambiguous; blocks via EXPENSE_CATEGORY_MISSING,
//                         the run returns readiness_failed)         =   7,500.00
//   AFTER controlled resolution + assignment
//     Assigned total  = pool source total (actual + excluded)      = 267,500.00
//     Operating pool: actual 100,000.00 recoverable
//                     excluded 57,500.00 (Capital 50,000 + Variant A 7,500)
//
//   ENGINE vs ANALYTIC
//     Lease A  analytic 21,667.50   engine 21,667.50   (exact)
//     Lease B  analytic 12,125.00   engine 12,125.00   (exact)
//     The former +0.07 drift came from residual allocation running per
//     monthly segment and feeding ledger-rounded values back into the
//     base-year/cap/fee chain. Under the LEASE_POOL_PERIOD policy the engine
//     rounds once at the (lease, pool, period) boundary and uses
//     largest-remainder only to distribute that already-rounded total, so
//     the engine and the hand calculation now agree exactly.
// ============================================================================
import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";
import { prepareCamAutomatically } from "../_shared/cam-engine-v2/setup/prepare-cam-automatically.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}
function assertNoError(error: unknown) {
  if (error) throw new Error(JSON.stringify(error));
}
async function insertOne(client: ReturnType<typeof adminClient>, table: string, values: Record<string, unknown>) {
  const { data, error } = await client.from(table).insert(values).select("*").single();
  assertNoError(error);
  assertExists(data);
  return data;
}
async function callRpc(admin: ReturnType<typeof adminClient>, fn: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(fn, args);
  assertNoError(error);
  return data;
}
async function callEdge(fn: string, accessToken: string, body: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, apikey: ANON_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const money = (n: unknown) => Math.round(Number(n) * 100) / 100;

interface Fixture {
  admin: ReturnType<typeof adminClient>;
  orgId: string;
  propertyId: string;
  periodId: string;
  actorUserId: string;
  actorEmail: string;
  accessToken: string;
  leaseA: string;
  leaseB: string;
  pools: Record<string, string>;
  categories: Record<string, string>;
  ambiguousInputId: string;
  capitalInputId: string;
  ambigAId: string;
}

async function buildFixture(): Promise<Fixture> {
  const admin = adminClient();
  const suffix = crypto.randomUUID().slice(0, 8);

  // --- actor + org membership (needed for the edge function's auth) --------
  const email = `cam-flow-${suffix}@example.test`;
  const password = `Pass-${suffix}!`;
  const { data: userData, error: userErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assertNoError(userErr);
  const actorUserId = userData.user!.id;

  const org = await insertOne(admin, "organizations", { name: `Meridian Org ${suffix}`, status: "active" });
  await admin.from("profiles").upsert({ id: actorUserId, email, full_name: "CAM Flow Tester", role: "user", status: "active" });
  await insertOne(admin, "memberships", { user_id: actorUserId, org_id: org.id, role: "org_admin" });
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
  assertNoError(signInErr);
  const accessToken = signIn.session!.access_token;

  const property = await insertOne(admin, "properties", { org_id: org.id, name: `Meridian Center ${suffix}`, status: "active" });

  // --- canonical categories, including a deliberately ambiguous pair -------
  const mk = async (name: string, key: string, sub?: string) =>
    await insertOne(admin, "expense_categories", { org_id: org.id, category_name: name, subcategory_name: sub ?? null, normalized_key: key });
  const catOperating = await mk(`Operating ${suffix}`, `operating_${suffix}`);
  const catTaxes = await mk(`Taxes ${suffix}`, `taxes_${suffix}`);
  const catInsurance = await mk(`Insurance ${suffix}`, `insurance_${suffix}`);
  const catUtilities = await mk(`Utilities ${suffix}`, `utilities_${suffix}`);
  const catCapital = await mk(`Capital ${suffix}`, `capital_${suffix}`);
  // Two categories sharing one name -> any input labelled with that name is
  // genuinely ambiguous and must NOT be auto-mapped (specification 27).
  const ambiguousLabel = `Ambiguous ${suffix}`;
  const catAmbigA = await mk(ambiguousLabel, `ambig_a_${suffix}`, "Variant A");
  await mk(ambiguousLabel, `ambig_b_${suffix}`, "Variant B");

  // --- calendar + period ---------------------------------------------------
  const cal = await callRpc(admin, "create_recovery_calendar", {
    p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year",
    p_fiscal_start_month: 1, p_actor_user_id: actorUserId, p_actor_email: email,
  });
  const period = await callRpc(admin, "create_recovery_period", {
    p_org_id: org.id, p_calendar_id: cal.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31",
    p_label: "FY2026", p_actor_user_id: actorUserId, p_actor_email: email,
  });
  const periodId = period.period.id;

  // --- property area + occupancy (denominator + gross-up inputs) ----------
  await insertOne(admin, "space_area_measurements", {
    org_id: org.id, scope_type: "property", scope_id: property.id, area_type: "rentable",
    area_sqft: 100000, effective_from: "2026-01-01",
  });
  await insertOne(admin, "space_occupancy_periods", {
    org_id: org.id, scope_type: "property", scope_id: property.id, occupancy_status: "occupied",
    occupied_area_sqft: 80000, effective_from: "2026-01-01",
  });

  // --- leases + premises ---------------------------------------------------
  // A lease may hold several premises at once, but lease_premises_no_overlap
  // forbids two premises of the SAME type covering the same dates — so a
  // concurrent second suite is modelled as an 'expansion', which is exactly
  // the vocabulary specification 6.2 uses.
  async function makeLease(name: string, areas: number[]) {
    const lease = await insertOne(admin, "leases", {
      org_id: org.id, property_id: property.id, tenant_name: name, commencement_date: "2026-01-01",
      abstract_status: "approved", square_footage: areas.reduce((a, b) => a + b, 0),
    });
    const types = ["primary", "expansion", "storage", "parking"];
    for (const [idx, sqft] of areas.entries()) {
      const prem = await insertOne(admin, "lease_premises", {
        org_id: org.id, lease_id: lease.id, premises_type: types[idx] ?? "other", effective_from: "2026-01-01", status: "approved",
      });
      await insertOne(admin, "lease_premises_spaces", {
        org_id: org.id, lease_premises_id: prem.id, property_id: property.id, allocation_weight: 1,
      });
      await insertOne(admin, "lease_premises_area_periods", {
        org_id: org.id, lease_premises_id: prem.id, area_basis: "rentable",
        contractual_area_sqft: sqft, recovery_area_sqft: sqft, effective_from: "2026-01-01",
      });
    }
    return lease.id;
  }
  const leaseA = await makeLease("Northwind (Lease A)", [10000, 5000]); // multi-premises
  const leaseB = await makeLease("Contoso (Lease B)", [5000]);

  // --- pools (gross-up target only on the occupancy-variable pools) -------
  async function makePool(name: string, grossUpTarget: number | null) {
    const res = await callRpc(admin, "create_recovery_pool", {
      p_org_id: org.id, p_property_id: property.id, p_name: name, p_pool_type: "property",
      p_scope_type: "property", p_scope_id: property.id, p_is_template: false, p_period_id: periodId,
      p_actor_user_id: actorUserId, p_actor_email: email,
    });
    const poolId = res.pool.id;
    if (grossUpTarget !== null) {
      assertNoError((await admin.from("recovery_pools").update({ default_gross_up_target_pct: grossUpTarget }).eq("id", poolId)).error);
    }
    return poolId;
  }
  const poolOperating = await makePool("Operating CAM", 100); // percent: engine divides by 100
  const poolTaxes = await makePool("Real Estate Taxes", null);
  const poolInsurance = await makePool("Insurance", null);
  const poolUtilities = await makePool("Utilities", 100);

  const addPoolCategory = async (poolId: string, categoryId: string, mode: "include" | "exclude", variability: string, controllability: string) =>
    await insertOne(admin, "recovery_pool_categories", {
      org_id: org.id, pool_id: poolId, expense_category_id: categoryId, inclusion_mode: mode,
      variability_default: variability, controllability_default: controllability,
    });
  await addPoolCategory(poolOperating, catOperating.id, "include", "variable", "controllable");
  // The excluded category: an explicit exclude rule, matched on the canonical
  // UUID. This is the rule that silently never fired before migration 039.
  await addPoolCategory(poolOperating, catCapital.id, "exclude", "fixed", "uncontrollable");
  await addPoolCategory(poolOperating, catAmbigA.id, "exclude", "fixed", "uncontrollable");
  await addPoolCategory(poolTaxes, catTaxes.id, "include", "fixed", "uncontrollable");
  await addPoolCategory(poolInsurance, catInsurance.id, "include", "fixed", "uncontrollable");
  await addPoolCategory(poolUtilities, catUtilities.id, "include", "variable", "controllable");

  // --- participants --------------------------------------------------------
  for (const poolId of [poolOperating, poolTaxes, poolInsurance, poolUtilities]) {
    for (const leaseId of [leaseA, leaseB]) {
      await callRpc(admin, "add_recovery_pool_lease_participant", {
        p_org_id: org.id, p_pool_id: poolId, p_lease_id: leaseId, p_effective_from: "2026-01-01",
        p_actor_user_id: actorUserId, p_actor_email: email,
      });
    }
  }

  // --- policies + ordered steps -------------------------------------------
  async function makePolicy(leaseId: string, steps: Array<Record<string, unknown>>) {
    const policy = await insertOne(admin, "lease_recovery_policies", {
      org_id: org.id, lease_id: leaseId, policy_type: "category_recovery",
      effective_from: "2026-01-01", status: "approved",
    });
    let seq = 1;
    for (const step of steps) {
      await insertOne(admin, "lease_recovery_policy_steps", {
        org_id: org.id, policy_id: policy.id, sequence: seq++, parameters: {}, ...step,
      });
    }
    return policy.id;
  }
  // Lease A: operating carries base year + cap + admin fee; the other three
  // categories are plain pro-rata share.
  await makePolicy(leaseA, [
    { step_type: "CALCULATE_SHARE", expense_category_id: catOperating.id, parameters: { allocation_method: "pro_rata_share" } },
    { step_type: "APPLY_BASE_YEAR", expense_category_id: catOperating.id, parameters: { base_year: "2025", base_year_amount: 100000 } },
    { step_type: "APPLY_CAP", expense_category_id: catOperating.id, parameters: { cap_type: "fixed_dollar", cap_amount: 3675 } },
    { step_type: "ADD_ADMIN_FEE", expense_category_id: catOperating.id, parameters: { admin_fee_percent: 10 } },
  ]);
  for (const cat of [catTaxes, catInsurance, catUtilities]) {
    await makePolicy(leaseA, [
      { step_type: "CALCULATE_SHARE", expense_category_id: cat.id, parameters: { allocation_method: "pro_rata_share" } },
    ]);
  }
  // Lease B: plain pro-rata share on all four categories.
  for (const cat of [catOperating, catTaxes, catInsurance, catUtilities]) {
    await makePolicy(leaseB, [
      { step_type: "CALCULATE_SHARE", expense_category_id: cat.id, parameters: { allocation_method: "pro_rata_share" } },
    ]);
  }

  // --- published expenses (canonical category set explicitly) -------------
  async function publish(categoryId: string | null, label: string, amount: number, variability: string, controllability: string) {
    return await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id,
      expense_category_id: categoryId, category: label, amount,
      publication_status: "published", publication_version: 1, fiscal_year: 2026, cam_input_type: "actual",
      variability, controllability, service_period_start: "2026-01-01", service_period_end: "2026-12-31",
      status: "cam_ready",
    });
  }
  const expOperating = await publish(catOperating.id, catOperating.category_name, 100000, "variable", "controllable");
  const expTaxes = await publish(catTaxes.id, catTaxes.category_name, 60000, "fixed", "uncontrollable");
  const expInsurance = await publish(catInsurance.id, catInsurance.category_name, 20000, "fixed", "uncontrollable");
  const expUtilities = await publish(catUtilities.id, catUtilities.category_name, 30000, "variable", "controllable");
  const expCapital = await publish(catCapital.id, catCapital.category_name, 50000, "fixed", "uncontrollable");
  // Ambiguous: canonical id deliberately left to the trigger, which must
  // refuse to guess between the two same-named categories.
  const expAmbiguous = await insertOne(admin, "cam_expense_inputs", {
    org_id: org.id, property_id: property.id, category: ambiguousLabel, amount: 7500,
    publication_status: "published", publication_version: 1, fiscal_year: 2026, cam_input_type: "actual",
    variability: "fixed", controllability: "uncontrollable",
    service_period_start: "2026-01-01", service_period_end: "2026-12-31", status: "cam_ready",
  });
  assertEquals(expAmbiguous.expense_category_id, null); // fail-closed, not guessed

  // --- pool assignments ----------------------------------------------------
  const assign = async (inputId: string, poolId: string, amount: number) =>
    await callRpc(admin, "assign_cam_input_to_pool", {
      p_org_id: org.id, p_cam_expense_input_id: inputId, p_recovery_pool_id: poolId, p_amount: amount,
      p_assignment_method: "manual", p_actor_user_id: actorUserId, p_actor_email: email,
    });
  await assign(expOperating.id, poolOperating, 100000);
  await assign(expTaxes.id, poolTaxes, 60000);
  await assign(expInsurance.id, poolInsurance, 20000);
  await assign(expUtilities.id, poolUtilities, 30000);
  // Capital is assigned to the operating pool but the pool's exclude rule
  // must keep it out of the recoverable total.
  await assign(expCapital.id, poolOperating, 50000);

  // --- estimates -----------------------------------------------------------
  for (let m = 1; m <= 12; m++) {
    const monthDate = `2026-${String(m).padStart(2, "0")}-01`;
    await insertOne(admin, "cam_estimate_schedules", {
      org_id: org.id, lease_id: leaseA, recovery_period_id: periodId, month_date: monthDate, amount: 1700, source: "manual", status: "billed",
    });
    await insertOne(admin, "cam_estimate_schedules", {
      org_id: org.id, lease_id: leaseB, recovery_period_id: periodId, month_date: monthDate, amount: 1100, source: "manual", status: "billed",
    });
  }

  return {
    admin, orgId: org.id, propertyId: property.id, periodId, actorUserId, actorEmail: email, accessToken,
    leaseA, leaseB,
    pools: { operating: poolOperating, taxes: poolTaxes, insurance: poolInsurance, utilities: poolUtilities },
    categories: {
      operating: catOperating.id, taxes: catTaxes.id, insurance: catInsurance.id,
      utilities: catUtilities.id, capital: catCapital.id,
    },
    ambiguousInputId: expAmbiguous.id,
    capitalInputId: expCapital.id,
    ambigAId: catAmbigA.id,
  };
}

Deno.test({
  name: "LOCAL FULL FLOW: rule -> policy -> pool -> participant -> published expense -> canonical category -> assignment -> readiness -> calculation -> lease results -> calculation lines, with a manual tie-out",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fx = await buildFixture();
    const { admin } = fx;

    // ---------- TIE-OUT PART 1: published = assigned + unassigned ----------
    const { data: inputs } = await admin.from("cam_expense_inputs").select("id, amount, expense_category_id").eq("org_id", fx.orgId);
    const publishedTotal = inputs!.reduce((s, r) => s + Number(r.amount), 0);
    assertEquals(money(publishedTotal), 267500);

    const { data: assignments } = await admin.from("cam_input_pool_assignments").select("amount, cam_expense_input_id").eq("org_id", fx.orgId);
    const assignedTotal = assignments!.reduce((s, r) => s + Number(r.amount), 0);
    assertEquals(money(assignedTotal), 260000);
    assertEquals(money(publishedTotal - assignedTotal), 7500); // the ambiguous input

    // The unassigned remainder is exactly the unresolved-category input.
    const assignedIds = new Set(assignments!.map((a) => a.cam_expense_input_id));
    const unassigned = inputs!.filter((i) => !assignedIds.has(i.id));
    assertEquals(unassigned.length, 1);
    assertEquals(unassigned[0].id, fx.ambiguousInputId);
    assertEquals(unassigned[0].expense_category_id, null);

    // ---------- Automatic preparation: participants + provenance ----------
    const prep = await prepareCamAutomatically(admin, {
      orgId: fx.orgId, propertyId: fx.propertyId, recoveryPeriodId: fx.periodId,
      actorUserId: fx.actorUserId, actorEmail: fx.actorEmail,
    });
    assertEquals(prep.counts.published_expenses, 6);
    assertEquals(prep.counts.published_amount, "267500.00");
    assertEquals(prep.counts.uncategorized_expenses, 1);
    assertEquals(prep.counts.uncategorized_amount, "7500.00");
    // The ambiguous input is surfaced as a real, actionable blocker.
    assertEquals(prep.missing.published_expenses_without_canonical_category.length, 1);
    assertEquals(prep.missing.published_expenses_without_canonical_category[0].code, "EXPENSE_CATEGORY_MISSING");

    // Participant suggestions exist and are keyed by canonical category UUID.
    const participantCategories = Object.keys(prep.suggested.participants_by_category);
    assertEquals(participantCategories.length > 0, true);
    for (const catId of participantCategories) {
      // Every key must be a canonical category UUID we created, never a label.
      assertEquals(Object.values(fx.categories).includes(catId), true);
    }
    const operatingParticipants = prep.suggested.participants_by_category[fx.categories.operating] ?? [];
    // One suggestion PER PREMISES: Lease A has two concurrent premises, Lease
    // B has one, so three rows covering two distinct leases.
    assertEquals(operatingParticipants.length, 3);
    assertEquals(new Set(operatingParticipants.map((p: any) => p.lease_id)).size, 2);
    for (const p of operatingParticipants) {
      assertEquals(p.matched_on.field, "expense_category_id");
      assertEquals(p.matched_on.value, fx.categories.operating);
    }
    // Lease A's two premises both surface (multi-premises).
    const leaseAParticipantRows = operatingParticipants.filter((p: any) => p.lease_id === fx.leaseA);
    assertEquals(leaseAParticipantRows.length, 2);

    // ---------- Readiness gate: the run must REFUSE while a material,
    // published input has no canonical category (fail-closed, spec 18/31).
    const blocked = await callEdge("run-cam-calculation-v2", fx.accessToken, {
      property_id: fx.propertyId, recovery_period_id: fx.periodId, scope_type: "property", scope_id: fx.propertyId,
      run_type: "preview", run_mode: "preview",
    });
    assertEquals(blocked.status, 200);
    assertEquals(blocked.json.status, "readiness_failed");

    // ---------- Controlled resolution of the ambiguous category ----------
    const candidates = await callRpc(admin, "get_cam_input_category_candidates", {
      p_org_id: fx.orgId, p_property_id: fx.propertyId, p_recovery_period_id: fx.periodId,
    });
    assertEquals(candidates.unresolved_count, 1);
    assertEquals(candidates.items[0].candidate_count, 2);
    await callRpc(admin, "resolve_cam_input_category", {
      p_org_id: fx.orgId, p_cam_expense_input_id: fx.ambiguousInputId, p_expense_category_id: fx.ambigAId,
      p_reason: "Invoice reviewed: this is Variant A, a capital-nature item excluded by the operating pool",
      p_evidence: { invoice: "INV-4412", reviewer: "controller" },
      p_actor_user_id: fx.actorUserId, p_actor_email: fx.actorEmail,
    });
    await callRpc(admin, "assign_cam_input_to_pool", {
      p_org_id: fx.orgId, p_cam_expense_input_id: fx.ambiguousInputId, p_recovery_pool_id: fx.pools.operating,
      p_amount: 7500, p_assignment_method: "manual", p_actor_user_id: fx.actorUserId, p_actor_email: fx.actorEmail,
    });

    // ---------- Calculation ----------
    const { status, json } = await callEdge("run-cam-calculation-v2", fx.accessToken, {
      property_id: fx.propertyId, recovery_period_id: fx.periodId, scope_type: "property", scope_id: fx.propertyId,
      run_type: "standard", run_mode: "preview",
    });
    assertEquals(status, 200);
    assertEquals(json.status, "calculated");

    // ---------- TIE-OUT PART 2: pool source totals ----------
    const { data: poolResults } = await admin.from("cam_run_pool_results").select("*").eq("cam_run_id", json.run_id);
    const byPool = new Map(poolResults!.map((p: any) => [p.pool_id, p]));

    const operating = byPool.get(fx.pools.operating)!;
    const taxes = byPool.get(fx.pools.taxes)!;
    const insurance = byPool.get(fx.pools.insurance)!;
    const utilities = byPool.get(fx.pools.utilities)!;

    // The excluded Capital expense is reported as excluded, not recovered —
    // proof the canonical-UUID exclude rule actually fires.
    assertEquals(money(operating.excluded_amount), 57500); // Capital 50,000 + Variant A 7,500
    assertEquals(money(operating.adjusted_pool), 125000); // 100,000 x 1.25
    assertEquals(money(taxes.adjusted_pool), 60000);      // fixed, no gross-up
    assertEquals(money(insurance.adjusted_pool), 20000);  // fixed, no gross-up
    assertEquals(money(utilities.adjusted_pool), 37500);  // 30,000 x 1.25

    // Pool source dollars = what was included plus what the pool's own
    // category rules excluded. This must equal every assigned dollar.
    const poolSourceTotal = [operating, taxes, insurance, utilities]
      .reduce((s, p: any) => s + Number(p.actual_amount ?? 0) + Number(p.excluded_amount ?? 0), 0);
    assertEquals(money(poolSourceTotal), 267500);
    assertEquals(money(operating.actual_amount), 100000); // recoverable operating only after resolution

    // ---------- TIE-OUT PART 3: lease results ----------
    const { data: leaseResults } = await admin.from("cam_run_lease_results").select("*").eq("cam_run_id", json.run_id);
    const resultFor = (leaseId: string) => leaseResults!.filter((r: any) => r.lease_id === leaseId)
      .reduce((s, r: any) => s + Number(r.final_recovery ?? 0), 0);

    // EXACT agreement with the analytic hand-calculation. Under the
    // LEASE_POOL_PERIOD rounding policy no intermediate policy step is
    // rounded, aggregation happens once per (lease, pool, period), and
    // largest-remainder allocation only distributes an already-rounded
    // authoritative total — so there is no drift left to tolerate.
    const ANALYTIC_A = 21667.50, ANALYTIC_B = 12125.00;
    assertEquals(money(resultFor(fx.leaseA)), ANALYTIC_A);
    assertEquals(money(resultFor(fx.leaseB)), ANALYTIC_B);
    assertEquals(money(ANALYTIC_A + ANALYTIC_B), 33792.50);

    // Estimate reconciliation: final - estimates = due (positive) / credit.
    const { data: leaseRows } = await admin.from("cam_run_lease_results")
      .select("lease_id, final_recovery, estimates_billed, amount_due_credit").eq("cam_run_id", json.run_id);
    for (const row of leaseRows!) {
      assertEquals(money(Number(row.final_recovery) - Number(row.estimates_billed)), money(row.amount_due_credit));
    }
    const rowA = leaseRows!.find((r: any) => r.lease_id === fx.leaseA)!;
    const rowB = leaseRows!.find((r: any) => r.lease_id === fx.leaseB)!;
    assertEquals(money(rowA.estimates_billed), 20400.00);
    assertEquals(money(rowB.estimates_billed), 13200.00);
    assertEquals(money(rowA.amount_due_credit), 1267.50);   // amount DUE
    assertEquals(money(rowB.amount_due_credit), -1075.00);  // CREDIT

    // ---------- Calculation lines exist and are explainable ----------
    const { data: lines } = await admin.from("cam_run_calculation_lines").select("line_type, formula_code, explanation").eq("cam_run_id", json.run_id);
    assertEquals(lines!.length > 0, true);
    const lineTypes = new Set(lines!.map((l: any) => l.line_type));
    for (const required of ["TENANT_SHARE", "BASE_YEAR", "CAP", "ADMIN_FEE"]) {
      assertEquals(lineTypes.has(required), true);
    }
  },
});

Deno.test({
  name: "LOCAL: resolving a source category marks DRAFT runs stale and leaves APPROVED/POSTED runs untouched",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fx = await buildFixture();
    const { admin } = fx;

    // Assign the ambiguous input so a run actually depends on it.
    const { data: candidates } = await admin.rpc("get_cam_input_category_candidates", {
      p_org_id: fx.orgId, p_property_id: fx.propertyId,
    });
    assertEquals(candidates.unresolved_count, 1);
    const chosen = candidates.items[0].candidates[0].expense_category_id;

    await callRpc(admin, "assign_cam_input_to_pool", {
      p_org_id: fx.orgId, p_cam_expense_input_id: fx.ambiguousInputId, p_recovery_pool_id: fx.pools.operating,
      p_amount: 7500, p_assignment_method: "manual", p_actor_user_id: fx.actorUserId, p_actor_email: fx.actorEmail,
    });

    // One draft run and one posted run, both over this period.
    // idx_cam_runs_one_active_per_series allows only one active run per
    // (org, period, scope, run_type) unless run_type = 'preview', so the
    // draft is a preview run and the posted one is the standard series.
    const draftRun = await insertOne(admin, "cam_runs", {
      org_id: fx.orgId, recovery_period_id: fx.periodId, scope_type: "property", scope_id: fx.propertyId,
      run_number: 901, run_type: "preview", status: "calculated", engine_version: "cam-engine-v2.0.0", run_mode: "preview",
    });
    const postedRun = await insertOne(admin, "cam_runs", {
      org_id: fx.orgId, recovery_period_id: fx.periodId, scope_type: "property", scope_id: fx.propertyId,
      run_number: 902, run_type: "standard", status: "posted", engine_version: "cam-engine-v2.0.0", run_mode: "posting_eligible",
      posted_at: new Date().toISOString(),
    });

    const result = await callRpc(admin, "resolve_cam_input_category", {
      p_org_id: fx.orgId, p_cam_expense_input_id: fx.ambiguousInputId, p_expense_category_id: chosen,
      p_reason: "Lease clause 7.2 names Variant A", p_evidence: { lease_page: 14 },
      p_actor_user_id: fx.actorUserId, p_actor_email: fx.actorEmail,
    });
    assertEquals(result.success, true);
    assertEquals(result.draft_runs_marked_stale, 1);
    // Posted runs are COUNTED and returned, never written to.
    assertEquals(result.posted_runs_requiring_restatement, 1);
    assertEquals(result.posted_run_ids_requiring_restatement.includes(postedRun.id), true);

    const { data: draftAfter } = await admin.from("cam_runs").select("status, stale, stale_reason").eq("id", draftRun.id).single();
    assertEquals(draftAfter!.stale, true);
    assertEquals(draftAfter!.status, "calculated"); // status itself untouched
    assertExists(draftAfter!.stale_reason);

    // The posted run is NEVER written to at all. public.enforce_cam_run_
    // immutability rejects any UPDATE to a posted run, and the specification's
    // rule is "never mutate approved or posted run snapshots" — so the RPC
    // reports the affected run instead of flagging it in place, and every
    // column below is byte-identical to before the resolution.
    const { data: postedAfter } = await admin.from("cam_runs")
      .select("status, stale, stale_reason, stale_at, posted_at, updated_at").eq("id", postedRun.id).single();
    assertEquals(postedAfter!.status, "posted");
    assertEquals(postedAfter!.stale, false);
    assertEquals(postedAfter!.stale_reason, null);
    assertEquals(postedAfter!.stale_at, null);
    assertEquals(postedAfter!.updated_at, postedRun.updated_at);
    assertExists(postedAfter!.posted_at);
  },
});
