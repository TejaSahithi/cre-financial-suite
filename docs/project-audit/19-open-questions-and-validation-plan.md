# 19 — Open Questions & Validation Plan

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

Significant uncertainties this audit could not resolve from the repository alone. Repository-verifiable items (need only more engineering time) are separated from stakeholder/customer-input items.

## Repository-verifiable (an engineer can answer these without leadership/customer input)

| # | Question | Why it matters | Current evidence | How to validate | Urgency |
|---|---|---|---|---|---|
| Q1 | Is the linked Supabase project's schema/functions actually deployed and current? | Everything else is provisional until known | Prior self-audit says no; this audit prohibited from checking | `supabase migration list` / `functions list` against remote | **Urgent** |
| Q2 | Does the remote schema currently match the 216 migrations exactly? | Confirms [TEN-001](findings-register.md#ten-001) is resolved | Corrective migrations exist; remote unconfirmed | `supabase db diff` | **Urgent** |
| Q3 | Which server paths write `audit_logs.severity='critical'`? | Confirms audit trail actually captures critical events | Restrictive policy blocks frontend-critical writes; server writers not traced | Grep + trace all `audit_logs` inserts | High |
| Q4 | Does `organizations.plan` drive `enabled_modules`, and how? | Determines if billing tier actually gates features | No code path found linking them | Trace billing webhook + admin settings mutation paths | High |
| Q5 | Is lease-expiry/critical-date alerting currently functional post-Base44 migration? | Possible silent regression | Legacy triggers dead; no confirmed replacement | Trace `notifications` table writers; ask product owner | High |
| Q6 | What is the actual local/CI reproducibility fix for the `42501` e2e error? | Blocks all runtime verification | Local Supabase running but DB lacks grants | `supabase db reset` + grant audit | **Urgent** |
| Q7 | Do all 82 edge functions correctly scope every query by org_id? | Core of the tenancy risk | Sampled functions correct; not exhaustive | Per-function audit checklist | High |
| Q8 | Is the CAM proration calculation correct against known test cases? | Financial correctness | No dedicated tests | Build fixtures with domain-expert-verified expected output | High |
| Q9 | What does `npm audit` / a dependency scan report? | Supply-chain risk unmeasured | Not run (network-restraint in this audit) | Run in CI | Medium |
| Q10 | Are there circular imports or other structural code-quality issues at scale? | Build passes but wasn't exhaustively analyzed | `PARTIAL` — build/typecheck clean is necessary not sufficient | Static analysis tool (e.g. madge) | Low |

## Requires stakeholder or customer input

| # | Question | Category | Why it matters | Consequence of being wrong | Who answers |
|---|---|---|---|---|---|
| Q11 | Who is the actual ICP (portfolio size, buyer role)? | Product/Users | Determines packaging, sales motion, and which roadmap items matter | Building for the wrong segment wastes the roadmap | CEO/Product |
| Q12 | Is extraction accuracy measured anywhere, and how does it compare to alternatives? | Product | The core differentiation claim is unverified | Overselling a commodity feature | Product/Data |
| Q13 | How many paying customers exist, and what's retention/NPS? | Business model | Determines urgency of every other finding | Misjudging urgency across the whole roadmap | CEO |
| Q14 | Is "Trusted by 500+ commercial properties" ([PRD-002](findings-register.md#prd-002)) accurate? | Product/Legal | Credibility/legal exposure if not | Marketing/legal risk | Marketing/CEO |
| Q15 | Is there an active enterprise sales pipeline demanding SSO/SOC2 now? | Business model | Determines if [15](15-enterprise-readiness-gap-analysis.md) items are P1 or P3 | Wrong investment sequencing | Sales/CEO |
| Q16 | What's the current infra + AI-provider spend, and gross margin per customer? | Business model | Unknown margin = unknown unit economics | Can't price or forecast correctly | Finance/CTO |
| Q17 | Is a second engineer/hire planned? | Team | Single-maintainer risk (R9) | Bus-factor risk unaddressed | CEO/CTO |
| Q18 | What data-processing agreements exist with AI providers (Vertex/Azure/Anthropic/Docling)? | Compliance | GDPR/enterprise-security-review readiness | Blocks EU or security-conscious deals | Legal |
| Q19 | Is data residency (EU/regional) a near-term requirement? | Compliance | Determines if multi-region investment is warranted | Premature or too-late infra investment | Sales/Legal |
| Q20 | Which of the three strategic paths ([17](17-billion-dollar-saas-evolution.md)) does leadership actually intend to pursue? | Strategy | The codebase is currently drifting toward all three by default | Continued unfocused investment | CEO/CTO |

Related: [17 — Strategic assessment](17-billion-dollar-saas-evolution.md) · [18 — Meeting prep](18-cto-ceo-meeting-preparation.md)
