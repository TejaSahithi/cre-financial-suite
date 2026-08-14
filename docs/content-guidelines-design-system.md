# ProForma OS Content and UI Design System

## Purpose

This document is the design and content system for ProForma OS. Claude Code and any other implementation agent must use this document when building or modifying every page, component, workflow, notification, modal, table, form, chart, and user-facing message in the application.

The product must feel like a premium financial platform for commercial real estate operations. It should be modern, disciplined, data-dense, audit-aware, and professional. It must not feel like a marketing site, consumer app, generic admin template, or decorative dashboard.

## Implementation Contract for Claude Code

Claude Code must follow these rules before implementing UI:

1. Use the existing stack: React, Tailwind CSS, Radix UI/shadcn-style primitives, lucide-react icons, TanStack Query, React Router, and current app services.
2. Use existing UI primitives from `src/components/ui` before creating new primitives.
3. Use this document as the source of truth for layout, styling, component behavior, and UI copy.
4. Do not introduce a new design direction without manual approval.
5. Do not create decorative or marketing-style UI inside the authenticated application.
6. Do not use oversized hero sections, large promotional cards, abstract illustrations, gradient blobs, floating orbs, bokeh, or purely decorative backgrounds in operational pages.
7. Do not make unapproved changes to navigation structure, brand palette, typography system, or core component variants.
8. When the design system does not cover a case, choose the closest existing pattern and state the assumption in the implementation summary.
9. Ask for manual approval before adding a new component category, new color role, new icon convention, new page template, or new data visualization style.
10. Build compact operational workflows. The first screen of every authenticated page must help the user do work, not explain the product.

## Product Personality

The interface must communicate:

| Attribute | Meaning |
|---|---|
| Premium | Confident spacing, precise tables, restrained color, no novelty styling |
| Financial | Tabular numbers, clear totals, variance treatment, audit-ready language |
| Enterprise | Role-aware actions, predictable workflows, clear approvals, low ambiguity |
| Operational | Dense information, fast scanning, direct actions, minimal exposition |
| Trustworthy | Clear source status, validation states, timestamps, owner assignment |

The application should take visual inspiration from modern financial and operations products, but must not copy any one app. Acceptable inspiration qualities include Stripe's precision, Ramp's finance clarity, Vercel's restrained surfaces, Linear's density, and established real estate systems' operational rigor.

## Audience

Design equally for:

| Persona | Primary needs |
|---|---|
| Property accountant | Enter expenses, classify actuals, reconcile CAM, export billing data |
| Asset manager | Monitor portfolio risk, budgets, leases, variance, revenue, critical dates |
| Property manager | Maintain property/building/unit data, vendors, tenants, work queues |
| Reviewer | Approve lease fields, expense rules, classifications, budgets, exceptions |
| Org admin | Manage users, roles, integrations, settings, audit, security |
| Super admin | Monitor organizations, support access, platform-level controls |

No page should be optimized for only one persona unless the route is explicitly role-specific.

## Design Principles

1. **Tables are first-class.** Financial and operational records belong in compact, sortable, scannable tables.
2. **Actions are close to context.** Place row actions in the row, page actions in the header, and bulk actions above the table.
3. **Approvals are explicit.** Approval, rejection, lock, reopen, publish, send, and delete actions must always show clear status and confirmation.
4. **Numbers must align.** Currency, percentages, square footage, and counts use tabular numerals and right alignment in tables.
5. **Status must be visible.** Workflow status, source quality, approval state, and snapshot freshness must be readable without opening a detail view.
6. **No mystery states.** Empty, loading, failed, blocked, stale, and permission-denied states must tell the user what happened and what to do next.
7. **Compact does not mean crowded.** Use dense spacing, but maintain clear grouping, hierarchy, and tappable controls.
8. **Every page needs an owner action.** The main call to action must match the page's workflow stage.
9. **Auditability matters.** Approval decisions, source evidence, timestamps, and calculation snapshots must be presented clearly.
10. **Professional copy only.** Use formal enterprise and finance language. Avoid playful, casual, or vague phrasing.

## Visual Foundations

### Color System

Use a restrained financial palette. Brand colors may be updated later, so tokens must be used consistently.

Primary palette:

| Role | Token/Class guidance | Hex | Usage |
|---|---|---|---|
| App background | `bg-slate-50` | `#F8FAFC` | Authenticated page background |
| Surface | `bg-white` | `#FFFFFF` | Cards, tables, panels, dialogs |
| Primary ink | `text-slate-950` or `text-slate-900` | `#020617` / `#0F172A` | Main headings, key values |
| Secondary ink | `text-slate-600` | `#475569` | Descriptions, helper text |
| Muted ink | `text-slate-500` | `#64748B` | Metadata, timestamps, empty-state details |
| Border | `border-slate-200` | `#E2E8F0` | Standard dividers and surfaces |
| Strong border | `border-slate-300` | `#CBD5E1` | Active controls, table emphasis |
| Primary action | `bg-blue-700` | `#1D4ED8` | Primary buttons and active states |
| Primary action hover | `bg-blue-800` | `#1E40AF` | Primary button hover |
| Sidebar/nav base | `bg-slate-950` or current `#1a2744` | `#020617` / `#1A2744` | Persistent app navigation |
| Premium accent | `text-indigo-700`, `bg-indigo-50` | `#4338CA` / `#EEF2FF` | Rare analytical highlights |

Semantic palette:

| State | Text | Background | Border | Usage |
|---|---|---|---|---|
| Success/approved | `text-emerald-700` | `bg-emerald-50` | `border-emerald-200` | Approved, completed, active |
| Warning/review | `text-amber-800` | `bg-amber-50` | `border-amber-200` | Needs review, due soon, stale |
| Danger/blocked | `text-red-700` | `bg-red-50` | `border-red-200` | Failed, overdue, rejected, destructive |
| Info/system | `text-blue-700` | `bg-blue-50` | `border-blue-200` | Ready, queued, informational |
| Neutral/inactive | `text-slate-700` | `bg-slate-100` | `border-slate-200` | Draft, disabled, archived |
| Locked/final | `text-white` | `bg-slate-900` | `border-slate-900` | Locked, signed, final |

Color rules:

1. Use color to communicate status, hierarchy, and action type only.
2. Do not create one-off colors in page components.
3. Do not use purple/blue gradients as a dominant theme.
4. Gradients are allowed only for small brand marks or legacy page header icons.
5. Financial tables should remain mostly neutral; use semantic color only for variance, exceptions, and status.
6. Red must be reserved for destructive, failed, rejected, overdue, or high-risk states.
7. Green must be reserved for approved, completed, favorable, active, or positive states.
8. Amber must be reserved for needs-review, stale, due-soon, warning, or conditional states.

### Typography

Use Inter or the system sans-serif stack already present in the app.

Font family:

```css
font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
```

Type scale:

| Element | Class guidance | Usage |
|---|---|---|
| Page title | `text-2xl font-semibold tracking-tight text-slate-950` | Page headers |
| Section title | `text-base font-semibold text-slate-900` | Panels, card headers |
| Subsection title | `text-sm font-semibold text-slate-900` | Table toolbars, form groups |
| Body | `text-sm text-slate-700` | Primary readable copy |
| Supporting text | `text-sm text-slate-500` | Subtitles, descriptions |
| Metadata | `text-xs text-slate-500` | Timestamps, source labels |
| Table header | `text-[11px] font-semibold uppercase text-slate-500` | Column headers |
| Badge text | `text-[10px] font-semibold uppercase` | Compact statuses |
| KPI value | `text-2xl font-semibold text-slate-950` | Dashboard cards |
| Large financial value | `text-3xl font-semibold text-slate-950` | Summary header totals only |

Typography rules:

1. Do not use negative letter spacing.
2. Do not scale font size based on viewport width.
3. Use tabular numerals for all financial values: `font-variant-numeric: tabular-nums`.
4. Keep page subtitles one sentence maximum.
5. Avoid all caps except table headers, status badges, and short metadata labels.
6. Use `font-semibold`, not `font-bold`, for most enterprise UI labels. Reserve `font-bold` for legacy compatibility only.

### Spacing

Base spacing follows Tailwind's 4px scale.

| Use | Class guidance |
|---|---|
| Page padding desktop | `p-6` |
| Page padding mobile | `p-4` |
| Major vertical stack | `space-y-6` |
| Section stack | `space-y-4` |
| Compact control row | `gap-2` or `gap-3` |
| Card content | `p-4` for dense cards, `p-5` for standard cards |
| Table cell | `px-3 py-2` standard, `px-2 py-1.5` dense |
| Modal content | `p-6` |
| Form group gap | `space-y-2` |

Spacing rules:

1. Prefer dense vertical rhythm over large blank regions.
2. Do not use page sections taller than necessary.
3. Do not place cards inside cards.
4. Do not create large decorative empty bands.
5. Repeated cards in grids should use equal padding and equal header structure.

### Radius, Border, and Shadow

| Element | Radius | Border | Shadow |
|---|---|---|---|
| Buttons | `rounded-md` | Variant-specific | Minimal |
| Inputs | `rounded-md` | `border-slate-300` | None |
| Cards/panels | `rounded-lg` or current `rounded-xl` | `border-slate-200` | `shadow-sm` only |
| Tables | Container `rounded-lg` | `border-slate-200` | None or `shadow-sm` |
| Dialogs | `rounded-lg` | `border-slate-200` | Existing dialog shadow |
| Badges | `rounded-md` or `rounded-full` | Optional | None |

Rules:

1. Default radius should be 8px.
2. Existing `rounded-xl` cards are acceptable, but new compact enterprise surfaces should prefer `rounded-lg`.
3. Do not use heavy shadows.
4. Use borders and subtle background contrast to separate surfaces.

## Layout System

### Authenticated Page Template

Every authenticated page must follow this structure unless manually approved:

1. Page container: `p-4 md:p-6 space-y-6 bg-slate-50`.
2. Page header with title, one-line subtitle, optional icon, and primary actions.
3. Optional context strip for scope, selected property, fiscal year, snapshot, or workflow state.
4. Optional KPI row if the page summarizes measurable data.
5. Primary work area: table, review queue, form, calculation panel, or split view.
6. Secondary details below or in side panels, drawers, tabs, or dialogs.

Preferred JSX shape:

```jsx
<div className="p-4 md:p-6 space-y-6">
  <PageHeader title="Budget Dashboard" subtitle="Review budget status, approvals, and variance exposure.">
    <Button>Primary Action</Button>
  </PageHeader>

  <ContextToolbar />
  <KpiStrip />
  <PrimaryWorkSurface />
</div>
```

### Page Header

Use the existing `PageHeader` component where practical.

Header rules:

1. Title must be concrete: `Budget Dashboard`, `Lease Review`, `CAM Calculation`.
2. Subtitle must explain current function, not market value.
3. Put primary page actions on the right.
4. Limit page actions to three visible buttons. Move extras into a menu.
5. Use lucide icons in action buttons when the icon helps recognition.

Correct subtitle examples:

| Page | Subtitle |
|---|---|
| Lease Review | `Validate extracted lease fields, source evidence, and downstream approval readiness.` |
| Expense Review | `Resolve recoverability exceptions before actuals flow into CAM and reporting.` |
| CAM Calculation | `Calculate recoverable expense allocations from approved lease and expense data.` |
| Budget Dashboard | `Monitor budget status, review progress, and locked financial baselines.` |

Avoid:

| Bad copy | Reason |
|---|---|
| `Powerful AI insights for your real estate business` | Marketing language |
| `Welcome to the future of CAM` | Promotional and vague |
| `Manage everything here` | Not specific enough |

### Context Toolbars

Use context toolbars for scope selectors, fiscal year, search, filters, and snapshot status.

Rules:

1. Place filters above the table or work area.
2. Keep toolbar height compact: `min-h-10`, controls `h-9`.
3. Left side: scope and filters.
4. Right side: export, refresh, bulk actions, settings.
5. Use `Select` for property/year/status, `Input` for search, `Button variant="outline"` for secondary actions.
6. Do not hide critical filters inside menus unless there are more than six filters.

### Responsive Behavior

Desktop:

1. Use tables and split panes.
2. Keep filters horizontal.
3. Allow sticky table headers for long datasets.

Tablet:

1. Preserve tables with horizontal scroll.
2. Stack KPI rows into two columns.
3. Move secondary panels below primary content.

Mobile:

1. Use `p-4`.
2. Stack header actions below title.
3. Tables may scroll horizontally; do not convert financial tables to cards unless explicitly approved.
4. Keep primary actions visible.
5. Avoid hiding approval status or monetary totals.

## Component Rules

### Buttons

Use existing `Button` variants.

| Button type | Variant | Usage |
|---|---|---|
| Primary | `default` with primary color | Main page action: approve, calculate, generate, save |
| Secondary | `outline` | Export, refresh, open, view details |
| Quiet | `ghost` | Row-level minor actions, dismiss, close |
| Destructive | `destructive` | Delete, reject, revoke, cancel workflow |
| Link-style | `link` | Rare inline navigation |

Rules:

1. Button labels must be verb-led: `Approve Lease`, `Run CAM`, `Export Packet`, `Mark Reviewed`.
2. Use icons for common actions: save, upload, download, refresh, approve, reject, lock, unlock, filter, search.
3. Do not use text-only rounded pills where a standard button or icon button is more appropriate.
4. Use `size="sm"` in tables and dense toolbars.
5. Use `size="icon"` for repeated row tools with tooltip labels.
6. Disable buttons during async work and show loading state.
7. Primary destructive actions require confirmation.

Button label standards:

| Action | Label |
|---|---|
| Lease approval | `Approve Lease` |
| Budget approval | `Approve Budget` |
| Mark review complete | `Mark Reviewed` |
| Send back | `Send Back for Rework` |
| CAM calculation | `Run CAM` |
| Reconciliation | `Run Reconciliation` |
| Export | `Export` or `Export Packet` |
| Save edits | `Save Changes` |
| Delete | `Delete` |

### Cards and Panels

Use cards only for:

1. KPI summaries.
2. Repeated entity summaries.
3. Bounded tool surfaces.
4. Dialog-like detail panels.
5. Empty/error states.

Do not use cards for:

1. Full page sections that should be unframed.
2. Decorative containers.
3. Nested content when a table or simple section is clearer.
4. Marketing feature blocks inside the authenticated app.

Card rules:

1. Standard class: `rounded-lg border border-slate-200 bg-white shadow-sm`.
2. KPI card content: `p-4`.
3. Card title: `text-sm font-semibold text-slate-900`.
4. Card description: `text-xs text-slate-500`.
5. Do not use oversized icons in cards; max icon size `w-5 h-5` except empty states.

### KPI Cards

KPI cards are for operational summaries.

Structure:

1. Small uppercase label.
2. Primary value.
3. Optional delta or supporting metric.
4. Optional status indicator.

Example:

```jsx
<Card className="rounded-lg border-slate-200 shadow-sm">
  <CardContent className="p-4">
    <p className="text-[11px] font-semibold uppercase text-slate-500">Recoverable Actuals</p>
    <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-950">$482,100</p>
    <p className="mt-1 text-xs text-emerald-700">12.4% under approved budget</p>
  </CardContent>
</Card>
```

Rules:

1. Use no more than six KPI cards on one row.
2. Prefer four KPI cards for dashboards.
3. Values must be formatted: `$1,240,000`, `12.4%`, `24,800 SF`.
4. Show neutral copy when values are unavailable: `No approved data`.

### Tables

Tables are the primary pattern for leases, expenses, budgets, tenants, vendors, properties, CAM rows, reconciliations, and audit logs.

Required table features:

1. Search when records can exceed 20.
2. Status filter when workflow states exist.
3. Scope filter for property/building/unit when applicable.
4. Empty state.
5. Loading skeleton or compact loading row.
6. Row action menu when more than two actions exist.
7. Pagination or virtual scrolling for large datasets.

Table visual rules:

1. Header cells: `h-10 px-3 text-[11px] font-semibold uppercase text-slate-500`.
2. Body cells: `px-3 py-2 text-sm text-slate-700`.
3. Row hover: `hover:bg-slate-50`.
4. Selected row: `bg-blue-50`.
5. Numeric cells: right aligned with `tabular-nums`.
6. Status cells: compact badge.
7. First column should identify the record and may include metadata on a second line.
8. Avoid center alignment except for icons, checkboxes, and compact status indicators.
9. Do not truncate critical financial values.
10. Long text may truncate with tooltip or open drawer.

Financial column rules:

| Data type | Alignment | Format |
|---|---|---|
| Currency | Right | `$1,234,567` or `$1,234.56` where cents matter |
| Percent | Right | `12.4%` |
| Square footage | Right | `12,450 SF` |
| Count | Right | `1,204` |
| Date | Left | `Aug 5, 2026` or `2026-08-05` for audit tables |
| Status | Left | Badge |

Table action rules:

1. Primary row action may be visible as a small button.
2. Secondary row actions go in a dropdown menu.
3. Destructive row action always requires confirmation.
4. Use row click navigation only when it does not conflict with selection checkboxes.

### Forms

Form rules:

1. Labels are mandatory.
2. Required fields use label text plus validation, not only an asterisk.
3. Use `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `RadioGroup`, and `DatePicker` style patterns from current primitives.
4. Align fields in a two-column grid on desktop when fields are short.
5. Use one column for long text, legal notes, comments, and evidence.
6. Show helper text only when it prevents errors.
7. Show validation messages directly under the field.
8. Save/cancel actions go at the bottom right of forms or in sticky footer for long forms.

Field label style:

```jsx
<Label className="text-xs font-semibold text-slate-700">Fiscal Year</Label>
```

Input style:

```jsx
<Input className="h-9 border-slate-300 bg-white text-sm" />
```

Form validation copy:

| Situation | Message |
|---|---|
| Required missing | `Enter a fiscal year before continuing.` |
| Invalid date | `Enter a valid date in YYYY-MM-DD format.` |
| Invalid amount | `Enter a valid amount greater than zero.` |
| Missing property | `Select a property before running this calculation.` |
| Locked record | `This budget is locked. Reopen it before editing.` |

### Filters and Search

Rules:

1. Search placeholder must identify searchable fields: `Search tenant, property, lease status`.
2. Filter labels must be short: `Property`, `Year`, `Status`, `Owner`.
3. Use segmented tabs for common workflow buckets.
4. Use `Select` for controlled filter values.
5. Use `Button variant="outline"` with filter icon only for advanced filters.
6. Show active filter count when advanced filters are used.
7. Provide `Clear filters` when filters can hide all data.

### Tabs

Use tabs for distinct views of the same record or workflow.

Rules:

1. Tab labels must be nouns or short noun phrases: `Overview`, `Needs Review`, `Approved`, `Exceptions`.
2. Use counts in tabs when they represent queues: `Needs Review (12)`.
3. Do not use more than seven tabs in one row. If more are needed, group into sections or use a dropdown.
4. Keep destructive actions out of tab labels.
5. Tabs must preserve context and filters where possible.

### Badges and Statuses

Use badges for state, not for decoration.

Standard status mapping:

| Status | Badge style | Copy |
|---|---|---|
| Draft | Neutral | `Draft` |
| Uploaded/Queued | Info | `Queued` |
| Running | Info | `Processing` |
| Review required | Warning | `Needs Review` |
| Under review | Warning | `Under Review` |
| Reviewed | Warning/neutral | `Reviewed` |
| Approved | Success | `Approved` |
| Published | Success | `Published` |
| Sent to CAM | Success | `Sent to CAM` |
| Completed | Success | `Completed` |
| Failed | Danger | `Failed` |
| Rejected | Danger | `Rejected` |
| Overdue | Danger | `Overdue` |
| Locked | Locked/final | `Locked` |
| Signed | Locked/final | `Signed` |
| Archived | Neutral | `Archived` |

Rules:

1. Use title case in status text.
2. Avoid raw enum strings in the UI.
3. Replace underscores with spaces and normalize labels.
4. Keep badges compact: `text-[10px] font-semibold uppercase`.

### Alerts and Banners

Use alerts for important state that affects the current page.

Alert types:

| Type | Use |
|---|---|
| Info | Snapshot available, preview mode, calculation context |
| Warning | Missing optional inputs, stale snapshot, due soon |
| Danger | Blocking error, failed compute, overdue item |
| Success | Completed workflow, approved/locked result |

Rules:

1. Alert title must state the condition.
2. Alert body must state impact and next action.
3. Include a link or button when the fix is on another page.
4. Do not stack more than two alerts. Collapse extras into a checklist panel.

Copy examples:

| State | Title | Body |
|---|---|---|
| Missing CAM inputs | `CAM inputs are incomplete` | `Resolve missing square footage and pending classifications before running CAM.` |
| Preview mode | `Preview mode` | `This view uses stored budget and expense data until an authoritative snapshot is generated.` |
| Failed extraction | `Extraction failed` | `Review the failure details, then retry extraction or upload a corrected document.` |

### Modals and Dialogs

Use dialogs for focused decisions, not large workflows.

Dialog rules:

1. Title must name the action: `Reject Budget`, `Delete Expense`, `Publish Rule to CAM`.
2. Body must state consequences.
3. Destructive dialogs use destructive button variant.
4. Confirmation dialogs must include `Cancel`.
5. Long forms should use pages or sheets, not centered modals.
6. Width: `max-w-md` for confirmations, `max-w-2xl` for forms, larger only with approval.

Confirmation copy pattern:

```text
This action will [specific consequence]. This cannot be undone.
```

### Drawers and Sheets

Use drawers/sheets for record details, field review, evidence, and side-by-side inspection.

Rules:

1. Drawers open from the right on desktop.
2. Use full width on mobile.
3. Keep the primary action in the drawer footer.
4. Use drawers when the user should not lose table context.
5. Use page navigation when the task has multiple steps or deep state.

### Empty States

Empty states must be compact and actionable.

Structure:

1. Small icon, max `w-10 h-10`.
2. Title.
3. One sentence explaining why the state is empty.
4. One primary action if the user can fix it.

Examples:

| Page/state | Title | Body | Action |
|---|---|---|---|
| No leases | `No leases found` | `Upload a lease document or adjust filters to view existing leases.` | `Upload Lease` |
| No CAM-ready inputs | `No CAM-ready inputs` | `Approve lease expense rules and actual expense classifications before running CAM.` | `Open Expense Review` |
| No notifications | `No notifications` | `Workflow alerts and approval updates will appear here.` | None |
| No critical dates | `No critical dates found` | `Approved lease dates and manual reminders will appear in this view.` | `Add Reminder` |

Avoid:

1. Marketing copy.
2. Jokes or casual language.
3. Empty states taller than necessary.

### Loading States

Rules:

1. Use skeleton rows for tables.
2. Use spinner only inside buttons or compact panels.
3. Loading copy must name the data: `Loading approved lease rules...`
4. Do not block the whole page if only one panel is loading.
5. Preserve layout dimensions during loading to avoid jumps.

### Toasts

Use toasts for immediate feedback after user actions.

Rules:

1. Success toasts should be short and specific.
2. Error toasts should state failure and next step if known.
3. Do not use toasts for persistent critical conditions; use alerts or notifications.
4. Do not expose raw technical errors unless they are necessary for admin/debug mode.

Toast copy:

| Action | Success | Error |
|---|---|---|
| Save | `Changes saved.` | `Could not save changes. Review the fields and try again.` |
| Approve lease | `Lease abstract approved.` | `Could not approve lease abstract. Resolve approval blockers and try again.` |
| Run CAM | `CAM calculation completed.` | `CAM calculation failed. Review prerequisites and try again.` |
| Export | `Export generated.` | `Export failed. Try again or contact an administrator.` |
| Delete | `Record deleted.` | `Could not delete record. Check permissions and try again.` |

### Notifications

Notifications are persistent workflow alerts in the Notification Center.

Notification structure:

| Field | Rule |
|---|---|
| Title | 3-7 words, names the event |
| Message | One sentence, names affected record and required next action |
| Link | Deep link to the exact page |
| Priority | Low, medium, high |
| Type | Stable event category, not generic if avoidable |

Notification copy examples:

| Event | Title | Message |
|---|---|---|
| Lease expiration | `Lease Expiration Alert` | `Mindful Tech's lease expires in 90 days. Review renewal options and notice requirements.` |
| Budget rework | `Budget Sent Back for Rework` | `FY 2026 budget for Macon Crossing requires updates before approval.` |
| CAM blocked | `CAM Inputs Incomplete` | `Three classifications still need review before CAM can be calculated for FY 2026.` |
| Reconciliation exception | `True-Up Review Required` | `Tenant true-up exceeds the materiality threshold and requires approval before billing.` |

## Page-Specific Patterns

### Dashboard

Use dashboard pages for current operational state, not decoration.

Required sections:

1. KPI strip.
2. Work queue summary.
3. Financial trends or variance chart.
4. Upcoming critical dates.
5. Recent approvals or alerts.

Rules:

1. Prioritize exceptions and next actions above general metrics.
2. Charts must include labels, legends, and empty states.
3. Dashboard cards must deep link to the operational page.
4. Do not use hero-style welcome areas.

### Lease Pages

Applicable pages: `/LeaseUpload`, `/Leases`, `/LeaseReview`, `/LeaseDetail`, `/LeaseRentSchedule`, `/RentProjection`, `/CriticalDates`.

Rules:

1. Always show tenant, property, lease status, approval status, and source status where relevant.
2. Lease Review must emphasize evidence, confidence, required fields, and approval blockers.
3. Approved lease information must be visually distinct from draft extraction data.
4. Critical dates must show urgency, owner, due date, source, and completion status.
5. Lease detail pages must use sections: Parties, Premises, Dates, Rent, CAM/Expenses, Options, Documents, Audit.

### Expense Pages

Applicable pages: `/Expenses`, `/AddExpense`, `/BulkImport`, `/ExpenseReview`, `/LeaseExpenseClassification`, `/LeaseExpenseRules`, `/ExpenseProjection`, `/Vendors`.

Rules:

1. Show amount, property, vendor, category, recovery status, approval status, fiscal year, and source.
2. Recoverability and approval are separate concepts and must not be visually collapsed.
3. Exceptions must be grouped by reason: unmatched, low confidence, conditional, missing rule, excluded.
4. Expense review actions must be explicit: approve, reject, mark non-recoverable, mark conditional, send to CAM.
5. Vendor pages must emphasize spend, properties, categories, variance, and duplicate risk.

### CAM Pages

Applicable pages: `/CAMDashboard`, `/CAMSetup`, `/CAMCalculation`, `/Reconciliation`.

Rules:

1. Always show selected property and fiscal year.
2. Show calculation mode, snapshot freshness, engine version, and lock state when available.
3. Display prerequisites before the run action.
4. Block calculation when mandatory inputs are missing.
5. Display tenant allocation tables with tenant share, square footage, recoverable expenses, cap, admin fee, estimated CAM, actual CAM, and true-up.
6. Use warning alerts for stale snapshots and input drift.

### Budget Pages

Applicable pages: `/BudgetDashboard`, `/CreateBudget`, `/BudgetReview`, `/Variance`, `/Actuals`, `/ActualsVariance`, `/Comparison`.

Rules:

1. Budgets must clearly separate draft, under review, reviewed, approved, locked, and signed.
2. Approved/locked budgets are financial baselines.
3. Rework comments must be prominent until resolved.
4. Preview data must state that it reads only approved upstream data.
5. Variance tables must show current year, prior year, budget, actual, variance amount, and variance percent.
6. Positive and negative variance color must be context-aware. Over-budget expense is danger; under-budget expense may be success or neutral depending on page.

### Admin and Settings Pages

Applicable pages: `/UserManagement`, `/OrgSettings`, `/ApprovalWorkflows`, `/AuditLog`, `/Integrations`, `/ChartOfAccounts`, `/FieldMappingRules`, `/SuperAdmin`.

Rules:

1. Use tables with explicit role, module, access, status, and last updated columns.
2. Admin actions must use confirmation when access, security, billing, or integration state changes.
3. Audit logs must use exact timestamps and raw action names only when needed for traceability.
4. Integrations must show connection status, last sync, owner, failure reason, and next action.

## Charts and Data Visualization

Use charts only when they clarify financial comparison, trend, allocation, or variance.

Allowed chart types:

| Chart | Use |
|---|---|
| Line chart | Revenue, expense, NOI, occupancy trends |
| Bar chart | Budget vs actual, property comparison, category spend |
| Stacked bar | Expense category composition, recovery split |
| Donut/pie | Limited use for category share, max 6 slices |
| Area chart | Forecast trend with historical context |

Rules:

1. Charts must have direct labels or clear legends.
2. Use no more than five primary chart colors.
3. Use chart colors from the token palette.
4. Always include a table or numeric summary for finance-critical chart data.
5. Do not use charts as decoration.
6. Show empty state when data is missing.
7. Tooltips must format currency, percentages, and dates correctly.

## Content Guidelines

### Voice and Tone

The voice is formal enterprise plus finance professional.

Use:

1. Precise.
2. Calm.
3. Direct.
4. Audit-aware.
5. Operational.
6. Professional.

Avoid:

1. Casual enthusiasm.
2. Marketing claims.
3. Jokes.
4. Vague encouragement.
5. Over-explaining obvious UI.
6. Technical stack details in user-facing copy.

Preferred words:

| Use | Avoid |
|---|---|
| `Approve` | `OK this` |
| `Review required` | `Needs your eyes` |
| `Calculation failed` | `Something went wrong` |
| `No approved data` | `Nothing here yet!` |
| `Send Back for Rework` | `Kick back` |
| `Locked` | `Frozen` |
| `Recoverable` | `Billable-ish` |
| `Non-recoverable` | `Not billable` |

### Capitalization

Use sentence case for most copy:

| Element | Style |
|---|---|
| Page titles | Title Case |
| Section titles | Title Case or concise sentence case |
| Button labels | Title Case for action phrases |
| Field labels | Title Case or concise sentence case |
| Helper text | Sentence case |
| Error messages | Sentence case |
| Status badges | Title Case |
| Table headers | Uppercase compact labels |

### Page Copy

Page subtitles must be one sentence and answer: what work happens here?

Examples:

| Page | Subtitle |
|---|---|
| Properties | `Manage property records, hierarchy, and operational setup data.` |
| Lease Upload | `Upload lease documents and monitor extraction readiness.` |
| Expense Review | `Resolve classification exceptions before actuals flow into CAM and reporting.` |
| Reconciliation | `Calculate year-end CAM true-ups from approved budgets, actuals, and allocations.` |

### Button Copy

Rules:

1. Use verbs.
2. Be specific.
3. Avoid `Submit` unless no better verb exists.
4. Avoid `Click here`.
5. Avoid `Proceed` unless confirming a multi-step action.

Preferred labels:

| Context | Label |
|---|---|
| Save form | `Save Changes` |
| Create record | `Create Property` |
| Start compute | `Run Calculation` or `Run CAM` |
| Start extraction | `Start Extraction` |
| Upload | `Upload Lease` |
| Approve | `Approve Lease` or `Approve Budget` |
| Reject | `Reject` or `Send Back for Rework` |
| Export | `Export` or `Export Packet` |
| Retry | `Retry Extraction` |
| Delete | `Delete` |

### Error Messages

Error messages must include:

1. What failed.
2. Why, if known.
3. What the user can do next.

Pattern:

```text
[Action] failed. [Reason if known]. [Next step.]
```

Examples:

| Situation | Message |
|---|---|
| CAM prerequisites | `CAM calculation failed. Resolve pending classifications and missing square footage before running CAM.` |
| Lease approval blocker | `Lease approval is blocked. Resolve required fields and missing source evidence before approving.` |
| Permission | `You do not have permission to update this record. Contact an organization administrator for access.` |
| Network/service | `The service did not respond. Try again, or contact an administrator if the issue continues.` |
| Locked record | `This record is locked. Reopen it before making changes.` |

Avoid:

1. `Oops`.
2. `Something went wrong`.
3. Raw stack traces.
4. Unexplained codes for non-admin users.

### Success Messages

Success messages must be concise.

Examples:

| Action | Message |
|---|---|
| Save | `Changes saved.` |
| Approve lease | `Lease abstract approved.` |
| Approve rule | `Lease expense rule approved.` |
| Send to CAM | `Classification sent to CAM.` |
| Run reconciliation | `Reconciliation completed.` |
| Export | `Export generated.` |
| Invite | `Invitation sent.` |

### Warning Messages

Warnings must state the impact.

Examples:

| State | Message |
|---|---|
| Stale snapshot | `Inputs changed after the latest snapshot. Re-run the calculation before using these outputs.` |
| Preview mode | `This is a preview from stored data. Run the calculation to create an authoritative snapshot.` |
| Missing approved data | `No approved lease abstracts are available for this scope.` |
| Low confidence | `Some extracted fields have low confidence and require reviewer validation.` |

### Empty State Copy

Pattern:

```text
No [records] found.
[Reason or next step.]
```

Examples:

| State | Copy |
|---|---|
| No approved leases | `No approved leases found. Approve lease abstracts before generating budgets or CAM inputs.` |
| No expenses | `No expenses found. Add actual expenses or adjust filters to view existing records.` |
| No exceptions | `No exceptions in this scope. New classification issues will appear here after review runs.` |

## Domain Language

Use these terms consistently:

| Concept | Preferred term |
|---|---|
| Common Area Maintenance | `CAM` after first use where obvious |
| Year-end settlement | `CAM reconciliation` or `true-up` |
| Tenant allocation | `Pro-rata share` |
| Operating expense passthrough | `Recoverable expense` |
| Non passthrough expense | `Non-recoverable expense` |
| Needs human decision | `Needs Review` |
| Official computation | `Authoritative snapshot` |
| Draft computation | `Preview` |
| Lease AI output | `Extracted lease fields` |
| Approved lease record | `Approved abstract` |
| Budget official record | `Locked budget` or `approved budget` |

Do not use:

1. `AI magic`.
2. `Auto-awesome`.
3. `Billable-ish`.
4. `Stuff`.
5. `Data dump`.
6. `Final-ish`.

## Data Formatting

### Currency

Rules:

1. Use `$1,234` for whole-dollar values.
2. Use `$1,234.56` when cents are operationally relevant.
3. Negative currency uses `-$1,234` in most UI.
4. Accounting parentheses may be used in exports or formal reports: `($1,234)`.
5. Do not show more than two decimal places.

### Percentages

Rules:

1. Use one decimal place for variance: `12.4%`.
2. Use whole percent for occupancy when precision is not needed: `94%`.
3. Include sign for deltas: `+4.2%`, `-1.8%`.

### Dates and Times

Rules:

1. User-facing dates: `Aug 5, 2026`.
2. Audit timestamps: `2026-08-05 14:32 ET` or exact ISO-like display if already used.
3. Form date input: `YYYY-MM-DD`.
4. Relative copy is allowed only with exact date nearby: `Due in 30 days, Sep 4, 2026`.

### Square Footage

Rules:

1. Format as `12,450 SF`.
2. Use `RSF` only when the data specifically means rentable square feet.
3. Use right alignment in tables.

### Unknown Values

Use:

| Situation | Display |
|---|---|
| Truly unavailable | `Not available` |
| Not applicable | `N/A` |
| Not configured | `Not configured` |
| No approved data | `No approved data` |
| Loading | Skeleton or `Loading...` |

Avoid using raw `null`, `undefined`, empty string, or `--` in final UI unless inside compact table cells where space is highly constrained.

## Accessibility and Interaction

Rules:

1. All icon-only buttons must have `aria-label` or tooltip.
2. Do not rely on color alone to communicate status.
3. Focus states must remain visible.
4. Text contrast must meet WCAG AA.
5. Tables must use semantic table elements.
6. Forms must connect labels to inputs.
7. Dialogs must trap focus and close on Escape unless a destructive action is in progress.
8. Loading buttons must remain disabled until action completes.
9. Destructive actions must be keyboard accessible.

## Approval Requirements for Design Changes

Claude Code must ask for manual approval before:

1. Changing the core color palette or CSS variables.
2. Changing page navigation or sidebar grouping.
3. Adding a new UI library.
4. Creating a new primary button style.
5. Replacing tables with card grids for financial records.
6. Introducing charts not listed in this document.
7. Adding marketing sections to authenticated pages.
8. Changing typography scale.
9. Changing status colors or status labels.
10. Adding animations beyond subtle loading/transition states.
11. Using generated images or decorative visuals.
12. Making a page significantly less dense.
13. Removing audit, approval, status, or timestamp information from existing workflows.

Claude Code may proceed without approval for:

1. Applying this design system to existing pages.
2. Replacing inconsistent styling with approved tokens.
3. Improving table alignment, spacing, and copy using these rules.
4. Adding missing empty/loading/error states that follow this document.
5. Adding tooltips or aria labels to existing icon buttons.
6. Converting raw enum labels into approved human-readable labels.

## Component Implementation Checklist

Before finishing any UI task, Claude Code must verify:

1. Page follows the authenticated page template.
2. Primary action is visible and correctly labeled.
3. Tables use right-aligned tabular numeric cells. 
4. Empty, loading, error, and permission states exist.
5. Status badges use approved colors and labels.
6. Destructive actions require confirmation.
7. Form fields have labels and validation messages.
8. Copy is formal, finance-professional, and specific.
9. No decorative/marketing UI was added.
10. Links and actions route to the exact workflow page.
11. Mobile layout does not hide financial totals or approval status.
12. Any design decision outside this document was either avoided or explicitly requested for approval.

## Recommended First Design-System Refactor Targets

These improvements should be applied first when the team begins UI cleanup:

1. Normalize page headers to the Page Header pattern.
2. Normalize status badges across lease, expense, CAM, budget, and notification pages.
3. Normalize financial table alignment and currency formatting.
4. Add consistent context toolbars for property/year/status filters.
5. Add missing empty states for tables and calculation pages.
6. Add persistent high-priority notification visibility in the layout.
7. Normalize modal copy for reject, delete, lock, publish, and approval actions.
8. Replace generic `approval` notification types with stable domain-specific types.
9. Update `normal` notification priority values to `medium`.
10. Create reusable KPI card, status badge, page toolbar, and financial table helpers.
