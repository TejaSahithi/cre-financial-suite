-- P2.1 round-2 correction #3 — additive parent-key compatibility constraints
-- on the existing P1 provenance tables, so the P2 claims ledger can FK
-- against a run/invocation/artifact's full identity (run+file+generation,
-- or run+stage) in one composite key, not just (id, org_id).
--
-- Purely additive: new UNIQUE constraints only, no column/data/behavior
-- change to any P1 table or RPC.

-- lease_claims.(extraction_run_id, uploaded_file_id, generation_id, org_id)
-- will FK against this -- catches a claim referencing the right run but the
-- wrong file or wrong generation in one FK, not just the right org.
ALTER TABLE public.extraction_runs
  ADD CONSTRAINT extraction_runs_claim_link_unique
  UNIQUE (id, uploaded_file_id, generation_id, org_id);

-- lease_claims.(provider_invocation_id, extraction_stage_run_id, extraction_run_id, org_id)
-- will FK against this -- catches a claim referencing a provider invocation
-- from another stage/run, not just the right org.
ALTER TABLE public.provider_invocations
  ADD CONSTRAINT provider_invocations_claim_link_unique
  UNIQUE (id, stage_run_id, run_id, org_id);

-- lease_claim_evidence's artifact linkage will FK against this -- catches
-- evidence pointing at an artifact from another run, not just the right org.
ALTER TABLE public.extraction_artifacts
  ADD CONSTRAINT extraction_artifacts_claim_link_unique
  UNIQUE (id, run_id, org_id);
