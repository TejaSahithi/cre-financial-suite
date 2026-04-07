// @ts-nocheck
/**
 * Snapshot helper — preserves history while always making the latest row queryable.
 *
 * Strategy:
 *   1. Mark any existing row for (org_id, property_id, engine_type, fiscal_year)
 *      as status='superseded' so it stays in the table for audit/history.
 *   2. INSERT a brand-new row with the fresh outputs.
 *
 * The `latest_snapshots` view (ORDER BY computed_at DESC) always returns the
 * newest row, so the frontend sees current data. Old rows are never deleted.
 *
 * Why not upsert?
 *   Upsert replaces the row in-place — history is lost. This approach keeps
 *   every computation run as a separate immutable record.
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

  // 1. Supersede any existing 'completed' snapshot for this key
  //    (leave 'superseded' rows untouched — they're already history)
  const supersede = supabaseAdmin
    .from("computation_snapshots")
    .update({ status: "superseded", updated_at: now })
    .eq("org_id", data.org_id)
    .eq("engine_type", data.engine_type)
    .eq("fiscal_year", data.fiscal_year)
    .eq("status", "completed");

  if (data.property_id) {
    supersede.eq("property_id", data.property_id);
  } else {
    supersede.is("property_id", null);
  }

  const { error: supersedeErr } = await supersede;
  if (supersedeErr) {
    // Non-fatal — log and continue. The insert below will still create the new row.
    console.warn(
      `[snapshot] supersede failed for ${data.engine_type}/${data.fiscal_year}:`,
      supersedeErr.message,
    );
  }

  // 2. Insert the new snapshot as a fresh row
  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("computation_snapshots")
    .insert({
      org_id: data.org_id,
      property_id: data.property_id ?? null,
      engine_type: data.engine_type,
      fiscal_year: data.fiscal_year,
      inputs: data.inputs,
      outputs: data.outputs,
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
