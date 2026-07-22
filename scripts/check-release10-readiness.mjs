#!/usr/bin/env node
import fs from "node:fs";

const requiredFiles = [
  "supabase/migrations/20260863000000_enterprise_control_plane_release10.sql",
  "supabase/functions/_shared/enterprise-control/enterprise-authorization.ts",
  "supabase/functions/_shared/enterprise-control/support-policy.ts",
  "supabase/functions/_shared/enterprise-control/compliance-evidence.ts",
  "supabase/functions/_shared/enterprise-control/residency-policy.ts",
  "supabase/functions/_shared/enterprise-control/retention-policy.ts",
  "supabase/functions/_shared/enterprise-control/error-budget.ts",
  "supabase/functions/_shared/enterprise-control/backup-verification.ts",
  "supabase/functions/_shared/enterprise-control/disaster-recovery.ts",
  "supabase/functions/_shared/enterprise-control/legacy-retirement.ts",
  "docs/release-10-compliance-readiness.md",
  "docs/release-10-final-ga-certification.md",
  "docs/release-10-legacy-path-inventory.md",
  "docs/release-10-database-lint-remediation.md",
  "docs/release-10-dr-exercise-report.md",
  "docs/release-10-service-catalog.md",
  "docs/templates/incident-report.md",
];
const requiredRunbooks = [
  "docs/runbooks/release-10-authentication-failure.md",
  "docs/runbooks/release-10-authorization-incident.md",
  "docs/runbooks/release-10-tenant-isolation-incident.md",
  "docs/runbooks/release-10-data-residency-violation.md",
  "docs/runbooks/release-10-backup-failure.md",
  "docs/runbooks/release-10-disaster-recovery.md",
  "docs/runbooks/release-10-cost-anomaly.md",
  "docs/runbooks/release-10-capacity-exhaustion.md",
  "docs/runbooks/release-10-audit-pipeline-failure.md",
  "docs/runbooks/release-10-organization-offboarding.md",
  "docs/runbooks/release-10-legacy-retirement.md",
  "docs/runbooks/release-10-ga-rollback.md",
  "docs/runbooks/release-10-incident-management.md",
];
const requiredLoadTests = ["ingestion-scale", "review-endurance", "portfolio-large-scale", "event-throughput", "webhook-backlog", "api-rate-limit", "export-scale"].map((name) => `load-tests/release10/${name}.js`);
const requiredFlags = ["ENABLE_ENTERPRISE_RBAC_V10", "ENABLE_DELEGATED_ADMIN", "ENABLE_SUPPORT_ACCESS_CONTROL", "ENABLE_COMPLIANCE_EVIDENCE", "ENABLE_RETENTION_ENFORCEMENT", "ENABLE_RESIDENCY_ENFORCEMENT", "ENABLE_ORGANIZATION_QUOTAS", "ENABLE_ERROR_BUDGET_GATES", "ENABLE_ASYNC_EXPORTS", "ENABLE_LEGACY_RETIREMENT_CONTROLS", "ENABLE_BROAD_GA"];
const requiredTables = ["organization_security_policies", "organization_data_residency_policies", "organization_retention_policies", "organization_feature_entitlements", "organization_usage_quotas", "organization_usage_counters", "organization_support_tiers", "organization_rollout_states", "enterprise_audit_events", "compliance_evidence_records", "backup_verification_runs", "disaster_recovery_exercises", "service_level_measurements", "error_budget_snapshots", "legacy_path_usage", "legacy_retirement_exceptions", "production_change_records"];
function read(file) { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; }
const missingFiles = [...requiredFiles, ...requiredRunbooks, ...requiredLoadTests].filter((file) => !fs.existsSync(file));
const migration = read("supabase/migrations/20260863000000_enterprise_control_plane_release10.sql");
const flags = read("supabase/functions/_shared/extraction/document-intelligence-v3/feature-flag.ts");
const missingTables = requiredTables.filter((table) => !migration.includes(table));
const missingFlags = requiredFlags.filter((flag) => !flags.includes(flag));
const missingRlsPolicies = requiredTables.filter((table) => !migration.includes(`${table}_select`));
const failingGates = [];
if (missingFiles.length) failingGates.push("release10_files_missing");
if (missingTables.length) failingGates.push("release10_tables_missing");
if (missingFlags.length) failingGates.push("release10_flags_missing");
if (missingRlsPolicies.length) failingGates.push("release10_rls_policy_inventory_missing");
const status = failingGates.length ? "not_ready" : "ready_for_broad_ga_review";
console.log(JSON.stringify({ schemaVersion: "release-10-readiness-check-v1", status, missingFiles, missingTables, missingFlags, missingRlsPolicies, failingGates, note: status === "not_ready" ? "Release 10 remains gated until missing controls are restored." : "Automated Release 10 evidence is present; final broad GA still requires human signoff and independent verification." }, null, 2));
if (status !== "ready_for_broad_ga_review") process.exitCode = 1;