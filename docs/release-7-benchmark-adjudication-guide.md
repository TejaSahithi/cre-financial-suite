# Release 7 Benchmark Adjudication Guide

Release 7 golden truth requires two independent reviewer passes before a fixture can be locked.

Workflow:
1. Reviewer A annotates fields, definitions, cross references, amendment effects, evidence pages, and uncertainty.
2. Reviewer B annotates the same fixture without seeing Reviewer A decisions.
3. The benchmark owner generates a disagreement report by field, semantic entity, and evidence page.
4. An adjudicator resolves disagreements and records rationale in the golden truth `adjudication` block.
5. Locked fixtures receive a fixture version and may be used for threshold enforcement.

Rules:
- Effective dates: use the date stated by the operative document. If execution date and effective date differ, store both only when the field contract requires both.
- Commencement dates: use commencement certificate values over estimated base-lease dates when the certificate is operative.
- Rent schedules: normalize monetary values numerically and preserve schedule uncertainty with accepted values or tolerance.
- Options: mark option language as operational unless it affects approval-critical term or rent decisions.
- CAM exclusions: capture explicit exclusions as financial or operational based on downstream calculation impact.
- Amendment effects: record effect type, target field or clause, replacement value, effective date, and superseded values.
- Definitions: do not collapse materially different terms. Scope terms to amendment, exhibit, section, or document family when language requires it.
- Cross references: unresolved missing exhibits should be expected findings, not forced successful links.
- Missing evidence: if the value is known from context but source evidence is absent, use `missing_source_evidence`.
- Ambiguous language: use accepted values or adjudication notes rather than inventing false precision.