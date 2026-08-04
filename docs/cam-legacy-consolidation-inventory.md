# CAM Legacy Consolidation Inventory

This inventory documents all legacy CAM domain objects, edge functions, services, frontend components, database objects, and test fixtures prior to cutover, archival, and migration.

| Object Name | Category | Purpose | Readers | Writers | Dependencies | Data Volume | Replacement Object / Path | Action |
|---|---|---|---|---|---|---|---|---|
| `cam_profiles` | Table | Legacy per-lease CAM configuration & cap rules | `ApprovalWorkflows.jsx`, legacy `compute-cam` | Legacy `saveCamProfile`, `approved-lease-expense-rules.ts` | `leases`, `properties` | Medium | `lease_recovery_policies`, `lease_recovery_policy_steps` | ARCHIVE |
| `cam_calculations` | Table | Legacy single-row CAM computation result per property/year | Legacy `CAMCalculation.jsx`, `Revenue.jsx`, `Billing.jsx`, `Analytics.jsx` | Legacy `compute-cam` Edge Function | `properties`, `organizations` | Medium | `cam_runs`, `cam_run_pool_results`, `cam_run_lease_results` | ARCHIVE |
| `property_cam_configs` | Virtual / JSON | Property-level fallback CAM rules (caps, admin fee, gross-up) | Legacy `CAMDashboard.jsx`, `fetchPropertyCamConfig` | Legacy `savePropertyCamConfig` | `properties` | Small | `recovery_pools` (pool defaults) / materialized policies | DELETE |
| `compute-cam` | Edge Function | Legacy monolithic CAM engine execution endpoint | Internal test triggers, legacy UI | `compute-orchestrator.ts` | `cam_profiles`, `cam_calculations`, `computation_snapshots` | Active | `run-cam-calculation-v2` Edge Function & orchestrator | ARCHIVE |
| `_shared/cam-calculator.ts` | Edge Function Shared Code | Legacy V1 CAM engine calculation math & logic | `compute-cam/index.ts` | Internal engine logic | Deno runtime | Code | `_shared/cam-engine-v2/` orchestrator & domain engine | ARCHIVE |
| `CAMCalculation.jsx` | Frontend Page | Legacy calculation trigger & override interface | Router / Users | None (Retired) | `CAMCalculationService`, `compute-cam` | Code | `CAMRun.jsx` (CAM Runs) | DELETE |
| `CAMSetupV2.jsx` | Frontend Page | Preview route for 7-step guided workflow | Router / Users | None | `CAMSetup.jsx` | Code | `CAMSetup.jsx` (Consolidated guided setup) | DELETE |
| `CAMPosting.jsx` | Frontend Page | Standalone page for posting pipeline | Router / Users | None | `cam-run-workflow-v2` | Code | `CAMRun.jsx` (Statements & Export tab) | DELETE |
| `fetchPropertyCamConfig` / `savePropertyCamConfig` | Frontend Service (`camConfig.js`) | Legacy API service for property CAM rule overrides | Legacy `CAMDashboard.jsx` | Frontend forms | `supabase` client | Code | `cam-setup-actions-v2` Edge Function | DELETE |
| `CAMCalculationService` | Frontend Service (`api.js`) | Legacy API client wrapper for `cam_calculations` table | `Revenue.jsx`, `Billing.jsx`, `Analytics.jsx`, `Comparison.jsx` | Legacy pages | `cam_calculations` table | Code | Direct queries against `cam_runs` / `cam_run_lease_results` | DELETE |
| `CustomCAMRulesTab.jsx` | Frontend Component | Property-level CAM rule override tab | Legacy `CAMDashboard.jsx` | `savePropertyCamConfig` | `property_cam_configs` | Code | Materialized policies in `CAMSetup.jsx` (Step 4) | DELETE |
| `CAMReviewTab.jsx` | Frontend Component | Legacy CAM calculation review tab | Legacy `CAMDashboard.jsx` | `compute-cam` | `cam_calculations` | Code | `CAMDashboard.jsx` (CAM Overview) & `CAMRun.jsx` | DELETE |
| `cam-profiles-rls-lockdown.property.test.ts` | Test Fixture | Test suite for `cam_profiles` RLS policies | Deno test runner | None | `cam_profiles` table | Code | Canonical `cam-engine-v2` test suite | ARCHIVE |
| `cam-profile-workflows.property.test.ts` | Test Fixture | Test suite for `cam_profiles` workflow RPCs | Deno test runner | None | `cam_profiles` table | Code | Canonical `cam-engine-v2` test suite | ARCHIVE |

---

## Action Classifications Summary

1. **KEEP**: Authoritative CAM schema (`lease_expense_rules`, `lease_recovery_policies`, `lease_recovery_policy_steps`, `cam_expense_inputs`, `cam_input_pool_assignments`, `recovery_calendars`, `recovery_periods`, `recovery_pools`, `cam_runs`, `cam_run_pool_results`, `cam_run_lease_results`, `cam_run_calculation_lines`, `cam_run_exceptions`, `cam_run_statements`, `cam_charge_exports`, `cam_adjustment_runs`, `cam_restatement_runs`, `cam_real_property_validations`).
2. **MIGRATE**: Legacy `cam_profiles` rules to `lease_recovery_policies` / pool participants; legacy estimate data to `cam_estimate_schedules`.
3. **TEMPORARY_ADAPTER**: Read-only compatibility views during migration dry-run and tie-out.
4. **ARCHIVE**: Move legacy tables (`cam_profiles`, `cam_calculations`) to `legacy_` prefix, restrict permissions, deprecate `compute-cam` Edge Function.
5. **DELETE**: Legacy frontend forms, retired page files (`CAMCalculation.jsx`), and legacy service helpers (`savePropertyCamConfig`, `CAMCalculationService`).
