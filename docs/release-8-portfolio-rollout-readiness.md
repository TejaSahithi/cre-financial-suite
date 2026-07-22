# Release 8 Portfolio Rollout Readiness

Release 8 is pilot-ready only when portfolio facts, analytics snapshots, lineage, risk findings, search, exports, and reconciliation all pass scoped checks.

Required gates:

- portfolio migration applied with RLS enabled;
- Release 3 through Release 7 regressions remain green;
- portfolio benchmark report passes all scenarios;
- exports are role-restricted and omit raw evidence text by default;
- mixed currencies or units are excluded with warnings unless a configured conversion policy exists;
- rent roll reconciliation remains advisory and never writes back automatically;
- portfolio publication remains separate from document approval.

Rollout order: internal, shadow, pilot, production. Production requires a human go/no-go and rollback owner.
