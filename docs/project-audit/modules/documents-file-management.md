# Module: Documents & File Management

> Generated: 2026-07-20 · Revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` · Canonical score **2.8 / 5**, criticality **14 (Critical)** — [03](../03-module-catalog-and-maturity.md) · Index: [04](../04-module-deep-dives.md)

## Functional / technical view
Storage and lifecycle tracking for uploaded files, separate from the extraction pipeline's own artifact custody. Pages: `Documents`, `FileHistoryPage`. Buckets: `financial-uploads` (org-folder-scoped RLS, MIME allowlist), `extraction-artifacts` (default-deny, [SEC-006](../findings-register.md#sec-006)), and a `documents` bucket referenced in migration comments as a **manual dashboard step** — not migration-managed ([08 §5](../08-database-schema-and-ui-gap-analysis.md)). Functions: `ingest-file`, `upload-handler`, `confirm-upload`⚠, `cancel-upload`⚠, `delete-uploaded-file`⚠.

## Workflow view
Upload → magic-byte type detection → org-scoped path → `uploaded_files.processing_status` tracks lifecycle → confirm/cancel handle the upload's own two-phase commit (separate from pipeline processing status). Cancellation mid-upload is explicitly modeled (`cancel-upload`⚠), a detail many products skip.

## Assessment
**Strengths:** genuinely careful upload lifecycle (confirm/cancel two-phase pattern, magic-byte validation rather than trusting file extensions); the storage-isolation design (per-bucket policy strategy matched to sensitivity) is one of the better security patterns in the codebase.
**Weaknesses:** the `documents` bucket being a manual, non-migration-managed dashboard step means a fresh environment (or disaster recovery restore) won't have it unless someone remembers ([14](../14-devops-infrastructure-and-delivery.md) reproducibility gap); 3 of 5 functions undeclared in config.toml; no retention policy on any bucket.
**Recommended:** migrate `documents` bucket creation into SQL/migration (S, P1 — currently a silent DR/reproducibility trap); declare functions (S, P1); retention policy across all buckets (M, P2, shared with [SEC-006](../findings-register.md#sec-006)).
