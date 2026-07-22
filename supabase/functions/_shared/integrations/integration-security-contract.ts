// @ts-nocheck

export const RELEASE9_RLS_TABLES = [
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

export const RELEASE9_ENDPOINTS_REQUIRE_ORG_SCOPE = [
  "integration-events-v1",
  "integration-webhook-delivery",
  "workflow-orchestration-v9",
  "notification-dispatch-v9",
  "connector-management-v9",
  "calendar-sync-v9",
];

export const RELEASE9_SECURITY_REQUIREMENTS = {
  organizationMembership: "organization_id IN (SELECT public.get_my_org_ids())",
  credentialStorage: "credential_ciphertext",
  signedWebhookHeader: "X-CRE-Signature",
  directDatabaseAccessForThirdParties: false,
  automaticFinancialPosting: false,
};
