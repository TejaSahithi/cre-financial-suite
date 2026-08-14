# Notification Requirements and App Flow

## Purpose

This document maps where notifications are mandatory and where notifications can be incorporated in ProForma OS. It is based on the current product flow: lease abstraction, expense tracking, budget review, CAM setup/calculation, CAM reconciliation, critical dates, reporting, and administration.

The app already has a centralized `notifications` table and `Notifications` page. The recommended approach is to continue using that model for in-app notifications, with optional email delivery for time-sensitive or externally owned events.

## Existing Notification Foundation

Current notification model:

| Field | Purpose |
|---|---|
| `org_id` | Organization isolation |
| `type` | Notification category, such as `lease_expiry`, `budget_approval`, `cam_variance` |
| `title` | Short notification title |
| `message` | Human-readable detail |
| `link` | Deep link to the action screen |
| `priority` | `low`, `medium`, `high`, or current legacy `normal` |
| `is_read` | Read state for the notification center |

Existing notification producers found in the product:

| Existing event | Trigger | Current type | Current destination |
|---|---|---|---|
| Lease expiration alert | Lease end date within 180 days | `lease_expiry` | Notification Center |
| Lease ready for budget | Lease status changes to `budget_ready` | `budget_approval` | Notification Center |
| Expense variance alert | Actual expenses exceed budget by more than 10 percent | `cam_variance` | Notification Center |
| Budget submitted, reviewed, approved, locked, rework | Budget status/rework comment changes | `budget_approval` | Notification Center |
| Lease abstract approved | Lease approval workflow completes | `lease_approved` | Notification Center |
| Lease expense rule reviewed | Rule approve/reject/not-applicable workflow completes | `approval` | Notification Center |
| Lease expense rule published to CAM | Approved rule is promoted into CAM setup | `approval` | Notification Center |
| Expense classification sent to CAM | Classification send workflow completes | `approval` | Notification Center |

## Notification Priority Rules

Mandatory notifications are required when the user must act to prevent missed deadlines, wrong financial outputs, approval drift, billing errors, or workflow blockage.

Possible notifications are useful when they improve awareness, but the user can still discover the information on a dashboard or page without operational risk.

Recommended priority levels:

| Priority | Use when |
|---|---|
| High | Deadline risk, failed compute/extraction, approval blocker, variance/materiality breach, reconciliation exception |
| Medium | Review assignment, workflow handoff, budget/CAM readiness, new exception queue item |
| Low | Informational completion, exports, non-blocking suggestions, digest updates |

Recommended channels:

| Channel | Use when |
|---|---|
| In-app | All notification events |
| Email | High-priority deadlines, review assignments, approvals, rework, failed pipeline, true-up approval |
| Digest | Optional low/medium summary events grouped daily or weekly |

## Mandatory Notification Points

### 1. Access, Onboarding, and Administration

| Flow point | Trigger | Recipients | Priority | Link | Reason |
|---|---|---|---|---|---|
| Access request submitted | New access request or demo/onboarding request | Super admin, org admin | Medium | `/RequestAccess` or `/UserManagement` | Admin must approve before user can work |
| Invite accepted | Invited user completes onboarding | Org admin | Low | `/UserManagement` | Confirms account activation |
| User role or module access changed | Role, page permission, or module access changes | Affected user, org admin | Medium | `/UserManagement` | Access changes affect financial authority |
| MFA/security setup required | User reaches app without required security setup | Affected user | High | `/SecurityQuestionsSetup` | Required to protect financial data |
| Integration credential failure | Accounting/email/AI/UPS/Stripe integration fails | Org admin, integration owner | High | `/Integrations` | Downstream automation may stop |

### 2. Portfolio, Property, Building, Unit, and Tenant Master Data

| Flow point | Trigger | Recipients | Priority | Link | Reason |
|---|---|---|---|---|---|
| Required property data missing | Property lacks square footage, address, ownership, or CAM setup fields | Property manager, org admin | High | `/PropertyDetail` or `/Properties` | CAM allocations and budgets depend on property facts |
| Building/unit square footage missing | Unit/building lacks rentable square footage | Property manager | High | `/BuildingsUnits` or `/Units` | Tenant pro-rata share cannot be trusted |
| Tenant missing active lease | Tenant exists without lease link where expected | Asset manager | Medium | `/Tenants` | Billing and revenue projections need tenant-lease linkage |
| Duplicate property, unit, tenant, or vendor detected | Bulk import or manual creation identifies likely duplicate | Data owner | Medium | Relevant master-data page | Prevents duplicate spend or wrong allocation |

### 3. Lease Upload and Extraction

| Flow point | Trigger | Recipients | Priority | Link | Reason |
|---|---|---|---|---|---|
| Upload completed and extraction queued | File saved and pipeline starts | Uploader | Low | `/LeaseUpload` or `/FileHistoryPage` | Confirms intake |
| Extraction ready for review | Uploaded file reaches `review_required` or `ready_for_review` | Uploader, reviewer | High | `/LeaseReview?id={lease_id}` | Lease cannot feed budgets/CAM until reviewed |
| Extraction failed | Uploaded file status becomes `failed` | Uploader, reviewer, admin | High | `/LeaseUpload` or `/FileHistoryPage` | Blocks lease abstraction and downstream setup |
| Duplicate or suspicious file detected | Upload flagged as duplicate, wrong type, unreadable, or large-preview unavailable | Uploader | Medium | `/LeaseUpload` | Prevents reviewing the wrong document |
| Re-extraction completed | Manual re-extraction finishes | Reviewer | Medium | `/LeaseReview?id={lease_id}` | Reviewer needs to compare and apply latest extraction |
| Re-extraction failed | Latest generation fails while old payload remains | Reviewer, admin | High | `/LeaseReview?id={lease_id}` | Prevents stale approval decisions |

### 4. Lease Review and Approval

| Flow point | Trigger | Recipients | Priority | Link | Reason |
|---|---|---|---|---|---|
| Required fields unresolved | Approval blockers exist for required fields | Assigned reviewer | High | `/LeaseReview?id={lease_id}` | Approval must not proceed with missing terms |
| Low confidence fields remain | Confidence below configured threshold, currently 75 percent in review checks | Assigned reviewer | Medium | `/LeaseReview?id={lease_id}` | Reviewer must validate uncertain extraction |
| Missing source evidence | Field has value but lacks source text/page evidence | Assigned reviewer | High | `/LeaseReview?id={lease_id}` | Auditability requirement for approval |
| Lease rejected or sent back | Reviewer rejects abstract or marks critical fields manual-required | Uploader, assigned reviewer | High | `/LeaseReview?id={lease_id}` | Requires correction before downstream use |
| Lease abstract approved | `approve-lease-workflow` succeeds | Asset manager, budget owner, CAM owner | Medium | `/LeaseReview?id={lease_id}` | Approved abstract becomes system-of-record |
| Post-approval rent schedule generation failed | Approval succeeds but rent schedule generation does not | Asset manager, finance owner | High | `/RentProjection` | Revenue/budget forecast may be incomplete |
| Post-approval expense rule sync failed | Approval succeeds but expense/CAM rules are not generated or need re-extraction | CAM owner, reviewer | High | `/LeaseExpenseRules?lease={lease_id}` | CAM/budget inputs are incomplete |
| Approved lease lacks property/building/unit linkage | Lease approved with missing hierarchy link | Asset manager, property manager | High | `/LeaseDetail?id={lease_id}` | Allocation, reporting, and CAM scope can be wrong |

### 5. Critical Dates

| Flow point | Trigger | Recipients | Priority | Link | Reason |
|---|---|---|---|---|---|
| Renewal notice deadline approaching | Due date reaches configured reminder windows | Assigned owner, asset manager | High | `/CriticalDates` | Missed renewal notices create legal/financial risk |
| Option exercise deadline approaching | Due date reaches configured reminder windows | Assigned owner, asset manager | High | `/CriticalDates` | Missed option windows are material |
| Lease expiration within 180, 90, 30, 7 days | Approved lease end date approaches | Asset manager, leasing owner | High at 90 days or less | `/CriticalDates` or `/LeaseDetail?id={lease_id}` | Existing event should be extended to multiple reminder windows |
| Insurance certificate due | Insurance certificate date reaches reminder window | Property manager, tenant contact owner | Medium | `/CriticalDates` | Compliance and risk-management requirement |
| Critical date overdue | Due date passes while status is open | Assigned owner, org admin | High | `/CriticalDates` | Escalation is mandatory |
| Critical date assigned or reassigned | Owner changes | New owner | Medium | `/CriticalDates` | Owner needs direct action |

### 6. Lease Expense Rules

| Flow point | Trigger | Recipients | Priority | Link | Reason |
|---|---|---|---|---|---|
| Approved lease missing persisted expense rules | Approved lease has no generated rule rows | CAM owner, reviewer | High | `/LeaseExpenseRules` | CAM setup cannot rely on missing rules |
| Expense rule needs review | Rule set contains `needs_review`, conditional, or unresolved rows | CAM owner | Medium | `/LeaseExpenseRules?lease={lease_id}` | Rules must be approved before downstream CAM use |
| Rule approved/rejected/not applicable | Workflow action completes | CAM owner, budget owner | Medium | `/LeaseExpenseRules?lease={lease_id}` | Existing event, should use specific notification types |
| Rule published to CAM | Approved rule becomes available to CAM setup | CAM owner | Medium | `/CAMSetup` | Handoff from lease review to CAM setup |
| Rule publication failed | Publish-to-CAM workflow fails or is blocked | CAM owner, admin | High | `/LeaseExpenseRules?lease={lease_id}` | CAM setup will be incomplete |

### 7. Expense Entry, Actuals, and Expense Review

| Flow point | Trigger | Recipients | Priority | Link | Reason |
|---|---|---|---|---|---|
| Expense import completed with failures | Bulk CSV import has rejected rows | Accounting owner | High | `/BulkImport` or `/Expenses` | Missing actuals affect budgets/CAM |
| New expense requires approval | Expense created with draft or needs-review status | Accounting reviewer | Medium | `/Expenses` | Actuals should not flow until approved |
| Low-confidence or unmatched classification | Classifier outputs unmatched, exception, low confidence, or conditional | Expense reviewer | High | `/ExpenseReview` | Wrong recoverability changes CAM charges |
| Expense approved | Expense approval completed | Accounting owner, CAM owner | Low | `/Expenses` | Confirms downstream availability |
| Expense rejected or marked non-recoverable | Reviewer rejects or excludes item | Accounting owner | Medium | `/ExpenseReview` | Financial treatment changed |
| Expense classification finalized | Classification rows finalized | CAM owner | Medium | `/LeaseExpenseClassification` | Ready for projection/CAM review |
| Classification sent to CAM | Existing send-to-CAM workflow succeeds | CAM owner | Medium | `/LeaseExpenseClassification` | Existing event, mandatory handoff |
| Expense variance above 10 percent | Actuals exceed or trail budget by more than 10 percent | Property manager, budget owner, CAM owner | High above 20 percent, medium above 10 percent | `/Variance` or `/Expenses` | Existing event, mandatory financial control |

### 8. CAM Setup and CAM Calculation

| Flow point | Trigger | Recipients | Priority | Link | Reason |
|---|---|---|---|---|---|
| CAM setup missing for active property | Active property has approved leases but no CAM profile/config | CAM owner | High | `/CAMSetup` | CAM calculation cannot be trusted |
| CAM prerequisites blocked | CAM page detects no approved leases/rules, missing square footage, missing dates, or blocking review count | CAM owner | High | `/CAMCalculation` | User must fix upstream before compute |
| CAM calculation completed | `compute-cam` snapshot saved | CAM owner, budget owner | Medium | `/CAMCalculation` | Snapshot is available for review/export |
| CAM calculation failed | `compute-cam` fails | CAM owner, admin | High | `/CAMCalculation` | Blocks charge calculation |
| CAM inputs changed after snapshot | Approved expense/rule/lease/CAM profile changes after latest snapshot | CAM owner | High | `/CAMCalculation` | Existing output may be stale |
| Tenant share or cap exception detected | Pro-rata share, cap, gross-up, vacancy, or admin fee produces exception | CAM owner | High | `/CAMCalculation` | Prevents incorrect tenant charges |
| CAM packet exported | Export succeeds | CAM owner | Low | `/CAMCalculation` | Useful audit trail |

### 9. Budget Studio

| Flow point | Trigger | Recipients | Priority | Link | Reason |
|---|---|---|---|---|---|
| Lease ready for budget | Lease status changes to `budget_ready` | Budget owner | Medium | `/CreateBudget` | Existing event, mandatory handoff |
| Budget generation completed | `compute-budget` or generate-budget succeeds | Budget owner | Low | `/CreateBudget` | Budget draft is ready |
| Budget generation failed | Budget compute/generation fails | Budget owner, admin | High | `/CreateBudget` | Blocks planning cycle |
| Budget submitted for review | Status becomes `under_review` | Budget reviewer, stakeholders | High | `/BudgetReview` | Existing event, mandatory workflow handoff |
| Budget marked reviewed | Status becomes `reviewed` | Budget owner | Medium | `/CreateBudget` | Existing event, next approval step is available |
| Budget rejected/sent back for rework | Status returns to draft with rejection comment | Budget owner, stakeholders | High | `/CreateBudget` | Existing event plus email should be mandatory |
| Rework comments updated | `rejection_comment` changes | Budget owner | Medium | `/CreateBudget` | Existing event |
| Budget approved | Status becomes `approved` | Budget owner, property manager, CAM owner | High | `/BudgetDashboard` | Existing event, financial baseline is now official |
| Budget locked | Status becomes `locked` | Budget owner, accounting owner | High | `/BudgetDashboard` | Existing event, edits are blocked |
| Budget unlocked/reopened | Locked budget reopened | Org admin, budget owner | High | `/BudgetDashboard` | Material governance event |

### 10. Reconciliation and True-Up

| Flow point | Trigger | Recipients | Priority | Link | Reason |
|---|---|---|---|---|---|
| No actual expenses for reconciliation year | Reconciliation page detects no actuals for selected property/year | Accounting owner, CAM owner | High | `/Reconciliation` | Year-end true-up cannot be prepared |
| Reconciliation prerequisites incomplete | Missing CAM snapshot, approved budget, approved expenses, or active leases | CAM owner | High | `/Reconciliation` | Prevents incorrect true-up |
| Reconciliation completed | `compute-reconciliation` succeeds | CAM owner, asset manager | Medium | `/Reconciliation` | Snapshot is ready |
| Reconciliation failed | `compute-reconciliation` fails | CAM owner, admin | High | `/Reconciliation` | Year-end workflow blocked |
| Tenant true-up exceeds threshold | Tenant owes/refund amount exceeds company materiality threshold | CAM owner, asset manager | High | `/Reconciliation` | Requires review before billing |
| Refund due to tenant | Tenant adjustment is refund | CAM owner, accounting owner | High | `/Billing` or `/Reconciliation` | Cash outflow requires approval |
| Statement exported or sent | True-up statement generated or emailed | CAM owner, accounting owner | Medium | `/Reconciliation` | Confirms external communication |

### 11. Revenue, Billing, Reports, and Analytics

| Flow point | Trigger | Recipients | Priority | Link | Reason |
|---|---|---|---|---|---|
| Revenue projection failed or stale | Approved lease/rent schedule changes after snapshot | Finance owner | High | `/Revenue` or `/RentProjection` | Forecast may be wrong |
| Tenant billing export ready | Charges or true-up export generated | Accounting owner | Medium | `/Billing` | Billing can proceed |
| Payment/subscription issue | Stripe payment fails or subscription status changes | Org admin | High | `/Billing` | Platform access and billing compliance |
| Scheduled report generated | Report/export is ready | Requesting user | Low | `/Reports` | Convenience notification |
| Portfolio risk threshold breached | Occupancy, NOI, variance, or critical-date risk passes threshold | Asset manager | Medium or high | `/PortfolioInsights` | Management attention needed |

## Possible Notification Points

These are useful enhancements but should usually be configurable, digest-based, or lower priority.

| Flow point | Trigger | Suggested recipients | Priority | Link |
|---|---|---|---|---|
| Daily review queue digest | Outstanding lease, expense, budget, and CAM review counts | Reviewers, managers | Low | `/Workflows` |
| Weekly portfolio digest | Occupancy, NOI, variance, upcoming critical dates | Asset managers | Low | `/Dashboard` |
| New property/building/unit created | Master data created | Property admin | Low | Relevant detail page |
| Vendor spend concentration | Vendor exceeds spend threshold | Accounting owner | Medium | `/Vendors` |
| Duplicate vendor found | Vendor names or tax/payment data look duplicated | Accounting owner | Medium | `/Vendors` |
| Budget vs actual trend warning | Variance trending toward threshold but below hard limit | Budget owner | Medium | `/Variance` |
| CAM calculation ready to run | Inputs are complete but no current snapshot exists | CAM owner | Medium | `/CAMCalculation` |
| Export completed | Excel/PDF export is ready | Requesting user | Low | Source page |
| New integration connected | Integration setup succeeds | Org admin | Low | `/Integrations` |
| Audit log anomaly | Unusual admin action count or repeated failed writes | Super admin | Medium | `/AuditLog` |

## Exact App Flow

### Flow A: New Customer and Organization Setup

1. User lands on `/Landing`, `/RequestDemo`, `/Pricing`, or `/RequestAccess`.
2. User signs up or accepts an invite at `/AcceptInvite`.
3. User completes onboarding at `/Onboarding`, `/Welcome`, or `/WelcomeAboard`.
4. Admin configures organization settings at `/OrgSettings`.
5. Admin configures users, roles, modules, and page access at `/UserManagement`.
6. Admin configures integrations at `/Integrations`.
7. Admin configures chart of accounts and import mapping at `/ChartOfAccounts` and `/FieldMappingRules`.
8. Mandatory notifications: access request submitted, invite accepted, user access changed, integration failure.

### Flow B: Portfolio and Property Setup

1. User creates portfolio in `/Portfolios`.
2. User creates properties in `/Properties`.
3. User adds buildings and units in `/Buildings`, `/Units`, or `/BuildingsUnits`.
4. User adds tenants in `/Tenants`.
5. User can inspect property-level data at `/PropertyDetail`.
6. Mandatory notifications: missing square footage, missing property hierarchy, duplicate master data.

### Flow C: Lease Upload, Extraction, Review, and Approval

1. User uploads lease document in `/LeaseUpload`.
2. File moves through uploaded, parsing, validating, storing, computing, and review-ready states.
3. User monitors extraction at `/FileHistoryPage`.
4. When ready, user opens `/LeaseReview?id={lease_id}`.
5. Reviewer checks field evidence, confidence, validation, required fields, expense/CAM tabs, dates, and approval controls.
6. Reviewer accepts, edits, rejects, marks N/A, or marks manual-required for fields.
7. Approve button remains blocked until required blockers are resolved.
8. `approve-lease-workflow` writes approved abstract, signed version, audit log, and notification.
9. Post-approval jobs create rent schedule, critical dates, expense rules, budget inputs, and downstream snapshots where applicable.
10. Mandatory notifications: extraction ready, extraction failed, required blockers, missing evidence, low confidence, approval complete, post-approval sync failure.

### Flow D: Critical Dates

1. Approved lease fields generate critical date records or previews.
2. User reviews portfolio-wide dates in `/CriticalDates`.
3. User creates custom reminders, assigns owners, or marks items complete.
4. Reminder engine sends alerts based on due date and reminder window.
5. Mandatory notifications: 180/90/30/7-day lease expiration, renewal notice, option exercise, insurance certificate due, overdue escalation.

### Flow E: Lease Expense Rules

1. Approved leases generate lease-derived expense/CAM rules.
2. User opens `/LeaseExpenseRules`.
3. User filters needs-review, approved, rejected, not-applicable, and coverage gaps.
4. User approves, rejects, marks not applicable, or syncs approved leases missing rules.
5. Approved rules are published to CAM setup.
6. Mandatory notifications: approved lease missing rules, rule needs review, rule reviewed, publish to CAM succeeded or failed.

### Flow F: Actual Expenses and Expense Review

1. User manually adds expenses in `/AddExpense`, imports expenses in `/BulkImport`, or reviews actuals in `/Expenses`.
2. Expenses are linked to property/building/unit/tenant/lease where possible.
3. User approves actual expenses that can flow into classification.
4. User opens `/LeaseExpenseClassification` to match approved actuals against approved lease rules.
5. User finalizes classifications or sends eligible rows to CAM.
6. Exceptions are worked in `/ExpenseReview`.
7. Mandatory notifications: import failures, unmatched/low-confidence/conditional classifications, approval/rejection, sent-to-CAM, variance threshold breach.

### Flow G: CAM Setup and Calculation

1. User configures property CAM profile at `/CAMSetup`.
2. User opens `/CAMCalculation`.
3. Page validates scope, approved leases, approved rules, CAM-ready classifications, square footage, dates, and review blockers.
4. User runs `compute-cam`.
5. System saves authoritative CAM snapshot.
6. User exports CAM packet or uses outputs in budgets/reconciliation.
7. Mandatory notifications: missing CAM setup, CAM blockers, compute failure, stale snapshot, tenant cap/share exception, compute completed.

### Flow H: Budget Studio

1. User opens `/CreateBudget`.
2. User previews approved lease, expense, and CAM inputs.
3. User generates a budget draft.
4. Budget can move through draft, ai_generated, under_review, reviewed, approved, locked, signed, or sent back to draft with rework comments.
5. User reviews budget comparisons in `/BudgetReview`.
6. User monitors budget list and stakeholder sending in `/BudgetDashboard`.
7. Mandatory notifications: generation failure, submitted for review, reviewed, rejected/rework, comment update, approved, locked, reopened.

### Flow I: Reconciliation and Billing

1. User opens `/Reconciliation`.
2. User selects property and fiscal year.
3. Page previews from budgets, expenses, leases, and CAM calculations until an authoritative snapshot exists.
4. User runs `compute-reconciliation`.
5. System calculates budgeted CAM, actual CAM, variance, and tenant adjustments.
6. User exports or sends tenant true-up statements.
7. Billing owner processes charges/refunds in `/Billing`.
8. Mandatory notifications: missing actuals, incomplete prerequisites, reconciliation failed/completed, tenant true-up above threshold, refund due, statement sent.

### Flow J: Reporting and Ongoing Monitoring

1. Users monitor `/Dashboard`, `/AnalyticsReports`, `/Analytics`, `/Reports`, `/PortfolioInsights`, `/ActualsVariance`, `/Variance`, `/Comparison`, `/Revenue`, and `/RentProjection`.
2. Users export reports as Excel/PDF.
3. System sends optional digests and threshold notifications.
4. Mandatory notifications only apply when reports expose stale snapshots, high-risk thresholds, or failed scheduled outputs.

## Recommended Notification Types

The current `type` values mix workflow types and generic `approval`. For implementation clarity, introduce stable names:

| Type | Example use |
|---|---|
| `access_request` | Access request submitted |
| `integration_failure` | External service credential or call failure |
| `lease_extraction_ready` | Lease ready for review |
| `lease_extraction_failed` | Extraction failed |
| `lease_review_blocker` | Required field, evidence, confidence, or related-document blocker |
| `lease_approved` | Lease abstract approved |
| `lease_post_approval_failed` | Rent schedule/rule/critical-date sync failed |
| `critical_date_due` | Reminder window hit |
| `critical_date_overdue` | Deadline passed |
| `lease_expiry` | Lease expiration alert |
| `expense_review_required` | Expense or classification exception |
| `expense_variance` | Actuals exceed variance threshold |
| `expense_sent_to_cam` | Classification sent to CAM |
| `lease_rule_review` | Lease expense rule approved/rejected/N/A |
| `lease_rule_published_to_cam` | Rule published |
| `cam_setup_blocker` | CAM prerequisites incomplete |
| `cam_calculation` | CAM compute completed/failed/stale |
| `budget_workflow` | Budget submitted/reviewed/rework/approved/locked |
| `reconciliation` | Reconciliation completed/failed/prerequisite gap |
| `tenant_true_up` | Tenant charge/refund exceeds threshold |
| `billing` | Billing export/payment/subscription event |
| `report_export` | Export complete or failed |
| `system` | General platform notice |

## Implementation Recommendations

1. Keep notification creation server-owned for workflow events. Do not rely on page-only inserts for approval, CAM, budget, or reconciliation events.
2. Normalize `priority` to `low`, `medium`, and `high`; migrate legacy `normal` to `medium`.
3. Use deep links consistently, such as `/LeaseReview?id={lease_id}`, `/LeaseExpenseRules?lease={lease_id}`, `/CAMCalculation?property_id={property_id}&year={year}`.
4. Add `recipient_user_id`, `recipient_role`, or `audience` if notifications need to target specific users instead of the whole organization.
5. Add de-duplication keys for recurring alerts, for example `lease_expiry:{lease_id}:90` or `critical_date:{id}:overdue`.
6. Add scheduled reminder jobs for critical dates and stale snapshots. Trigger-based notifications catch writes, but reminders require time-based checks.
7. Add user notification preferences only after mandat ory events are protected. Mandatory high-priority events should not be fully disabled, only channel-muted where policy allows.
8. Add email delivery for high-priority deadlines, review assignments, rejected budgets, failed computations, and true-up approvals.
9. Show notification counts in the layout bell or sidebar so users do not have to open the Notification Center to discover urgent work.
10. Create a daily digest that groups low/medium events by module to prevent notification fatigue.
