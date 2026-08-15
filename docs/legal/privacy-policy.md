# Privacy Policy

**Product:** ProForma OS
**Operator:** Mindful Tech Solutions Inc ("Company," "we," "us," or "our")
**Effective Date:** [INSERT EFFECTIVE DATE]
**Last Updated:** August 14, 2026

> **⚠️ DRAFT — ATTORNEY REVIEW REQUIRED BEFORE PUBLICATION**
> This document was AI-drafted to a professional standard at the product team's request. It is **not** legal advice and has **not** been reviewed by a licensed attorney or privacy counsel. Before publishing, counsel must review this against your actual data flows (verify every subprocessor and retention period against reality — do not publish claims that aren't true), and confirm CCPA/GDPR obligations actually triggered by your customer base. Bracketed items like `[INSERT ...]` must be completed. This Privacy Policy should be read together with our [Terms of Service](./terms-of-service.md).

---

## 1. Scope and Overview

This Privacy Policy explains how Mindful Tech Solutions Inc collects, uses, discloses, and protects personal information in connection with ProForma OS (the "Service") — a commercial real estate financial management platform that performs AI-assisted lease abstraction, expense tracking, CAM reconciliation, budgeting, and portfolio reporting.

This Policy applies to:
- **Customers** — the organizations (property owners, asset managers, accounting firms) that subscribe to the Service, and their authorized users; and
- **Data Subjects** — individuals whose personal information may appear *within* Customer Data uploaded to the Service (for example, tenant contacts, guarantors, or property personnel named in a lease).

Where we process personal information on behalf of a Customer as part of delivering the Service (e.g., tenant names appearing in an uploaded lease), we act as a **service provider / processor**, and the Customer is the **business / controller** responsible for that data under applicable law. Our contractual terms with Customers (including any Data Processing Addendum) govern that relationship; this Policy separately describes how we handle personal information as a **business/controller in our own right** — namely, data about our Customers' authorized users (account holders) and website visitors.

*[Note to counsel: confirm this controller/processor split is accurate and reflected consistently — consider whether a standalone DPA already covers processor obligations in more detail and whether this Policy should more explicitly deconflict from it.]*

## 2. Information We Collect

### 2.1 Information You Provide Directly

| Category | Examples |
|---|---|
| Account information | Name, work email, password (hashed), company name, role |
| Billing information | Billing address, payment method (processed by Stripe — we do not store full card numbers) |
| Support communications | Content of support tickets, emails, or chat messages |
| Customer Data you upload | Lease documents (PDF/DOCX), property records, expense records, budget data, and any personal information contained within them (e.g., tenant or guarantor names, contact details) |

### 2.2 Information Collected Automatically

| Category | Examples |
|---|---|
| Usage data | Pages/features accessed, actions taken, timestamps, session duration |
| Device/log data | IP address, browser type, operating system, device identifiers |
| Cookies and similar technologies | Session cookies (authentication), analytics cookies, preference cookies — see Section 9 |

### 2.3 Information from Third Parties

| Source | Purpose |
|---|---|
| Stripe | Payment confirmation, subscription status, fraud signals |
| UPS Address Validation API | Verification/standardization of property addresses you enter |
| Azure Document Intelligence | Returns structured/OCR output from documents you upload (does not add new personal information about you, but processes what's in your uploaded documents) |
| OpenAI | Returns extracted structured fields from document text you submit |

*[Note to counsel: confirm no additional data enrichment sources (e.g., analytics/ad platforms) are in use before finalizing — if Google Analytics, PostHog, Sentry, etc. are integrated, they must be added here with their own disclosure.]*

## 3. How We Use Information

We use personal information to:

1. Provide, operate, and maintain the Service, including running the AI-assisted lease extraction pipeline, expense/CAM reconciliation, and reporting features;
2. Process payments and manage subscriptions;
3. Authenticate accounts and enforce tenant/workspace data isolation;
4. Send transactional communications (approval notices, critical-date alerts, invoices, security notices) via Resend;
5. Provide customer support;
6. Monitor, secure, and improve the Service, including debugging and abuse/fraud prevention;
7. Comply with legal obligations, respond to lawful requests, and enforce our Terms of Service; and
8. With your consent or as permitted by law, send product updates or marketing communications (you may opt out at any time).

We do **not** sell personal information, and we do not use Customer Data (including document content) to train AI/foundation models made available to other customers or third parties, except with your prior written consent. See Section 6.

## 4. Legal Bases for Processing (EEA/UK Users)

Where the GDPR or UK GDPR applies, we rely on the following legal bases:

| Purpose | Legal Basis |
|---|---|
| Providing the Service under contract with a Customer | Performance of a contract (Art. 6(1)(b)) |
| Security, fraud prevention, service integrity | Legitimate interests (Art. 6(1)(f)) |
| Billing and tax recordkeeping | Legal obligation (Art. 6(1)(c)) |
| Marketing communications | Consent (Art. 6(1)(a)), withdrawable at any time |

Where we process personal information contained in Customer Data (e.g., tenant details in a lease) on behalf of a Customer, the Customer determines the legal basis as controller, and our processing is governed by the applicable Data Processing Addendum.

## 5. How We Share Information

We share personal information only as follows:

**5.1 Subprocessors / Service Providers**, under contractual confidentiality and data protection obligations:

| Subprocessor | Purpose | Data Involved |
|---|---|---|
| Supabase | Database hosting, authentication, file storage | All account and Customer Data |
| Azure Document Intelligence (Microsoft) | Document parsing / OCR | Uploaded lease documents |
| OpenAI | LLM-based structured field extraction | Text extracted from uploaded documents |
| Stripe | Payment processing, billing | Billing contact and payment data |
| Resend | Transactional email delivery | Name, email address, notification content |
| UPS | Address validation | Property address data |
| [INSERT: hosting provider, e.g., Vercel] | Frontend hosting | Usage/log data |

A current, maintained Subprocessor List is available at [INSERT SUBPROCESSOR LIST URL]. We will provide notice of material changes to this list as described in our Data Processing Addendum.

**5.2 Legal and Safety Disclosures.** We may disclose information to comply with a valid legal process (subpoena, court order, regulatory request), to enforce our Terms, or to protect the rights, property, or safety of the Company, our users, or others, consistent with Section 11 of our Terms of Service (Legal Hold).

**5.3 Business Transfers.** If we are involved in a merger, acquisition, financing, or sale of assets, personal information may be transferred as part of that transaction, subject to standard confidentiality protections and notice to affected Customers where required by law.

**5.4 With Your Direction.** We share information with other parties when you direct us to (e.g., inviting a colleague to your Workspace, or exporting a report to send to a third party).

We do not share personal information with third parties for their own independent marketing purposes, and we do not sell personal information as defined under the CCPA.

## 6. AI Processing Disclosure

To provide lease abstraction and related features, uploaded documents (and personal information they may contain, such as tenant or guarantor names) are transmitted to:

- **Azure Document Intelligence**, to convert document images/PDFs into structured text via OCR; and
- **OpenAI**, to extract structured lease fields from that text using large language models (JSON mode).

These providers process data under their respective enterprise/API terms, which — as of the effective date of this Policy — restrict use of API-submitted data for model training absent separate agreement. [INSERT: link to or confirm current OpenAI/Azure enterprise data-use terms with counsel before publishing this claim; provider policies change and must be verified, not assumed.]

Extracted output is presented to you for human review and approval before being treated as an authoritative record — see Section 6 of our Terms of Service for the corresponding liability terms.

## 7. Data Retention

| Data Category | Retention Period |
|---|---|
| Account data | Duration of your subscription, plus [INSERT PERIOD] after account closure for legal/audit purposes |
| Customer Data (leases, financial records) | Duration of your subscription; available for export for [INSERT PERIOD, e.g., 30 days] after termination, then deleted per our retention schedule |
| Billing records | [INSERT PERIOD, e.g., 7 years] to comply with tax and accounting obligations |
| Support communications | [INSERT PERIOD] |
| Backups | Rolling [INSERT PERIOD] backup window; deleted data may persist in backups until they are overwritten |
| Data subject to legal hold | Retained until the hold is lifted, per Section 11 of our Terms of Service |

*[Note to counsel: retention periods must be confirmed against actual backend configuration (e.g., Supabase backup windows, the release-10 legal hold policy referenced in the codebase) — do not publish invented numbers.]*

## 8. Your Privacy Rights

### 8.1 For All Users
You may access, correct, or request deletion of your account information through your account settings or by contacting [INSERT PRIVACY CONTACT EMAIL]. Note that if you are an end user whose data was uploaded by one of our Customers (e.g., a tenant named in a lease), you should direct your request to that Customer, who controls that data; we will support the Customer in fulfilling such a request under our Data Processing Addendum.

### 8.2 California Residents (CCPA/CPRA)
Subject to CCPA/CPRA, California residents have the right to:
- Know what personal information we collect, use, and disclose;
- Delete personal information, subject to exceptions;
- Correct inaccurate personal information;
- Opt out of "sale" or "sharing" of personal information (we do not sell or share personal information as those terms are defined by the CCPA);
- Limit use of sensitive personal information; and
- Non-discrimination for exercising these rights.

To exercise these rights, contact [INSERT PRIVACY CONTACT EMAIL] or [INSERT WEB FORM LINK IF ANY]. We will verify your request using information associated with your account before responding.

### 8.3 EEA/UK Residents (GDPR)
Subject to the GDPR/UK GDPR, you have the right to:
- Access, rectify, or erase your personal information;
- Restrict or object to processing;
- Data portability;
- Withdraw consent at any time where processing is based on consent; and
- Lodge a complaint with your local supervisory authority.

To exercise these rights, contact [INSERT PRIVACY CONTACT EMAIL / EU REPRESENTATIVE IF REQUIRED UNDER ART. 27].

*[Note to counsel: confirm whether an EU/UK representative appointment under Art. 27 GDPR is required based on actual EU customer volume, and whether a Data Protection Officer designation is triggered.]*

### 8.4 Other Jurisdictions
[INSERT: if you have customers in other states with comprehensive privacy laws — e.g., Virginia, Colorado, Connecticut, Utah — add corresponding rights sections or a general "other applicable law" clause with counsel.]

## 9. Cookies and Tracking Technologies

We use cookies and similar technologies for:

| Type | Purpose | Can You Disable? |
|---|---|---|
| Strictly necessary (session/auth) | Keep you logged in, enforce security | No — required for the Service to function |
| Preference | Remember settings (e.g., display preferences) | Yes, via browser settings |
| Analytics | Understand feature usage to improve the Service | Yes, via [INSERT: cookie banner/opt-out mechanism if implemented] |

[INSERT: confirm actual analytics tooling in use, e.g., PostHog/Sentry/Google Analytics, and add a cookie consent banner if serving EEA/UK users, as strictly required cookies alone typically do not require consent but analytics cookies do under ePrivacy rules.]

## 10. International Data Transfers

Our infrastructure and subprocessors may process and store data in the United States and other countries. Where we transfer personal information out of the EEA, UK, or Switzerland, we rely on appropriate safeguards, such as the European Commission's Standard Contractual Clauses (SCCs) or the UK International Data Transfer Addendum, as further described in our Data Processing Addendum available at [INSERT DPA LINK].

## 11. Data Security

We implement administrative, technical, and physical safeguards designed to protect personal information, including:

- Encryption of data in transit (TLS) and at rest;
- Row-level security policies enforcing tenant/workspace data isolation at the database layer;
- Role-based access controls limiting internal access to Customer Data;
- Authentication protections, including support for multi-factor authentication.

No method of transmission or storage is completely secure. In the event of a data breach affecting your personal information, we will notify affected Customers and/or individuals as required by applicable law.

## 12. Children's Privacy

The Service is intended for business use by adults and is not directed to individuals under 16. We do not knowingly collect personal information from children. If you believe a child has provided us personal information, contact [INSERT PRIVACY CONTACT EMAIL] and we will take steps to delete it.

## 13. Changes to This Policy

We may update this Privacy Policy from time to time. For material changes, we will provide notice via email or in-app notification at least [INSERT NOTICE PERIOD] before the changes take effect. The "Last Updated" date at the top of this Policy reflects the most recent revision.

## 14. Contact Us

For privacy questions, access/deletion requests, or complaints:

Mindful Tech Solutions Inc
[INSERT MAILING ADDRESS]
[INSERT PRIVACY CONTACT EMAIL]

If you are an EEA/UK resident and believe we have not adequately addressed your concern, you have the right to lodge a complaint with your local data protection supervisory authority.

---

## Drafting Notes (remove before publishing)

1. **Verify every factual claim against reality before publishing** — this draft assumes the subprocessor list, retention periods, and provider training-data terms based on the product's README and prior conversation context. Legal/engineering must confirm each row in Sections 5.1 and 7 against actual configuration (e.g., check `docs/` deployment/runbook files and the `legal-hold-policy.ts` referenced in the codebase) before this is published as a factual representation to users — an inaccurate privacy policy is itself a legal and regulatory risk (FTC Section 5, state UDAP statutes).
2. **Missing companion pieces:** this Policy assumes a separate Data Processing Addendum (DPA) exists for controller/processor obligations under GDPR — that DPA has not yet been drafted. It also assumes a cookie consent mechanism if you serve EEA/UK traffic, which should be confirmed as implemented (or built) before claiming cookie choice/consent in Section 9.
3. **Placeholders to complete:** effective date, privacy contact email, mailing address, all retention periods, notice periods, subprocessor list URL, DPA URL, and confirmation of any additional analytics/monitoring tools in actual use.
4. **Cross-check with Terms of Service:** keep this Policy and [terms-of-service.md](./terms-of-service.md) in sync — both currently reference the same not-yet-drafted DPA and Subprocessor List; draft those next so the cross-references resolve to real documents.
