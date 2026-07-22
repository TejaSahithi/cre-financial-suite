#!/usr/bin/env node
import fs from "node:fs";

const requiredFiles = [
  "supabase/migrations/20260862000000_enterprise_integrations_release9.sql",
  "supabase/functions/_shared/events/event-bus.ts",
  "supabase/functions/_shared/events/event-contracts.ts",
  "supabase/functions/_shared/events/event-publisher.ts",
  "supabase/functions/_shared/events/event-replay.ts",
  "supabase/functions/_shared/events/event-registry.ts",
  "supabase/functions/_shared/events/event-store.ts",
  "supabase/functions/_shared/workflows/workflow-definitions.ts",
  "supabase/functions/_shared/workflows/workflow-engine.ts",
  "supabase/functions/_shared/workflows/workflow-routing.ts",
  "supabase/functions/_shared/integrations/calendar-sync.ts",
  "supabase/functions/_shared/integrations/connector-adapters.ts",
  "supabase/functions/_shared/integrations/dead-letter.ts",
  "supabase/functions/_shared/integrations/integration-contracts.ts",
  "supabase/functions/_shared/integrations/integration-diagnostics.ts",
  "supabase/functions/_shared/integrations/integration-security-contract.ts",
  "supabase/functions/_shared/integrations/notification-service.ts",
  "supabase/functions/_shared/integrations/public-api.ts",
  "supabase/functions/_shared/integrations/retry-policy.ts",
  "supabase/functions/_shared/integrations/webhook-delivery.ts",
  "supabase/functions/integration-events-v1/index.ts",
  "supabase/functions/integration-webhook-delivery/index.ts",
  "supabase/functions/workflow-orchestration-v9/index.ts",
  "supabase/functions/notification-dispatch-v9/index.ts",
  "supabase/functions/connector-management-v9/index.ts",
  "supabase/functions/calendar-sync-v9/index.ts",
  "docs/release-9-integration-operations-guide.md",
  "docs/runbooks/release-9-webhook-delivery-failure.md",
  "docs/runbooks/release-9-dead-letter-replay.md",
  "docs/runbooks/release-9-credential-rotation.md",
];

const requiredTests = [
  "supabase/functions/_tests/release9-calendar-sync.test.ts",
  "supabase/functions/_tests/release9-connector-security.test.ts",
  "supabase/functions/_tests/release9-dead-letter.test.ts",
  "supabase/functions/_tests/release9-event-bus.test.ts",
  "supabase/functions/_tests/release9-integration-api.test.ts",
  "supabase/functions/_tests/release9-migration-static.test.ts",
  "supabase/functions/_tests/release9-notification-service.test.ts",
  "supabase/functions/_tests/release9-retry-policy.test.ts",
  "supabase/functions/_tests/release9-webhook-delivery.test.ts",
  "supabase/functions/_tests/release9-workflow-engine.test.ts",
  "supabase/functions/_tests/release9-workflow-routing.test.ts",
];

const requiredFlags = [
  "ENABLE_EVENT_BUS",
  "ENABLE_WORKFLOW_ENGINE",
  "ENABLE_WEBHOOKS",
  "ENABLE_NOTIFICATIONS",
  "ENABLE_CONNECTORS",
  "ENABLE_PUBLIC_API",
  "ENABLE_EXPORT_AUTOMATION",
  "ENABLE_CALENDAR_SYNC",
];

const requiredTables = [
  "integration_events",
  "integration_subscriptions",
  "integration_deliveries",
  "integration_delivery_attempts",
  "integration_dead_letters",
  "integration_endpoints",
  "integration_credentials",
  "workflow_instances",
  "workflow_tasks",
  "notification_queue",
];

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

const missingFiles = [...requiredFiles, ...requiredTests].filter((file) => !fs.existsSync(file));
const migration = read("supabase/migrations/20260862000000_enterprise_integrations_release9.sql");
const flags = read("supabase/functions/_shared/extraction/document-intelligence-v3/feature-flag.ts");
const missingTables = requiredTables.filter((table) => !migration.includes(table));
const missingFlags = requiredFlags.filter((flag) => !flags.includes(flag));
const missingRlsPolicies = requiredTables.filter((table) => !migration.includes(`${table}_select`));

const failingGates = [];
if (missingFiles.length) failingGates.push("release9_files_missing");
if (missingTables.length) failingGates.push("release9_migration_tables_missing");
if (missingFlags.length) failingGates.push("release9_feature_flags_missing");
if (missingRlsPolicies.length) failingGates.push("release9_rls_policy_inventory_missing");

const status = failingGates.length ? "not_ready" : "ready_for_enterprise_integration_review";
const summary = {
  schemaVersion: "release-9-readiness-check-v1",
  status,
  missingFiles,
  missingTables,
  missingFlags,
  missingRlsPolicies,
  failingGates,
  note: status === "not_ready"
    ? "Release 9 must remain gated until the missing integration controls are restored."
    : "Automated evidence is present; production activation still requires a human go/no-go and staged flag rollout.",
};

console.log(JSON.stringify(summary, null, 2));
if (status !== "ready_for_enterprise_integration_review") process.exitCode = 1;