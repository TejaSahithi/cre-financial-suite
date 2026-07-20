# 18 — CTO/CEO Meeting Preparation

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

**Read order:** the [one-page cheat sheet](#one-page-meeting-cheat-sheet) is the primary tool for the meeting itself — read it first and keep it open. Everything else in this document is preparation depth behind it.

---

## One-page meeting cheat sheet

**Ten facts to know**
1. Overall maturity **2.8/5** by a defined 14-dimension rubric, weighted by module criticality ([03](03-module-catalog-and-maturity.md)).
2. Build/typecheck/lint clean; **685/685 unit tests pass**; the one e2e spec currently fails locally on a DB-permissions error ([evidence-index](evidence-index.md)).
3. 163 tables, 216 migrations, 82 edge functions, 71 pages — a large, actively-evolved backend for a small team.
4. **Production deployment state is unverified** — the prior self-audit found migrations/functions undeployed; this audit was prohibited from checking the remote ([OPS-005](findings-register.md#ops-005)).
5. The remote database **drifted outside migration history at least once**, including a permissive policy that defeated tenant-permission gating — corrected in-repo ([TEN-001](findings-register.md#ten-001)).
6. Tenant isolation is real but asymmetric: browser traffic is DB-enforced (RLS); all 82 server functions run with RLS bypassed ([SEC-001](findings-register.md#sec-001)).
7. **Zero CI/CD, zero production monitoring** — the single biggest operational gap ([OPS-001](findings-register.md#ops-001), [OPS-002](findings-register.md#ops-002)).
8. The lease-review module is the strongest part of the product (3.3/5, best-tested) — a genuine differentiator, not a commodity AI wrapper.
9. No workflow could be verified end-to-end in this audit's environment — everything beyond UI rendering is static analysis (E3), not runtime proof.
10. Billing has zero test coverage and unclear plan→feature-entitlement linkage — a revenue-path risk.

**Ten risks to disclose**
R1 unverified prod state · R2 schema drift recurrence · R3 cross-tenant leak via a missed org filter (none found, but no DB backstop) · R4 no monitoring → invisible incidents · R5 no CI → unnoticed regressions · R6 unthrottled public endpoints (spam/AI-cost abuse) · R7 internal-secret reuses the service-role key · R8 seed-mode can silently discard writes in prod misconfig · R9 single-maintainer key-person risk · R10 SSO/SOC2/SLA absence blocks enterprise deals. (Full register: [20](20-risk-register.md).)

**Ten proposed improvements (near-term, sequenced)**
Verify prod deployment · reconcile schema drift · fix local dev/e2e · stand up CI · add Sentry + uptime · rate-limit public endpoints · declare all edge functions in config.toml · hard-fail prod build on missing env · cross-tenant test suite · billing test coverage. (Full roadmap: [16](16-product-and-technical-roadmap.md).)

**Five decisions needed from leadership**
1. Authorize immediate remote-state verification + drift reconciliation (blocking everything else).
2. Commit engineering time to the 0–30-day stabilization list before new features.
3. Decide the strategic path (focused vertical vs. horizontal vs. platform — [17](17-billion-dollar-saas-evolution.md)) — currently the codebase is building toward all three simultaneously by default, not by decision.
4. Set risk appetite for the RLS-bypass asymmetry: accept with tests, or invest in a DB-level backstop.
5. Decide whether enterprise identity (SSO/SAML) is a next-quarter bet or waits for pipeline evidence.

**Five metrics to introduce**
Extraction pipeline success rate · onboarding funnel conversion by step · AI cost per tenant per month · production error rate (once monitoring exists) · test coverage trend (once measured).

**Five questions likely to expose weaknesses**
"Is production actually deployed right now?" · "Show me the test that proves org A can't see org B's leases." · "What happens today if Vertex AI is down for an hour?" · "Who gets paged if the site goes down at 2am?" · "What's our extraction accuracy rate, measured how?"

---

## Executive briefing

**Purpose:** AI-assisted commercial lease abstraction feeding CRE financial operations (CAM, budgeting, variance, reporting). **Architecture:** React SPA + single Supabase project (Postgres/Auth/Storage/Edge Functions), no gateway, no queue infra beyond a durable job table. **Main workflows:** signup→onboarding→approval, lease upload→AI extraction→human review→approval, CAM/budget/variance computation, billing via Stripe. **Maturity:** 2.8/5 overall; strongest = lease review (3.3) and auth (3.3); weakest = notifications and integrations (2.0 each). **Highest risks:** unverified prod state, schema-drift recurrence, zero monitoring, zero CI. **Enterprise blockers:** SSO/SAML/SCIM, SOC 2, SLAs, tested DR — all missing. **Recommended priorities:** the 0–30-day list above. **Decisions needed:** the five above.

## Likely CTO/CEO questions

Each answer: evidence-based, with confidence level and — where relevant — the uncomfortable truth stated plainly, plus a recommended follow-up.

### Top 20 — most likely to be asked

**1. Is production actually live and working right now?**
Unverified by this audit (prohibited from remote access); the prior self-audit found it wasn't fully deployed. **Confidence: Low (until checked). Uncomfortable truth:** we cannot currently answer this with certainty. **Follow-up:** run the DEPLOY.md checklist today.

**2. How many customers/tenants do we actually have?**
Not derivable from the repository — this is operational/business data, not code. **Confidence: N/A — stakeholder question.**

**3. Is our data properly isolated between customers?**
Structurally yes for browser traffic (RLS); for the 82 server functions, isolation relies on consistent code discipline with no database backstop. No leak found in static review. **Confidence: Medium.** [SEC-001](findings-register.md#sec-001). **Follow-up:** build the cross-tenant test suite (M effort) before this question gets asked by a security reviewer instead.

**4. Why does the audit log matter and can we trust it?**
It's well-designed (severity, source, before/after) but its own migration history documents a real prior drift incident. **Confidence: High** (the drift is documented in-repo). [TEN-001](findings-register.md#ten-001).

**5. What happens if a customer uploads 10,000 leases at once?**
Unmeasured. No load testing, no per-tenant rate limits, no cost metering. **Confidence: Medium (absence confirmed, impact inferred).** [OPS-006](findings-register.md#ops-006)/[OPS-007](findings-register.md#ops-007). **Follow-up:** load test the pipeline.

**6. What's our test coverage?**
No numeric coverage tool exists. 685 unit tests pass; concentrated in the lease domain; billing has zero tests. **Confidence: High** (E1 verified). [13](13-testing-and-quality-engineering.md).

**7. Do we have CI/CD?**
No. Nothing gates merges to main. **Confidence: High.** [OPS-001](findings-register.md#ops-001). **Uncomfortable truth:** this is a same-day fix that hasn't been done.

**8. Would we know if the site went down?**
No — zero monitoring/alerting exists. **Confidence: High.** [OPS-002](findings-register.md#ops-002).

**9. What's our biggest security risk?**
The RLS-bypass asymmetry combined with no automated cross-tenant testing — not a known exploit, but an unverified assumption at 82-function scale. **Confidence: Medium.** [SEC-001](findings-register.md#sec-001).

**10. Are we SOC 2 ready?**
No — no compliance scaffolding exists yet; this audit is effectively the first artifact toward one. **Confidence: High.** [11 §4](11-security-privacy-and-compliance.md).

**11. Can we sell to enterprise customers today?**
Not without SSO/SAML at minimum — universal procurement gate. **Confidence: High.** [15](15-enterprise-readiness-gap-analysis.md).

**12. Is the AI extraction accurate?**
Not measured anywhere in the repository — no accuracy benchmarks, no labeled eval set found. **Confidence: N/A — needs product/data team input.** MARKET-VALIDATION-REQUIRED.

**13. What's our AI/infra cost per customer?**
Unknown — no per-tenant metering. **Confidence: High (absence confirmed).** [OPS-007](findings-register.md#ops-007).

**14. How long would it take to recover from a database failure?**
Untested. Platform backups assumed but restore has never been drilled per repo evidence. **Confidence: Medium.** [12](12-reliability-scalability-and-operations.md).

**15. Who is the single point of failure on this codebase?**
Git history suggests one primary author; no CODEOWNERS. **Confidence: Medium (inferred from commit history).**

**16. What's blocking our next enterprise deal, technically?**
SSO, SLA capability (needs monitoring first), SOC 2, tested backups — in that rough order. **Confidence: High.** [15](15-enterprise-readiness-gap-analysis.md).

**17. Is our billing/revenue path solid?**
The idempotency pattern is correct, but zero tests exist on checkout/webhook/entitlement logic — the highest-risk untested surface. **Confidence: High.** modules/billing-subscriptions.md.

**18. What happens when an AI provider goes down mid-extraction?**
Handled reasonably well — per-stage timeouts, retry ≤3, durability reconciliation. This is one of the better-engineered failure paths in the product. **Confidence: High.**

**19. How fast can a new engineer get productive here?**
Frontend: fast (README + working build). Full stack: currently blocked — local e2e/DB setup is broken. **Confidence: High (E1 verified).** [OPS-003](findings-register.md#ops-003).

**20. What's the single most important thing to fix first?**
Verify production state — everything else is provisional until that's known. **Confidence: High.**

### Next 25 — deeper technical follow-ups

21. What's the actual tenancy model — schema-per-tenant or shared? *Shared DB/schema with RLS.* [10](10-multi-tenant-saas-readiness.md)
22. Why does the internal auth accept three different secret forms? *Iterative hardening; consolidation recommended.* [SEC-003](findings-register.md#sec-003)
23. How many edge functions aren't declared in config.toml, and does it matter? *37 of 82; matters most on financial-write paths.* [SEC-002](findings-register.md#sec-002)
24. Do we have a staging environment? *No.* [14](14-devops-infrastructure-and-delivery.md)
25. What's our dependency-vulnerability posture? *Unscanned — no `npm audit` in any pipeline (none exists).* [11](11-security-privacy-and-compliance.md)
26. Is customer PII sent to AI providers, and do we have DPAs? *Yes by design (lease text); DPA status unknown to this audit.* [11 §2](11-security-privacy-and-compliance.md)
27. How is the budget-generation AI fallback handled when Vertex fails? *A real heuristic estimate, not fake numbers — improved since a prior finding, though unlabeled to the user.* [DATA-001](findings-register.md#data-001)
28. Is the CAM proration math correct? *Unverified — no dedicated test suite.* modules/cam-engine.md
29. What database engine and version? *Postgres via Supabase (managed).*
30. How many total database tables and why so many? *163 — reflects a deep lease-intelligence data model plus the standard multi-tenant scaffolding.* [08](08-database-schema-and-ui-gap-analysis.md)
31. Is there an API for partners/integrations? *No public API platform exists.* [07 §6](07-api-and-gateway-architecture.md)
32. What's the plan for scaling beyond one Supabase project? *Not yet designed; not urgent at current scale.* [12](12-reliability-scalability-and-operations.md)
33. How are secrets managed and rotated? *Supabase/Vercel env stores; no rotation process found.* [14](14-devops-infrastructure-and-delivery.md)
34. What's the state of accessibility compliance? *Minimal — Radix helps, no a11y testing.* [15](15-enterprise-readiness-gap-analysis.md)
35. Do notifications/lease-expiry alerts actually fire? *Unverified — legacy trigger logic from the pre-Supabase platform appears not migrated; needs product confirmation.* modules/notifications-critical-dates.md
36. What's the largest architectural risk long-term? *The dual data-access path (direct RLS reads + service-role functions) as a permanent source of consistency burden.* [02](02-current-state-architecture.md)
37. How is multi-currency/international handled? *Not really — single currency per org assumed.* [08 §6](08-database-schema-and-ui-gap-analysis.md)
38. What happens on org deletion — is data actually gone? *Yes, hard CASCADE delete, no export-before-delete step.* [10](10-multi-tenant-saas-readiness.md)
39. Are there soft-deletes/undo anywhere? *No — deletions are permanent throughout.* [08 §3](08-database-schema-and-ui-gap-analysis.md)
40. What's the plan for data residency (EU customers)? *None yet — single-region.* [15](15-enterprise-readiness-gap-analysis.md)
41. How do we know the extraction pipeline didn't lose data on a timeout? *Explicit durability-reconciliation logic distinguishes transient failure from real loss — a genuine strength.* modules/lease-ingestion-extraction.md
42. What's our approach to feature flags / safe rollout? *Coarse `enabled_modules` per org only; no real flag system.* [15](15-enterprise-readiness-gap-analysis.md)
43. Is there a legacy system we migrated from, and is anything left behind? *Yes — Base44; dead trigger code remains, notifications may have regressed as a result.* [ARC-002](findings-register.md#arc-002)
44. How many people can currently deploy to production? *Unclear — manual CLI process, no documented access-control list for it.* [14](14-devops-infrastructure-and-delivery.md)
45. What's the browser/device support story? *Not assessed in this audit — no responsive/cross-browser test evidence found.*

### Appendix — remaining specialist questions (26–75+, by domain)

**Architecture (46–50):** Why Supabase over a custom backend? · What's the cost of migrating off Supabase if needed? · How tightly coupled is the frontend to Supabase-specific APIs? · What's the blast radius of a Supabase outage? · Is there a service mesh or is everything monolithic-by-project?

**Frontend (51–54):** Why 71 pages and is that too many? · What's the bundle-size strategy (main chunk exceeds the 500 KB warning)? · Is there a design system or ad-hoc components? · How is state management handled without Redux?

**Backend/API (55–58):** Why 82 edge functions instead of fewer, larger services? · Is there API versioning for breaking changes? · How are long-running AI calls handled within function time limits? · What's the retry/idempotency story for non-payment writes?

**Database (59–62):** Why do only 3 tables lack direct org_id, and is that actually fine? · What's the indexing strategy at scale? · Is there a data-warehouse/analytics replica planned? · How are migrations tested before applying to production?

**Multi-tenancy (63–65):** What would it take to offer dedicated-database tenancy for a large enterprise customer? · How is a "noisy neighbor" tenant prevented from degrading others? · Can we currently export one tenant's full data set?

**Security (66–69):** Has a penetration test ever been run? *No evidence found.* · What's the incident-response plan? *None documented.* · How are admin/support personnel prevented from casually browsing customer data? · Is there a bug-bounty or responsible-disclosure process?

**Reliability/Scalability (70–72):** What's our actual uptime been? *Unmeasurable — no monitoring.* · What's the capacity ceiling of the current architecture? · Is there a runbook for a "we're down" scenario?

**Testing/DevOps (73–75):** Why is there only one e2e test? · What's the branching/release strategy? · Is there a rollback procedure for a bad function deploy?

**Cost/Team (76–78):** What's our current infra cost run-rate? *Not in repo scope.* · What's the team structure and is it sustainable at one primary contributor? · What's the technical-debt-vs-features time allocation?

**Competition/Monetization (79–81):** How do we compare to Yardi/MRI/AppFolio's AI features? *MARKET-VALIDATION-REQUIRED, no repo evidence.* · Is pricing usage-based, seat-based, or property-based today? · What's our gross margin per customer? *Unknown — no cost metering.*

---

## Questions I should ask the CTO/CEO (leadership-facing, not evidence-answerable)

**Target customer & positioning:** Who is the actual ICP today — a specific property count/portfolio size, or anyone? Is CRE lease abstraction the whole product or the wedge into something bigger?
**Revenue model:** Is pricing decided, or still being discovered? Is usage-based pricing (AI cost-driven) the intended long-term model?
**Enterprise ambition:** Are we actively in an enterprise sales cycle today, or is SSO/SOC2 investment anticipatory?
**Risk appetite:** Given the RLS-bypass asymmetry, is the acceptable answer "add tests" or "add a database backstop"? These have very different cost/timeline profiles.
**Architecture investment:** Is there budget/headroom for the 1–3 month foundation work, or does it compete directly against a committed feature roadmap?
**Security expectations:** Is a SOC 2 audit already promised to a customer/prospect, or is this discretionary?
**Hiring:** Is a second engineer planned, given the single-maintainer risk this audit inferred from commit history?
**Timeline & funding:** What's the runway, and does it accommodate a 0–3 month stabilization phase before new feature work?
**Technical-debt tolerance:** Is "ship fast, fix later" still the operating mode, or is this the moment to shift toward the enterprise-readiness posture?
**Build vs. buy:** For SSO, monitoring, and billing entitlements specifically — build in-house or adopt a vendor (WorkOS, Sentry, Stripe Billing/Entitlements)?
**Market validation:** What evidence exists (even anecdotal) that extraction accuracy or CAM correctness is a real differentiator versus competitors?
**Success metrics:** What does leadership currently use to judge whether the product is working — anything beyond usage of the code itself?

## Meeting presentation outlines

**5-minute version:** One-page cheat sheet, read in order (facts → risks → improvements → decisions).
**15-minute version:** Add the executive briefing paragraph + the top-5 CTO questions (1, 3, 7, 9, 20) + the three strategic paths' one-line summaries ([17](17-billion-dollar-saas-evolution.md)).
**30-minute version:** Add the module heat map ([03](03-module-catalog-and-maturity.md)), the top-10 risk table ([20](20-risk-register.md)), and walk the 0–30/1–3/3–6 month roadmap tiers ([16](16-product-and-technical-roadmap.md)), closing with the "questions to ask leadership" section above as a discussion starter.
