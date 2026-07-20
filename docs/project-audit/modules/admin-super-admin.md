# Module: Admin & Super-Admin Platform

> Generated: 2026-07-20 · Revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` · Canonical score **2.6 / 5**, criticality **13 (High)** — [03](../03-module-catalog-and-maturity.md) · Index: [04](../04-module-deep-dives.md)

## Functional / technical view
Cross-org platform administration. Pages: `SuperAdmin`, `Stakeholders`, `OrgSettings`, `UserManagement`, `ChartOfAccounts`, `FieldMappingRules`, `ApprovalWorkflows`. Component: `src/components/admin/AdminControlSurfaces.jsx`. Functions: `approve-organization`, `approve-request`, `reset-mfa`, `custom-fields`. The acting-org mechanism ([TEN-003](../findings-register.md#ten-003)) is this module's core safety feature: super-admins cannot silently act on an arbitrary tenant.

## Workflow view
Org approval (§ [onboarding](onboarding.md)); MFA reset for locked-out users; custom field configuration per org; chart-of-accounts and field-mapping administration for accounting alignment.

## Assessment
**Strengths:** the acting-org hardening is a genuine security-review success story worth citing in enterprise conversations; custom fields + field mapping show real attention to the "every CRE org's chart of accounts is different" problem.
**Weaknesses:** no consent-logged impersonation feature for customer-support use cases (acting-org is close but built for super-admin operations, not support tooling); no admin activity dashboard beyond raw audit-log rows.
**Recommended:** purpose-built support-impersonation flow with explicit consent/audit trail (M, P3 — becomes important once there's a support team); admin activity summary view (S, P3).
