# Release 9 Dead-Letter Replay Runbook

Scope: an integration delivery has exhausted retry policy or was classified as permanently failed.

Triage:

- locate the `integration_dead_letters` row and confirm organization, event id, endpoint id, and failure reason;
- review retry history before replaying;
- confirm the source event still exists in `integration_events` and its payload hash matches the dead-letter payload;
- validate that the target endpoint still subscribes to the event key.

Replay criteria:

- endpoint owner confirms the receiver is fixed;
- credential fingerprint is current;
- payload contract version is still supported;
- replay is approved by the owning operations lead.

Replay steps:

1. Mark the dead-letter as under recovery with owner and reason.
2. Queue a new delivery from the preserved event payload and endpoint subscription.
3. Preserve the prior dead-letter row for audit history.
4. Close the incident only after a successful delivery attempt is recorded.

Do not mutate the original event payload during replay. Release 9 events are immutable audit records.