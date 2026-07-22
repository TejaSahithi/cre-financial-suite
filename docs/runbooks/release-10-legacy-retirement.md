# Release 10 Legacy Retirement Runbook

Severity guidance:

- SEV-1 for security, isolation, audit loss, credential compromise, or full platform outage.
- SEV-2 for a major capability unavailable across organizations.
- SEV-3 for degraded performance or partial failure.
- SEV-4 for localized defects.

Immediate actions:

1. Assign an incident commander and record the incident in the template.
2. Identify affected organizations and capabilities without exposing customer data.
3. Preserve audit evidence, request IDs, correlation IDs, and change records.
4. Apply the safest degraded mode for the affected reliability tier.
5. Confirm rollback or pause controls remain organization-scoped and reversible.

Recovery checks:

- authorization and audit controls are available;
- tenant isolation checks pass;
- backup, DR, or queue health matches the incident type;
- customer-facing status is sanitized;
- follow-up owner and due date are assigned.

Do not bypass audit, residency, retention, or authorization controls to restore optional functionality.