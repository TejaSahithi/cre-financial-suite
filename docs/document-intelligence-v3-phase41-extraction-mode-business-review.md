# Document Intelligence v3 — Phase 41 Extraction Mode Business/Legal/Product Review

Generated: 2026-07-15

## 1. Executive Summary

Phase 41 is a review/reporting phase only — no source code was changed. It
packages Phase 40's Extraction Mode column/data model for business, legal,
and product sign-off: what each mode means, how conservative the current
`unknown`-heavy coverage is, whether that's acceptable, and what decisions
are needed before extraction mode could ever be trusted for anything beyond
display.

**Headline finding:** on the approved assignment document, extraction mode
is currently binary in practice — every row is either `explicit` (15 of 148
rendered rows, 11 of 88 standard fields) or `unknown` (133 of 148, 77 of 88
standard fields). `normalized`, `inferred`, `calculated`, `reviewer_entered`,
and `manual` are all real, tested, reachable code paths (Phase 40 added
direct unit tests for each), but **none of them appear on this document's
actual data** — this dataset simply doesn't contain a backend-tagged
calculated/inferred field, a normalization-derived value, or a
reviewer-touched field yet. That's a fact about this one document's data,
not a defect in the resolver.

Recommendation remains: **No Gate**. Extraction mode is presentation/
transparency only today; nothing in the pipeline gates on it, and this
report does not propose that it should without further business/legal
decisions (Section 7).

## 2. Approved Document IDs

| ID | Value |
| --- | --- |
| uploaded_file_id | `fc8181e6-766d-49c7-b81b-b5d961160207` |
| lease_id | `7b21f353-579d-48e8-b3dd-8e8c49743fe2` |
| local diagnostic run_id | `6d175b40-8f60-429f-8a29-a047e2a2e333` |

Data gathered via a read-only local Postgres dump (`127.0.0.1:54322`) and
the real `normalizeLeaseReviewData()` function, run through a temporary
Vitest file deleted immediately after use — same method as Phases 38-40, no
browser tool available in this session. No deploy, remote read, production
write, secrets/service-key use, `SUPABASE_ACCESS_TOKEN`, Azure/Vertex/Gemini
call, parse/extraction rerun, or approval-behavior change occurred.

## 3. Current Extraction Mode Distribution

### 3a. Standard field rows (the primary, fully-resolved row type — 88 rows)

| Mode | Count | % |
| --- | ---: | ---: |
| explicit | 11 | 12.5% |
| normalized | 0 | 0% |
| inferred | 0 | 0% |
| calculated | 0 | 0% |
| reviewer_entered | 0 | 0% |
| manual | 0 | 0% |
| unknown | 77 | 87.5% |
| **Total** | **88** | **100%** |

### 3b. All other row types on this document

| Row type | Total rows | explicit | unknown | Note |
| --- | ---: | ---: | ---: | --- |
| Dynamic findings | 0 | — | — | This document has no dynamic (unmapped) findings |
| Clause records | 35 | 0 | 35 | All `unknown` by design (Phase 40 scoping decision — see §6) |
| Expense rules | 0 | — | — | No expense rules on this document |
| CAM rules | 0 | — | — | No CAM rules on this document |
| Critical dates | 7 | 0 | 7 | `unknown` because none of the 7 checklist fields (commencement/expiration/etc.) have any value on this assignment document — not a resolver gap, there's simply nothing to have a mode about |
| Budget preview (read-only references) | 7 | 1 | 6 | The 1 explicit row (`square_footage`) correctly inherits its real mode from the source standard field row |
| **All rendered tab rows combined** (includes cross-tab duplication, e.g. budget-preview references) | 148 | 15 | 133 | |

### 3c. Total rows reviewed

**148 rendered rows** across all tabs; **88 distinct standard field rows**
underlie most of them (some appear twice, once in their home tab and once
as a read-only reference in Budget Preview or Critical Dates).

## 4. Examples From The Approved Assignment Document

**Explicit** (clean, page-anchored, directly-quoted source evidence):

| Field | Value | Why explicit |
| --- | --- | --- |
| `assignee_name` | NARENDRA PYDI | Quoted verbatim: *"NARENDRA PYDI, a resident of... ('Assignee')."* |
| `assignment_effective_date` | 2023-11-07 | Quoted verbatim: *"...entered into as of the 7th day of November, 2023 (the 'Effective Date')"* |
| `security_deposit` | $8,575 | Quoted verbatim, page-anchored |

Also explicit on this document: `tenant_signatory_name`, `property_address`,
`square_footage`, `assignment_consideration`, `amended_base_rent_for_additional_year`,
`assignment_provisions`, `assumption_scope`, `assignee_notice_address`.

**Unknown** (the resolver declining to overclaim):

| Field | Value shown | Why unknown |
| --- | --- | --- |
| `landlord_name` | *(blank — value rejected)* | Extracted value was the literal markup artifact `"<figure>"`, rejected by Phase 39's sanitizer; a rejected value can never be reported as any real mode |
| `tenant_signature_date` | 2018-02-01 (value retained, flagged) | Source text describes when the **original lease** was entered into, not this document's signature — Phase 39's evidence-integrity fix demotes this; extraction mode correctly follows suit |
| `landlord_signature_date` | 2018-02-01 (value retained, flagged) | Same reason as above |
| `tenant_name` | NARENDRA PYDI | Value present, but evidence quality doesn't clear the bar (`evidenceVerified: false`) — pre-existing, correctly not overclaimed |
| `landlord_consent` | true | Same — evidence present but not verified to the required standard |
| *(77 fields total)* | mostly no value | Most standard fields on an assignment document (e.g. `monthly_rent`, `cam_amount`, `lease_type`) simply have no value at all — nothing to describe a mode for |

## 5. Mode Vocabulary and Reviewer Meaning (Task B)

| Mode | What it means | When to trust it | When to review it | Should it ever support approval gating? | Source evidence required? |
| --- | --- | --- | --- | --- | --- |
| **explicit** | The value is directly stated in the source text, with page-anchored, quality-checked evidence. | Highest-trust tier. A reviewer can generally accept a well-formed `explicit` value with a quick source-text glance rather than a full manual re-read. | Still worth a glance if the value looks structurally implausible (wrong date format, absurd dollar amount) — `explicit` certifies "the text says this," not "this is legally correct." | Only mode that could reasonably support a *future* gate, and only after Task D's decisions (source text + page required, no exceptions) are locked in. Not gated today. | Yes, always — the resolver cannot produce `explicit` without page-anchored, quality-verified evidence (Phase 40 test coverage proves this). |
| **normalized** | The value was reshaped from a directly-stated value (date/currency/name-format cleanup) with no substantive change in meaning. | Trust the *transformation logic*, not blind trust — spot-check that normalization didn't silently change meaning (e.g. a date normalized across a locale boundary). | Whenever the raw vs. normalized values look surprising, or for any field where formatting ambiguity is legally material (e.g. day/month order). | Same tier as explicit in principle — the underlying value IS directly stated, just reformatted — but only after the same evidence-requirement decision. | Yes — the source value must trace back to real evidence; normalization must not be allowed to fabricate a value with no textual origin. |
| **inferred** | The value was inferred from context, not directly stated anywhere in the source text. | Never trust as-is. Treat as a hypothesis, not a fact. | Always — every inferred value needs a human decision before it can be relied on for anything business-facing. | No. Inference is inherently a judgment call the system is making, not a fact the document states — should never gate approval without a human confirming it. | No literal quote is required by definition, but the resolver should still require *some* traceable context (page/section) — see §7 open question on whether reasoning metadata should be mandatory. |
| **calculated** | The value was computed from other extracted values (e.g. rent PSF from rent ÷ square footage). | Trust the computation only as far as you trust its inputs — a calculated value is exactly as reliable as the fields it was built from. | Whenever an input field is itself `needs_review`/`unknown`/low-confidence — a calculation built on shaky inputs inherits that shakiness silently unless flagged. | Only if the formula and its inputs are durably recorded (see §6 Q4) — otherwise a reviewer can't audit *why* the number is what it is. | Not source text in the usual sense, but the computation trace (inputs + formula) should be considered the equivalent evidence requirement. |
| **reviewer_entered** | A human reviewer explicitly typed or corrected this value (the `Edit` action). | Trust as the current source of truth for that field — it reflects a deliberate human decision, which by definition supersedes whatever the extractor originally said. | Only if there's reason to doubt the specific reviewer's edit (e.g. audit sampling), not as a routine matter. | Yes, in principle — a human explicitly attesting to a value is the strongest signal the system can have. Still advisory today, not gated. | No document source text required — the "evidence" is the review action itself, which should be logged with who/when (see §6 Q6). |
| **manual** | The value was flagged for or received manual attention without enough structured detail to say a specific reviewer authored the current value (e.g. `Mark N/A`/`Manual Required` status without a captured edit). | Treat as unresolved by default — this mode exists specifically because the system *can't* tell whether it's trustworthy. | Always, until it's either resolved into `reviewer_entered` (a real edit happens) or the field is otherwise closed out. | No, not until it's resolved into a more specific mode. | Not required for the mode itself, but the underlying review record should exist (§6 Q6). |
| **unknown** | The system cannot safely determine how this value came to exist, or there is no value at all. | Never trust for a decision. This is the safe default, not a claim of any kind. | Always, if the field has a populated value — an `unknown`-but-populated field (e.g. `tenant_name` today) means "there's a value here and we genuinely don't have enough signal to say more," which is exactly the case that most needs a human look. | No. By construction, `unknown` never blocks or unblocks anything — it's a display fact, not a gate. | N/A — `unknown` exists precisely because the evidence situation is unclear. |

## 6. Conservative Unknown-Heavy Coverage Analysis (Task C)

**Q1. Is it acceptable that weak-evidence fields show `unknown` instead of
`explicit`?**
Yes, and this is the correct behavior, not a shortcoming to fix. `tenant_name`
and `landlord_consent` on this document have real values but evidence that
doesn't clear the quality bar (`evidenceVerified: false`) — reporting them
as `explicit` would be a false claim of certainty exactly like the
signature-date and `<figure>` bugs Phase 39 fixed. `unknown` correctly
tells the reviewer "look closer," which is the whole point of the column.

**Q2. Is it acceptable that non-standard row types default to `unknown`?**
Yes, as an interim state. Dynamic findings, clause records, and expense/CAM
rule rows don't currently carry the structured extraction-status/
evidence-quality metadata the resolver needs (see Phase 40 report §7/§13).
Guessing a mode for them without that metadata would be the same kind of
overclaiming the resolver is designed to avoid elsewhere. `unknown` is
honest; a guessed mode would not be.

**Q3. Should clause records, dynamic findings, expense rules, and CAM rules
remain `unknown` until provider-side metadata exists?**
Yes — recommended default position, pending Task D sign-off. Building a
second, weaker heuristic just for these row types would reintroduce the
exact fabrication risk this whole feature was built to eliminate. Wait for
real metadata (see Section 8, Option 2) rather than approximate it.

**Q4. Should calculated values be labeled `calculated` only when formula
inputs and computation provenance are durable?**
Yes — recommended. Today `calculated` only fires from
`isCalculatedExtractionStatus`, which only a handful of expense/CAM
rule-derived fields ever receive from the backend; there is no formula/input
trace attached to it yet. Before `calculated` is used for anything beyond
display, the input field keys and formula should be durably recorded so a
reviewer (or auditor) can reconstruct *why* the number is what it is.

**Q5. Should `inferred` values require explicit model/provider reasoning
metadata?**
Yes — recommended, and currently unenforced. The resolver trusts a bare
`extractionStatus === "inferred"` signal from the backend with no
requirement that the inference reasoning itself be recorded. Given
`inferred` is explicitly "never trust as-is, always review" per Section 5,
requiring the underlying reasoning/context to be captured (not just the
conclusion) would materially improve reviewer ability to evaluate it.

**Q6. Should `reviewer_entered`/`manual` values require persisted field
review metadata?**
Yes — and this is close to already true. `reviewer_entered` only fires from
`REVIEW_STATUSES.EDITED`, which is set by `LeaseReview.jsx`'s real
Accept/Edit persistence flow (`fieldReviews[key]`, backed by
`lease.extraction_data.field_reviews` / the `lease_field_reviews` audit
table per Phase 33-37's wiring) — so the "who/when" trail already exists
structurally. What's not yet formalized is a business decision that this
trail is *mandatory* (not just incidentally present) before a value can be
labeled `reviewer_entered` — worth an explicit sign-off rather than leaving
it as an implementation detail.

## 7. Business/Legal Decision Table (Task D)

| # | Question | Current Behavior | Risk | Recommendation | Decision Owner |
| - | --- | --- | --- | --- | --- |
| 1 | Should `unknown` be allowed for populated fields? | Yes — a field can have a real value and still show `unknown` (e.g. `tenant_name`) | Reviewers might assume "unknown" means "no data," when it actually means "data present, provenance unclear" | Keep allowing it, but confirm the UI copy/tooltip makes the distinction unambiguous (data-present-but-unverified vs. no-data-at-all) | Product/UX |
| 2 | Should `unknown` require Needs Review? | Not automatically — `unknown` and `status` are independent today (a field can be `auto_populated`-adjacent status with `unknown` mode in edge cases) | A populated-but-`unknown` field could be missed if a reviewer only scans by status, not by mode | Decide whether a populated `unknown` row should force `status` into `needs_review` regardless of confidence/evidence, or remain a separate independent signal | Product/Legal |
| 3 | Should `explicit` require source text **and** page? | Currently EXACT quality requires both; PARTIAL quality (also mapped to `explicit`) allows a supported value without a clean page boundary | A `explicit` value without a page number is harder for legal to verify against the original document | Decide if `explicit` should be restricted to EXACT-quality only (page + clean boundary), demoting PARTIAL to a distinct tier or to `unknown` | Legal |
| 4 | Should `normalized` require both raw value and normalized value to be retained? | Not currently enforced — the row only stores the final (normalized) value, not the raw pre-normalization value | If normalization is ever wrong, there's no stored raw value to audit against | Recommend requiring both raw and normalized values to be persisted before `normalized` is used in any audit-facing context | Legal/Engineering |
| 5 | Should `inferred` be hidden unless model reasoning/evidence exists? | No — currently `inferred` can fire from a bare backend flag with no reasoning trail (see §6 Q5) | Reviewers see "Inferred" with nothing to evaluate the inference against | Recommend: yes, require reasoning/context metadata before showing `inferred` as a distinct badge; otherwise fall back to `unknown` | Product/Legal |
| 6 | Should `calculated` require formula/provenance? | No — currently unenforced (see §6 Q4) | A calculated number an auditor can't reconstruct is a liability, not a feature | Recommend: yes, require formula + input field keys before `calculated` is shown; otherwise `unknown` | Legal/Engineering |
| 7 | Should `reviewer_entered`/`manual` values be visually distinct from system-extracted modes? | Currently distinct badge colors exist (`EXTRACTION_MODE_META` in `LeaseReviewTabTable.jsx`) but no additional call-out (e.g. reviewer name/timestamp inline) | A human-entered value that looks identical in weight to a system value could be mistaken for original extraction | Recommend adding reviewer attribution (who/when) to the row detail view for `reviewer_entered`/`manual` rows, not just the badge | Product |
| 8 | Should extraction mode be included in exports/audit logs? | No — extraction mode is a client-rendered UI property only today, not persisted or exported | Downstream consumers of an exported abstract have no visibility into how confident the system was about each value | Recommend including extraction mode in any future structured export/audit-log format, once modes 1-7 above are locked down | Legal/Compliance |
| 9 | Should extraction mode affect approval readiness? | No — explicitly out of scope this phase and Phase 40; extraction mode has zero effect on `approvalBlockers`/`readinessSummary` | Premature gating on an unaudited signal could either falsely block valid documents or falsely clear risky ones | Recommend: no, not until Decisions 3-8 above are resolved and a curated document set validates mode accuracy (see Section 8) | Business/Legal (final go/no-go) |
| 10 | Should non-standard rows (dynamic/clause/expense/CAM) get real extraction mode later? | No — `unknown` by design, pending provider-side metadata (§6 Q2-Q3) | Leaving them `unknown` indefinitely reduces the column's usefulness for those tabs | Recommend: yes, but only after Option 2 (Section 8) is approved and implemented — do not approximate with a second heuristic in the meantime | Product/Engineering |

## 8. Provider-Side Investment Options (Task E)

**Option 1 — Keep the conservative client-side resolver as-is.**

Pros: safe; no provider call; never overclaims; protects reviewer trust;
works entirely with data already available today.

Cons: many populated fields stay `unknown` (see §3a — 87.5% of standard
fields); limited usefulness for clause/dynamic/CAM/expense rows (0%
coverage beyond `unknown`); not sufficient grounding for approval gating.

**Option 2 — Add extractor/provider-side extraction-mode metadata later.**

Pros: better mode coverage (real `inferred`/`calculated`/`normalized`
distinctions instead of mostly `unknown`); improves auditability (formula
provenance, reasoning traces); could eventually support a properly-designed
future gate.

Cons: requires extractor/provider changes; may require Vertex/Gemini output
schema changes; needs regression QA; likely needs a curated document set to
validate accuracy before trusting it for anything consequential.

**Recommendation:** Keep the conservative client-side resolver now. Do not
invest in provider-side extraction-mode metadata until business/legal has
approved the vocabulary (Section 5) and resolved the Decision Table
(Section 7) — investing in richer provider-side coverage before the
vocabulary itself is signed off risks building the wrong thing twice.

## 9. Recommendation

**No Gate.** Phase 41 is analysis/reporting only. Extraction mode remains
advisory/display-only; nothing in this report proposes changing that without
further explicit business/legal sign-off on the Section 7 decision table.

## 10. Recommended Phase 42

Route the Section 7 decision table to the actual decision owners (Product,
Legal, Compliance, Engineering per row) for sign-off. Phase 42 should not
attempt to resolve these decisions unilaterally in code — it should either
(a) collect and record the actual decisions, or (b) if decisions can't be
collected yet, scope the smallest safe next step that doesn't presuppose an
answer (e.g., persisting raw+normalized value pairs for `normalized` rows,
which is useful regardless of how Decision #4 is ultimately resolved).
