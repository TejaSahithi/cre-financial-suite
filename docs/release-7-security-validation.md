# Release 7 Security Validation

Scope covers Release 3 through Release 6 canonical layout, projection, semantic, review payload, reviewer action, and search surfaces.

Validation checklist:
- All semantic tables have organization-scoped RLS enabled.
- Edge functions verify the user and resolve organization membership before reading or writing review payloads.
- Service-role access is limited to edge functions and does not trust client-supplied organization ids without membership checks.
- Uploaded-file ownership is checked before payload, semantic search, and reviewer action access.
- Document-family membership never crosses organization boundaries.
- Semantic search filters by organization and uploaded file or document family.
- Reviewer resolution writes require active membership and current generation ids.
- Audit logs avoid full lease text, signed URLs, monetary values, tenant names, and provider payload bodies.
- Provider request and response retention follows the privacy retention matrix in the GA report.
- Stale-generation replay must fail closed with `stale_review_generation`.

Negative tests:
- Organization A cannot search Organization B semantic records.
- Organization A cannot read Organization B enterprise payloads.
- Organization A cannot submit reviewer overrides for Organization B uploaded files.
- Missing or stale generation ids do not mutate reviewer state.

Current automated coverage:
- `npm run test:tenant-isolation` statically verifies Release 6 semantic RLS and membership policy surfaces.
- Deno and frontend tests cover stale generation, schema, and Release 6 semantic behavior.

Open manual validation:
- Confirm policies on a freshly migrated staging database.
- Inspect logs for sensitive payload leakage under live-provider benchmark runs.