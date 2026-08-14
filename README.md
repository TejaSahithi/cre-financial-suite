# ProForma OS

A full-stack commercial real estate (CRE) financial management platform that automates lease abstraction, expense tracking, CAM reconciliation, budget creation, and portfolio reporting — replacing manual spreadsheet workflows with an AI-assisted, approval-gated pipeline.

---

## What the Platform Does

Property owners, asset managers, and accountants use ProForma OS to:

- **Upload a lease PDF** and have the system extract every material term (parties, rent, dates, CAM, security deposit, lease type, etc.) using a hybrid AI + rule-based pipeline, then review and approve the abstract in a structured workflow.
- **Track operating expenses** against lease-backed recovery rules, classify them automatically, and flag discrepancies before they reach the ledger.
- **Reconcile CAM charges** at year-end by comparing budgeted vs. actual operating expenses across the tenant pool, generating per-tenant true-up statements.
- **Build and review annual budgets** from approved lease abstracts, recovery rule templates, and historical actuals.
- **Monitor critical dates** (renewals, expirations, notice deadlines) across the entire portfolio with automated alerting.
- **Generate reports** (rent rolls, variance analysis, expense projections, revenue forecasts) and export them to Excel or PDF.

---

## Product Architecture

```
Browser (React SPA)
        │
        ▼
Supabase Auth + Postgres (RLS-enforced)
        │
        ▼
Supabase Edge Functions (Deno/TypeScript)   ←→   Azure Document Intelligence
        │                                          (document parsing + OCR)
        │                                    ←→   OpenAI (LLM field extraction)
        ▼
        │──── Stripe (billing / subscription)
        │──── Resend (transactional email)
        └──── UPS Address Validation API
```

---

## Tech Stack

### Frontend

| Layer | Technology |
|---|---|
| Framework | React 18 |
| Build tool | Vite 6 |
| Routing | React Router DOM v6 |
| Server state | TanStack React Query v5 |
| Forms | React Hook Form + Zod validation |
| UI components | Radix UI primitives (full suite) |
| Styling | Tailwind CSS v3 + tailwind-merge |
| Charts | Recharts |
| Animations | Framer Motion |
| PDF viewer | PDF.js (pdfjs-dist) |
| DOCX parsing | Mammoth |
| Excel export/import | SheetJS (xlsx) |
| Map display | React Leaflet |
| Rich text | React Quill |
| Drag-and-drop | @hello-pangea/dnd |
| Notifications | Sonner + React Hot Toast |
| Payments (UI) | Stripe React Elements |
| PDF generation | jsPDF + html2canvas |
| Date utilities | date-fns + moment |

### Backend

| Layer | Technology |
|---|---|
| Database | PostgreSQL via Supabase |
| Auth | Supabase Auth (email, magic link, MFA) |
| Edge functions | Deno / TypeScript (60+ functions) |
| ORM / queries | Supabase JS client v2 |
| Row-level security | Postgres RLS policies on every table |
| File storage | Supabase Storage |
| Background jobs | Pipeline jobs table + polling worker |

### AI / Extraction

| Component | Technology |
|---|---|
| PDF/document parsing + OCR | Azure Document Intelligence (`prebuilt-layout`) |
| LLM field extraction | OpenAI (`gpt-4o-mini`, JSON mode) |

### Infrastructure / Services

| Service | Purpose |
|---|---|
| Supabase (hosted) | Database, auth, storage, edge runtime |
| Vercel | Frontend hosting (vercel.json in repo) |
| Stripe | Subscription billing and checkout |
| Resend | Transactional email (invites, approvals, alerts) |
| UPS API | Address validation on property entry |

---

## Extraction Pipeline (Lease Abstraction)

Uploading a lease triggers a deterministic, multi-step pipeline:

```
1. upload-handler       — accepts file, creates uploaded_files row
2. ingest-file          — dispatches to parse and normalize
3. parse-document-azure — Azure Document Intelligence extracts text/tables (including scanned pages)
4. normalize-pdf-output — runs 6-step extraction pipeline:
       Step 0: Normalize OCR text (noise removal, dedup, whitespace)
       Step 1: Rule-based extraction (regex + label:value patterns)
       Step 2: Table extraction (structured tables → fields)
       Step 3: LLM extraction (OpenAI — only for fields missed by steps 1+2)
       Step 4: Merge (rule confidence 0.95 > table 0.85 > LLM 0.70)
       Step 5: Validate (type checks, enum membership, range constraints)
       Step 6: Calculate derived fields (annual rent = monthly × 12, etc.)
5. lease-extraction-worker — orchestrates timeouts, retries, status updates
6. compute-lease         — finalizes lease record with approved abstract
```

Fields extracted include: tenant name, landlord name, property address, suite number, lease type, commencement date, expiration date, monthly rent, annual rent, rent per SF, square footage, security deposit, CAM terms, permitted use, renewal options, escalation rate, broker name, and 50+ more.

Every field carries: `source_page`, `source_text_exact`, `evidence_type`, `confidence_score`, `derivation_trace`, `validation_errors`, and `requires_review` flags before it is stored.

---

## Core Modules

### Lease Management
- **Upload** — drag-and-drop or file picker; PDF and DOCX supported
- **Extraction pipeline** — AI-assisted with deterministic first pass
- **Lease Review** — field-by-field review table with source evidence highlighting, page links, and confidence scores; grouped by tab (Parties, Dates, Rent, Expenses, CAM, Insurance, Legal)
- **Expense Rules** — auto-extracted CAM/operating expense clauses with recovery method, allocation basis, and CAM eligibility
- **Clause Records** — verbatim extracted clauses (security deposit, renewal option, use clause, default, etc.)
- **Approval workflow** — reviewer accepts/edits/rejects each field; gated approval writes a signed abstract snapshot
- **Critical Dates** — renewal notices, expiration dates, option exercise deadlines with calendar alerts

### Expense Management
- Manual and bulk-import expense entry
- AI-assisted category classification against lease expense rules
- Variance analysis (actual vs. budget vs. prior year)
- Expense review queue with approval routing
- Vendor profiles and GL chart of accounts

### CAM Reconciliation
- CAM setup per property (pool, allocations, caps, gross-up)
- Year-end reconciliation: compare budgeted CAM vs. actual operating expenses
- Per-tenant pro-rata share computation
- True-up statements with billing export

### Budget
- AI-assisted budget generation from lease abstracts + historical actuals
- Line-item review with variance commentary
- Approval workflow with version history
- Rent schedule and recovery rule integration

### Analytics & Reporting
- Portfolio dashboard — occupancy, NOI, rent roll, key metrics
- Rent roll reports with expiration schedule
- Expense projections and actuals comparison
- Revenue forecasting
- Variance reports (budget vs. actual)
- Excel and PDF export for all major reports

### Portfolio & Property Management
- Multi-property, multi-building support
- Building and unit inventory with floor plans
- Tenant roster with lease cross-linking
- Property detail with map view

### Platform Administration
- Multi-tenant organization model with invite-based onboarding
- Role-based access control (super admin, org admin, reviewer, read-only)
- Audit log for every approval action
- Custom fields per module
- Field mapping rules for bulk import
- Integrations page (API key management)

---

## Edge Functions Reference

All backend logic runs as Supabase Edge Functions (Deno, TypeScript). Key functions:

| Function | Purpose |
|---|---|
| `upload-handler` | Receives uploaded files, stores in Supabase Storage |
| `ingest-file` | Dispatches parse → normalize pipeline |
| `parse-document-azure` | Extracts text and tables via Azure Document Intelligence |
| `parse-file` | Native PDF text extraction fallback |
| `normalize-pdf-output` | Runs the full 6-step extraction pipeline |
| `lease-extraction-worker` | Background orchestrator with timeout handling |
| `approve-lease-workflow` | Validates and persists signed lease abstract |
| `approve-lease-expense-rule` | Approves individual expense rules |
| `reject-lease-expense-rule` | Rejects and records reason |
| `publish-lease-expense-rule-to-cam` | Promotes approved rules to CAM pool |
| `compute-lease` | Computes derived lease financials post-approval |
| `compute-expense` | Aggregates and categorizes expense data |
| `compute-cam` | Runs CAM reconciliation calculations |
| `compute-budget` | Generates budget from lease + expense data |
| `compute-revenue` | Forecasts revenue from rent schedules |
| `compute-reconciliation` | Year-end true-up computation |
| `generate-budget` | AI-assisted budget line-item generation |
| `store-data` | Persists pipeline output to normalized DB tables |
| `send-invite` / `invite-user` / `invite-client` | Org invitation flows |
| `signup` / `first-login` | Auth onboarding |
| `export-data` | Bulk data export to Excel/CSV |
| `send-email` | Transactional email via Resend |
| `create-checkout-session` / `stripe-webhook` | Stripe billing integration |
| `validate-address-ups` | Property address validation |
| `pipeline-health-check` / `pipeline-status` | Extraction monitoring |

---

## Database Overview

PostgreSQL via Supabase. Every table is RLS-protected — users only see rows belonging to their organization. Key tables:

| Table | Description |
|---|---|
| `organizations` | Top-level tenant (org) |
| `properties` | CRE properties (address, type, GLA) |
| `buildings` | Buildings within a property |
| `units` | Leasable units within buildings |
| `leases` | Master lease record with extracted abstract JSON |
| `lease_field_reviews` | Per-field review decisions (accepted/edited/rejected) |
| `lease_expense_rules` | Extracted expense/CAM clauses per lease |
| `uploaded_files` | Raw uploaded files + pipeline output payloads |
| `pipeline_jobs` | Extraction job status and diagnostics |
| `expenses` | Operating expenses with GL code and vendor |
| `expense_categories` | Chart of accounts |
| `budgets` / `budget_line_items` | Annual budget with per-line actuals |
| `cam_pools` | CAM reconciliation pool definitions |
| `lease_critical_dates` | Renewal and notice date tracking |
| `tenants` | Tenant entities cross-linked to leases |
| `vendors` | Expense vendor profiles |
| `users` / `org_members` | Auth and role management |
| `audit_logs` | Immutable audit trail for approvals |
| `custom_fields` | User-defined fields per module |

---

## Authentication & Multi-tenancy

- Email/password login with optional MFA (TOTP)
- Magic link and invite-based registration
- Security questions as recovery factor
- Organization isolation enforced at Postgres RLS level — no cross-org data leakage is possible even with a valid JWT
- Roles: super admin, org admin, manager, reviewer, read-only
- Invite flow: org admin sends invite → recipient gets email → clicks link → completes onboarding → assigned role

---

## Key Workflows (End-to-End)

### 1. Lease Abstraction
```
Upload PDF → Extraction pipeline runs → Lease Review page shows AI output
→ Reviewer accepts / edits / rejects each field with source evidence
→ Required fields gate the Approve button
→ Approval writes a signed abstract snapshot to the DB
→ compute-lease runs and populates rent schedule, financials
→ CAM rules and critical dates are auto-populated from approved abstract
```

### 2. Expense Review
```
Expenses entered manually or bulk-imported via CSV
→ AI classifier suggests category + lease rule match
→ Reviewer approves or reclassifies
→ Approved expenses flow into budget actuals and CAM pool
```

### 3. CAM Reconciliation
```
CAM pool defined per property (inclusions, caps, gross-up %)
→ Actual operating expenses allocated to pool at year-end
→ compute-reconciliation calculates each tenant's pro-rata share
→ True-up amount (over/under) generated per tenant
→ Statements exported to Excel or sent via email
```

### 4. Budget Creation
```
Select property + fiscal year → generate-budget suggests line items
from prior-year actuals + lease recovery rules
→ Reviewer adjusts line items, adds comments
→ Approval locks the budget version
→ Budget feeds variance analysis throughout the year
```

---

## Local Development

### Prerequisites
- Node.js 20+
- Deno 1.40+
- Supabase CLI

### Setup

```bash
# Install frontend dependencies
npm install

# Start Supabase locally
supabase start

# Apply migrations
supabase db push

# Deploy edge functions (local)
supabase functions serve

# Start frontend dev server
npm run dev
```

### Required Environment Variables

```bash
# Frontend (.env)
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
VITE_STRIPE_PUBLISHABLE_KEY=<stripe-pk>

# Supabase Edge Function Secrets
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=https://<your-resource>.cognitiveservices.azure.com
AZURE_DOCUMENT_INTELLIGENCE_KEY=<azure-key>
OPENAI_API_KEY=<openai-key>
OPENAI_MODEL=gpt-4o-mini
RESEND_API_KEY=<resend-key>
STRIPE_SECRET_KEY=<stripe-sk>
STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret>
WORKER_INTERNAL_SECRET=<random-secret>
```

### Useful Commands

```bash
npm run dev          # Start frontend
npm run build        # Production build
npm run lint         # ESLint
npm run typecheck    # TypeScript check
npm run test         # Vitest unit tests

supabase functions deploy   # Deploy all edge functions
supabase db push            # Apply pending migrations
```

---

## Deployment

- **Frontend:** Vercel (config in `vercel.json`); connects to production Supabase
- **Backend:** Supabase hosted project (edge functions deployed via `supabase functions deploy`)
- **Database:** Supabase Postgres with migrations in `supabase/migrations/`
- See `DEPLOY.md` for the full production deployment checklist

---

## Project Structure

```
├── src/
│   ├── pages/               # Route-level page components (~55 pages)
│   ├── components/          # Shared and feature-specific components
│   │   └── lease-review/    # Lease review UI, validators, evidence resolvers
│   ├── services/            # API + Supabase service functions
│   ├── lib/                 # Schema definitions, field options, auth context, RBAC
│   ├── hooks/               # Custom React hooks
│   └── utils/               # Shared utility functions
├── supabase/
│   ├── functions/           # 60+ Deno edge functions
│   │   └── _shared/         # Shared extraction pipeline, normalizers, validators
│   │       └── extraction/  # Pipeline modules (rule, table, LLM, merge, validate, calculate)
│   └── migrations/          # PostgreSQL schema migrations (80+ files)
└── docs/                    # Additional documentation
```
