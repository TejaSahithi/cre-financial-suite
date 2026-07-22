# Release 9 Webhook Delivery Failure Runbook

Scope: signed outbound webhook delivery fails, retries are accumulating, or an endpoint moves to dead-letter.

Immediate checks:

- confirm `ENABLE_WEBHOOKS` is enabled only for the intended organization;
- inspect `integration_deliveries` for status, attempt count, and next retry time;
- inspect `integration_delivery_attempts` for HTTP status, latency, and failure class;
- verify endpoint target URL, supported event keys, and credential fingerprint;
- confirm the receiver accepts `X-CRE-Event-Id`, `X-CRE-Timestamp`, and `X-CRE-Signature`.

Recovery:

1. For 408, 429, or 5xx responses, allow retry policy to continue unless the endpoint owner asks to pause.
2. For 400, 401, 403, 404, or 422 responses, stop retries and correct endpoint configuration or payload contract mapping.
3. Rotate the endpoint secret if signature verification fails and no deployment change explains it.
4. Replay from `integration_dead_letters` only after the endpoint owner confirms the receiver is healthy.

Never edit canonical facts to repair a webhook delivery. Delivery recovery must happen through endpoint configuration, retry, or dead-letter replay.