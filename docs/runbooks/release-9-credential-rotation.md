# Release 9 Credential Rotation Runbook

Scope: webhook, connector, or public API integration credentials must be rotated.

Rotation triggers:

- scheduled secret expiration;
- endpoint owner offboarding;
- suspected exposure;
- repeated authentication failures;
- vendor security request.

Procedure:

1. Create a new credential record with a new secret fingerprint and `pending` status.
2. Coordinate with the endpoint owner to accept both old and new secrets during the rotation window.
3. Send a signed test delivery or connector probe with the new credential.
4. Promote the new credential to `active` after verification succeeds.
5. Revoke the previous credential and record the rotation reason in metadata.
6. Monitor delivery attempts for authentication failures during the next retry window.

Controls:

- never store plaintext secrets in integration telemetry;
- never expose credential ciphertext in public API responses;
- connector probes must remain read-only;
- failed rotations should disable only the affected endpoint, not the event bus.