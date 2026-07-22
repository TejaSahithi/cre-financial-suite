# Release 7 Security Incident Runbook

Symptoms:
- User-visible errors or elevated failure metrics for this area.
- Related alerts in Release 7 dashboards.

Diagnostic queries:
- Check recent edge-function errors filtered by organization, uploaded_file_id, run_id, and generation_id.
- Inspect `document_enterprise_review_payloads` current rows and schema versions.
- Inspect semantic tables for organization-scoped rows only.

Likely causes:
- Provider outage or rate limit.
- Stale generation or duplicate retry.
- Payload build or persistence failure.
- Rollout flag mismatch.

Safe mitigations:
- Prefer organization-scoped rollback over data deletion.
- Disable semantic search or semantic approval gating before disabling the full canonical review path.
- Preserve reviewer overrides and audit evidence.

Rollback steps:
- Payload v2 to v1: disable `ENABLE_ENTERPRISE_REVIEW_PAYLOAD_V2` for the affected organization/runtime.
- Strict to hybrid: update org rollout from `canonical_strict_pilot` to `canonical_hybrid`.
- Hybrid to shadow: update org rollout to `shadow`.
- Semantic search off: disable `ENABLE_SEMANTIC_FIELD_SEARCH_V6`.

Customer impact:
- Core lease review should remain available through hybrid or legacy fallback.
- Semantic diagnostics may be delayed until replay.

Escalation criteria:
- Tenant-isolation concern.
- Stale-generation acceptance.
- Approval-critical amendment conflict.
- Repeated rollback failure.

Post-incident tasks:
- Attach benchmark or log evidence.
- Add failure-injection coverage if missing.
- Update thresholds, runbook, or alerts if the incident escaped detection.