// @ts-nocheck
/**
 * Snapshot helper - preserves history while always making the latest row queryable.
 *
 * Strategy:
 *   1. Mark any existing row for the same logical compute scope as status='superseded'.
 *   2. INSERT a brand-new row with normalized inputs/outputs and deterministic metadata.
 *
 * Scope note:
 *   Some engines, such as CAM, persist property-, building-, and unit-level snapshots
 *   under the same (org, property, engine, fiscal_year) tuple. We therefore supersede
 *   by logical scope, not by property/year alone.
 */

export interface SnapshotData {
  org_id: string;
  property_id: string | null;
  engine_type: string;
  fiscal_year: number;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  computed_by?: string;
}

function normalizeForSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForSnapshot);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalizeForSnapshot((value as Record<string, unknown>)[key]);
        return acc;
      }, {} as Record<string, unknown>);
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForSnapshot(value));
}

export async function computeInputFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getScopeLevel(inputs: Record<string, unknown>, outputs: Record<string, unknown>): string {
  return String(inputs?.scope_level ?? outputs?.scope_level ?? "property");
}

function getScopeId(
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
  propertyId: string | null,
): string {
  return String(inputs?.scope_id ?? outputs?.scope_id ?? propertyId ?? "global");
}

function getScopeKey(
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
  propertyId: string | null,
): string {
  return `${getScopeLevel(inputs, outputs)}:${getScopeId(inputs, outputs, propertyId)}`;
}

async function enrichInputs(inputs: Record<string, unknown>) {
  const normalizedInputs = (normalizeForSnapshot(inputs ?? {}) ?? {}) as Record<string, unknown>;
  const existingMeta =
    normalizedInputs._compute && typeof normalizedInputs._compute === "object"
      ? { ...(normalizedInputs._compute as Record<string, unknown>) }
      : {};

  if (!existingMeta.input_fingerprint) {
    existingMeta.input_fingerprint = await computeInputFingerprint(normalizedInputs);
  }

  return {
    ...normalizedInputs,
    _compute: existingMeta,
  };
}

export async function findMatchingCompletedSnapshot(
  supabaseAdmin: any,
  data: SnapshotData,
) {
  const inputs = await enrichInputs(data.inputs);
  const outputs = (normalizeForSnapshot(data.outputs ?? {}) ?? {}) as Record<string, unknown>;
  const targetScopeKey = getScopeKey(inputs, outputs, data.property_id ?? null);
  const targetFingerprint = String(
    (inputs._compute as Record<string, unknown>)?.input_fingerprint ?? "",
  );

  const query = supabaseAdmin
    .from("computation_snapshots")
    .select("id, property_id, inputs, outputs, computed_at, status")
    .eq("org_id", data.org_id)
    .eq("engine_type", data.engine_type)
    .eq("fiscal_year", data.fiscal_year)
    .eq("status", "completed");

  if (data.property_id) {
    query.eq("property_id", data.property_id);
  } else {
    query.is("property_id", null);
  }

  const { data: candidates, error } = await query.order("computed_at", { ascending: false });
  if (error || !candidates?.length) {
    return null;
  }

  return candidates.find((candidate: any) => {
    const candidateInputs = (candidate?.inputs ?? {}) as Record<string, unknown>;
    const candidateOutputs = (candidate?.outputs ?? {}) as Record<string, unknown>;
    const candidateScopeKey = getScopeKey(
      candidateInputs,
      candidateOutputs,
      candidate?.property_id ?? null,
    );
    const candidateFingerprint = String(
      candidateInputs?._compute?.input_fingerprint ?? "",
    );
    return candidateScopeKey === targetScopeKey && candidateFingerprint === targetFingerprint;
  }) ?? null;
}

/**
 * Save a computation snapshot, preserving previous runs as 'superseded'.
 *
 * @returns The id of the newly inserted snapshot row, or null on error.
 */
export async function saveSnapshot(
  supabaseAdmin: any,
  data: SnapshotData,
): Promise<string | null> {
  const now = new Date().toISOString();
  const inputs = await enrichInputs(data.inputs);
  const outputs = (normalizeForSnapshot(data.outputs ?? {}) ?? {}) as Record<string, unknown>;
  const targetScopeKey = getScopeKey(inputs, outputs, data.property_id ?? null);

  const query = supabaseAdmin
    .from("computation_snapshots")
    .select("id, property_id, inputs, outputs")
    .eq("org_id", data.org_id)
    .eq("engine_type", data.engine_type)
    .eq("fiscal_year", data.fiscal_year)
    .eq("status", "completed");

  if (data.property_id) {
    query.eq("property_id", data.property_id);
  } else {
    query.is("property_id", null);
  }

  const { data: existingRows, error: existingErr } = await query;
  if (existingErr) {
    console.warn(
      `[snapshot] existing snapshot lookup failed for ${data.engine_type}/${data.fiscal_year}:`,
      existingErr.message,
    );
  }

  const idsToSupersede = (existingRows ?? [])
    .filter((row: any) => {
      const rowInputs = (row?.inputs ?? {}) as Record<string, unknown>;
      const rowOutputs = (row?.outputs ?? {}) as Record<string, unknown>;
      return getScopeKey(rowInputs, rowOutputs, row?.property_id ?? null) === targetScopeKey;
    })
    .map((row: any) => row.id)
    .filter(Boolean);

  if (idsToSupersede.length > 0) {
    const { error: supersedeErr } = await supabaseAdmin
      .from("computation_snapshots")
      .update({ status: "superseded", updated_at: now })
      .in("id", idsToSupersede);

    if (supersedeErr) {
      console.warn(
        `[snapshot] supersede failed for ${data.engine_type}/${data.fiscal_year}:`,
        supersedeErr.message,
      );
    }
  }

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("computation_snapshots")
    .insert({
      org_id: data.org_id,
      property_id: data.property_id ?? null,
      engine_type: data.engine_type,
      fiscal_year: data.fiscal_year,
      inputs,
      outputs,
      status: "completed",
      computed_at: now,
      computed_by: data.computed_by ?? null,
    })
    .select("id")
    .single();

  if (insertErr) {
    console.error(
      `[snapshot] insert failed for ${data.engine_type}/${data.fiscal_year}:`,
      insertErr.message,
    );
    return null;
  }

  return inserted?.id ?? null;
}
