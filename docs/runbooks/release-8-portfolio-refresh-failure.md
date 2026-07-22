# Release 8 Portfolio Refresh Failure Runbook

1. Check the failed refresh scope and idempotency key.
2. Confirm the source generation is current and not stale.
3. Leave the last valid analytics snapshot active.
4. Rebuild only affected document families when possible.
5. If repeated failures occur, disable `ENABLE_PORTFOLIO_FACT_MATERIALIZATION` for the affected organization.
6. Record diagnostics without tenant names, rent values, evidence text, or signed URLs.
