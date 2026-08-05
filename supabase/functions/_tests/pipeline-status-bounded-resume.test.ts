// @ts-nocheck
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const realServe = Deno.serve;
(Deno as any).serve = (..._args: unknown[]) => ({
  finished: Promise.resolve(),
  shutdown: () => {},
});
const { __test__ } = await import("../pipeline-status/index.ts");
(Deno as any).serve = realServe;

const ORG_ID = "org-1";
const FILE_ID = "file-1";
const GEN_ID = "gen-1";

function makeMockSupabase(
  { pipelineJobs = [], rpcResult = null }: {
    pipelineJobs?: any[];
    rpcResult?: any;
  },
) {
  const rpcCalls: Array<{ name: string; args: any }> = [];

  function from(table: string) {
    const builder: any = {
      _filters: {} as Record<string, any>,
      _inFilters: {} as Record<string, any[]>,
      _likeFilters: {} as Record<string, string>,
      _limit: null as number | null,
      select() {
        return builder;
      },
      eq(col: string, val: any) {
        builder._filters[col] = val;
        return builder;
      },
      in(col: string, values: any[]) {
        builder._inFilters[col] = values;
        return builder;
      },
      like(col: string, pattern: string) {
        builder._likeFilters[col] = pattern;
        return builder;
      },
      order() {
        return builder;
      },
      limit(value: number) {
        builder._limit = value;
        return builder;
      },
    };

    function runQuery() {
      if (table !== "pipeline_jobs") {
        return Promise.resolve({ data: null, error: null });
      }
      let rows = [...pipelineJobs];
      for (const [col, val] of Object.entries(builder._filters)) {
        rows = rows.filter((row) => row?.[col] === val);
      }
      for (const [col, values] of Object.entries(builder._inFilters)) {
        rows = rows.filter((row) => (values as any[]).includes(row?.[col]));
      }
      for (const [col, pattern] of Object.entries(builder._likeFilters)) {
        const regex = new RegExp(`^${String(pattern).replace(/%/g, ".*")}$`);
        rows = rows.filter((row) => regex.test(String(row?.[col] ?? "")));
      }
      if (builder._limit != null) rows = rows.slice(0, builder._limit);
      return Promise.resolve({ data: rows, error: null });
    }

    builder.then = (resolve: any) => runQuery().then(resolve);
    return builder;
  }

  async function rpc(name: string, args: any) {
    rpcCalls.push({ name, args });
    if (rpcResult) return rpcResult;
    return {
      data: { created: true, job_id: "enrich-job-1", generation_id: GEN_ID },
      error: null,
    };
  }

  return { from, rpc, __rpcCalls: rpcCalls };
}

Deno.test("pipeline-status bounded resume waits for normalize when active-generation normalized_output is missing", async () => {
  const supabaseAdmin = makeMockSupabase({ pipelineJobs: [] });
  const result = await __test__.maybeResumeBoundedEnrichment(supabaseAdmin, {
    id: FILE_ID,
    org_id: ORG_ID,
    module_type: "leases",
    active_generation_id: GEN_ID,
    enrichment_status: "pending",
    review_readiness: "pending",
    normalized_output: null,
  }, ORG_ID);

  assertEquals(result, {
    waiting_for_stage: "normalize",
    reason: "normalized_output_not_ready",
  });
  assertEquals(supabaseAdmin.__rpcCalls.length, 0);
});

Deno.test("pipeline-status bounded resume waits while parse or normalize job is still active", async () => {
  const supabaseAdmin = makeMockSupabase({
    pipelineJobs: [{
      id: "normalize-job-1",
      uploaded_file_id: FILE_ID,
      org_id: ORG_ID,
      generation_id: GEN_ID,
      stage: "normalize",
      status: "running",
    }],
  });

  const result = await __test__.maybeResumeBoundedEnrichment(supabaseAdmin, {
    id: FILE_ID,
    module_type: "leases",
    active_generation_id: GEN_ID,
    enrichment_status: "pending",
    review_readiness: "pending",
    normalized_output: {
      rows: [{ tenant_name: "Acme" }],
      metadata: { generation_id: GEN_ID },
    },
  }, ORG_ID);

  assertEquals(result, {
    waiting_for_stage: "normalize",
    job_id: "normalize-job-1",
    job_status: "running",
  });
  assertEquals(supabaseAdmin.__rpcCalls.length, 0);
});

Deno.test("pipeline-status bounded resume rejects stale normalized_output from a prior generation", async () => {
  assertEquals(
    __test__.normalizedOutputReadyForBoundedEnrichment({
      normalized_output: {
        rows: [{ tenant_name: "Old Tenant" }],
        metadata: { generation_id: "old-gen" },
      },
    }, GEN_ID),
    false,
  );

  assertEquals(
    __test__.normalizedOutputReadyForBoundedEnrichment({
      normalized_output: {
        rows: [{ tenant_name: "Current Tenant" }],
        metadata: { generation_id: GEN_ID },
      },
    }, GEN_ID),
    true,
  );
});
