import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

Deno.test("bounded enrich readiness migration treats enrich_truth_assembly as enrichment terminal", () => {
  const sql = Deno.readTextFileSync(
    "supabase/migrations/20269900000044_bounded_enrich_readiness.sql",
  );
  assert(sql.includes("v_bounded_final_job public.pipeline_jobs%ROWTYPE"));
  assert(sql.includes("stage = 'enrich_truth_assembly'"));
  assert(sql.includes("COALESCE(v_enrich_job.id, v_bounded_final_job.id)"));
  assert(sql.includes("ENRICHMENT_IN_PROGRESS"));
});
