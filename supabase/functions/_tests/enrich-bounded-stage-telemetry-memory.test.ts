// @ts-nocheck
//
// Bounded-enrich stage telemetry must not copy the payload.
//
// PRODUCTION FAILURE THIS ADDRESSES
//   enrich_evidence_expenses_and_cam died with WORKER_RESOURCE_LIMIT
//   ("not having enough compute resources") while enrich_evidence_core_terms
//   and enrich_evidence_rent_and_charges completed, on two separate leases.
//
//   startBoundedStageTelemetry() measured input_bytes/output_bytes with
//   `new TextEncoder().encode(JSON.stringify(value)).length` on the stage
//   INPUT and the stage OUTPUT. That is ~3x peak memory for a diagnostic
//   number: the payload, plus a full JSON string copy, plus a full byte-array
//   copy — inside a worker already holding the document. It also scales with
//   pipeline position, because each successive enrich_evidence_* stage
//   carries a larger accumulated payload, which is consistent with the third
//   domain stage being the one that dies.
//
// These tests prove the copy no longer happens by default. They use a toJSON
// tripwire: JSON.stringify MUST call toJSON, so if it is ever called again
// these fail immediately rather than silently regressing memory.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { startBoundedStageTelemetry } from "../_shared/extraction/enrich-bounded-stage/telemetry.ts";

const FLAG = "LEASE_ENRICH_STAGE_TELEMETRY_MEASURE_BYTES";

function tripwirePayload() {
  let serializeCount = 0;
  const payload = {
    // Stands in for normalized_output / stageData / docling_raw.
    bulk: "x".repeat(1024),
    toJSON() {
      serializeCount++;
      return { bulk: this.bulk };
    },
  };
  return { payload, serialized: () => serializeCount };
}

function withFlag(value: string | undefined, fn: () => void) {
  const original = Deno.env.get(FLAG);
  try {
    if (value === undefined) Deno.env.delete(FLAG);
    else Deno.env.set(FLAG, value);
    fn();
  } finally {
    if (original === undefined) Deno.env.delete(FLAG);
    else Deno.env.set(FLAG, original);
  }
}

Deno.test("telemetry: by default the stage input and output are never serialized", () => {
  withFlag(undefined, () => {
    const input = tripwirePayload();
    const output = tripwirePayload();

    const telemetry = startBoundedStageTelemetry({
      stage: "enrich_evidence_expenses_and_cam",
      stageVersion: "v1",
      generationId: "gen-1",
      input: input.payload,
    });
    const emitted = telemetry.finish({ output: output.payload, pageCount: 42, candidateCount: 7 });

    // The load-bearing assertions: no copy of either payload was made.
    assertEquals(input.serialized(), 0);
    assertEquals(output.serialized(), 0);

    // The contract already documents these as best-effort and nullable.
    assertEquals(emitted.input_bytes, null);
    assertEquals(emitted.output_bytes, null);
  });
});

Deno.test("telemetry: the cheap diagnostics that do NOT require a copy are still emitted", () => {
  withFlag(undefined, () => {
    const telemetry = startBoundedStageTelemetry({
      stage: "enrich_evidence_expenses_and_cam",
      stageVersion: "v1",
      generationId: "gen-1",
      input: { big: "x".repeat(512) },
    });
    const emitted = telemetry.finish({
      output: { big: "y".repeat(512) },
      pageCount: 42,
      tableCount: 3,
      candidateCount: 7,
      splitCount: 2,
      reusedFromCache: false,
      errorCode: null,
    });

    // Losing the byte counts must not cost the useful signal.
    assertEquals(emitted.stage, "enrich_evidence_expenses_and_cam");
    assertEquals(emitted.page_count, 42);
    assertEquals(emitted.table_count, 3);
    assertEquals(emitted.candidate_count, 7);
    assertEquals(emitted.split_count, 2);
    assertEquals(emitted.reused_from_cache, false);
    assertEquals(emitted.error_code, null);
    assertEquals(typeof emitted.duration_ms, "number");
  });
});

Deno.test("telemetry: a null payload still reports 0 bytes without serializing", () => {
  withFlag(undefined, () => {
    const telemetry = startBoundedStageTelemetry({
      stage: "enrich_evidence_expenses_and_cam", stageVersion: "v1", generationId: null, input: null,
    });
    const emitted = telemetry.finish({ output: null });
    assertEquals(emitted.input_bytes, 0);
    assertEquals(emitted.output_bytes, 0);
  });
});

Deno.test("telemetry: byte measurement can be re-enabled deliberately for debugging", () => {
  for (const enabled of ["1", "true", "TRUE"]) {
    withFlag(enabled, () => {
      const input = tripwirePayload();
      const telemetry = startBoundedStageTelemetry({
        stage: "enrich_evidence_expenses_and_cam", stageVersion: "v1", generationId: null, input: input.payload,
      });
      const emitted = telemetry.finish({});
      assertEquals(input.serialized(), 1, `expected opt-in measurement for ${enabled}`);
      assertEquals(typeof emitted.input_bytes, "number");
    });
  }
});

Deno.test("telemetry: an unset, blank or unrecognised flag value leaves measurement OFF", () => {
  for (const value of [undefined, "", "  ", "0", "false", "yes", "on"]) {
    withFlag(value, () => {
      const input = tripwirePayload();
      const telemetry = startBoundedStageTelemetry({
        stage: "enrich_evidence_expenses_and_cam", stageVersion: "v1", generationId: null, input: input.payload,
      });
      telemetry.finish({});
      assertEquals(input.serialized(), 0, `expected measurement OFF for ${JSON.stringify(value)}`);
    });
  }
});
