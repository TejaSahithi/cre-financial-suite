# Release 10 Legacy Path Inventory

Legacy paths remain controlled until telemetry proves they are unused and replacement parity is verified.

| Path | Owner | Replacement | Risk | Retirement Criteria | Rollback Impact |
| --- | --- | --- | --- | --- | --- |
| legacy extraction fallback | document intelligence | canonical extraction v3+ | stale/noncanonical review input | zero usage, benchmark parity, support signoff | re-enable fallback flag |
| legacy review payload | lease review | enterprise review payload v2 | schema drift | zero org usage, frontend adapter removed | revert org rollout mode |
| old provider wrappers | extraction platform | provider orchestration policy | inconsistent diagnostics | no active provider calls | restore wrapper adapter |
| legacy API contracts | platform API | versioned public API scopes | broad permissions | usage telemetry zero and migration guide published | keep deprecated version supported |
| shadow-only feature flags | release governance | rollout states | unclear production state | owner approval and no dependent orgs | restore flag default |

No path may move past exception-only while `legacy_path_usage` contains active usage.