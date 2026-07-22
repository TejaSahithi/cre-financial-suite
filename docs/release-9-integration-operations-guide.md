# Release 9 Integration Operations Guide

Release 9 extends canonical lease and portfolio facts into enterprise integrations, workflow automation, notifications, and operational orchestration. The release remains feature-flagged and staged; no connector is allowed to write back to an external system from this layer.

Required feature flags:

- `ENABLE_EVENT_BUS`
- `ENABLE_WORKFLOW_ENGINE`
- `ENABLE_WEBHOOKS`
- `ENABLE_NOTIFICATIONS`
- `ENABLE_CONNECTORS`
- `ENABLE_PUBLIC_API`
- `ENABLE_EXPORT_AUTOMATION`
- `ENABLE_CALENDAR_SYNC`

Rollout order:

1. Enable `ENABLE_EVENT_BUS` in shadow mode and confirm immutable event rows are generated from approved facts.
2. Enable `ENABLE_PUBLIC_API` for internal clients and validate cursor pagination and organization scoping.
3. Enable `ENABLE_WORKFLOW_ENGINE` for review queues only, then verify assignment routing and SLA breach detection.
4. Enable `ENABLE_NOTIFICATIONS` with in-app channels first, then email or collaboration channels after template approval.
5. Enable `ENABLE_WEBHOOKS` for signed delivery to controlled endpoints with retry and dead-letter monitoring.
6. Enable `ENABLE_CONNECTORS`, `ENABLE_EXPORT_AUTOMATION`, and `ENABLE_CALENDAR_SYNC` only after credential rotation and endpoint ownership are confirmed.

Operational gates:

- migration has RLS enabled for every Release 9 table;
- event payloads use versioned contracts and stable payload hashes;
- webhook payloads include HMAC signatures and replay timestamps;
- retry policy retries transient failures and dead-letters permanent or exhausted failures;
- connectors project approved contracts only and keep external actions read-only;
- notification and workflow tasks retain source event lineage;
- calendar sync emits read-only plans and ICS payloads from critical date facts.

Verification command:

```bash
npm run check:release9-readiness
```

Production activation requires a human go/no-go, endpoint owner signoff, and rollback owner assignment.