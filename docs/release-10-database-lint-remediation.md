# Release 10 Database Lint Remediation

Release 10 requires database lint debt to be explained before final certification.

Classification model:

- security-critical: fix before broad GA;
- correctness-critical: fix before broad GA;
- compatibility: owner and migration plan required;
- performance: owner, risk, and review date required;
- style-only: accepted debt allowed with owner;
- false positive: document rationale;
- obsolete object: retirement record required.

Current local `supabase db lint --local` still reports pre-existing public-schema function issues unrelated to Release 10 governance tables. These must not remain unexplained in final certification. Release 10 adds the governance table baseline and prevents new Release 10 RLS policy debt through `npm run check:release10-readiness`.