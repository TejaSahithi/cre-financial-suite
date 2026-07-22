# Release 10 Compliance Readiness

Release 10 broad GA readiness is evidence-based. This report does not claim external certification; it identifies internal controls and evidence locations.

Control coverage:

- organization-scoped RLS for enterprise governance tables;
- permission-based enterprise RBAC with explicit deny and support-access gates;
- append-only enterprise audit events with sanitized metadata;
- residency policy checks before processing, storage, backup, failover, and connector delivery;
- retention, legal-hold, deletion planning, and deletion verification helpers;
- quota, capacity, backpressure, and cost attribution controls;
- SLO and error-budget gates for rollout decisions;
- backup verification and DR exercise records;
- legacy usage telemetry and retirement gates;
- production change records with rollback and verification plans.

Evidence locations:

- migration: `supabase/migrations/20260863000000_enterprise_control_plane_release10.sql`
- controls: `supabase/functions/_shared/enterprise-control/`
- generated evidence: `npm run generate:compliance-evidence`
- readiness: `npm run check:release10-readiness`
- operational runbooks: `docs/runbooks/release-10-*.md`

Known gaps before external certification:

- independent penetration test evidence must be attached;
- production backup restore exercise must be run in the target infrastructure;
- DR exercise results must reflect actual deployed regions and providers;
- legal/compliance owner must approve retention and residency defaults.