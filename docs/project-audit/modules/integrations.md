# Module: Integrations

> Generated: 2026-07-20 · Revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` · Canonical score **2.0 / 5** (tied-lowest), criticality **6 (Medium)** — [03](../03-module-catalog-and-maturity.md) · Index: [04](../04-module-deep-dives.md)

## Functional / technical view
The only fully-realized third-party integration is `validate-address-ups` (UPS address validation, JWT-required). The `Integrations` page exists in the nav but no other backend integration surface was found connected to it — it reads as a placeholder for a future integration marketplace/connector list rather than a working feature (`PARTIAL`/UI-only for anything beyond UPS).

## Assessment
**Strengths:** the one real integration (UPS) is implemented correctly (proper OAuth-style client credentials, scoped env vars).
**Weaknesses:** this is the module most directly tied to the product's long-term defensibility and isn't started — CRE finance teams live in QuickBooks/Yardi/AppFolio/accounting-system workflows, and the absence of any connector here means the product currently cannot embed itself into a customer's existing financial stack ([17](../17-billion-dollar-saas-evolution.md) discusses this as a strategic gap, not just a technical one).
**Recommended:** MARKET-VALIDATION-REQUIRED before building — confirm which accounting/property-management systems customers actually need (QuickBooks Online is the most likely first target for a CRE finance tool); this is a roadmap/strategy item more than a bug-fix item (L complexity, P2 — sequenced behind market validation, not behind engineering readiness).
