import { describe, expect, it, vi, beforeEach } from "vitest";

let responder;
const queries = [];

function makeQuery(table) {
  const state = { table, filters: [], inFilters: [], orderBy: null, limitValue: null };
  const query = {
    select(columns) {
      state.select = columns;
      return query;
    },
    eq(column, value) {
      state.filters.push({ column, value });
      return query;
    },
    in(column, values) {
      state.inFilters.push({ column, values });
      return query;
    },
    order(column, options) {
      state.orderBy = { column, options };
      return query;
    },
    limit(value) {
      state.limitValue = value;
      return query;
    },
    async maybeSingle() {
      queries.push(state);
      return responder ? responder(state) : { data: null, error: null };
    },
  };
  return query;
}

vi.mock("@/services/supabaseClient", () => ({
  supabase: {
    from: vi.fn((table) => makeQuery(table)),
  },
}));

const { findUploadedFileForLease } = await import("../SourceFileLink.jsx");

describe("findUploadedFileForLease", () => {
  beforeEach(() => {
    queries.length = 0;
    responder = null;
  });

  it("resolves the explicit top-level source_file_id inside the lease organization", async () => {
    responder = (query) => {
      if (query.table === "uploaded_files") {
        expect(query.filters).toEqual(expect.arrayContaining([
          { column: "id", value: "upload-a" },
          { column: "org_id", value: "org-1" },
        ]));
        return { data: { id: "upload-a", org_id: "org-1", file_name: "A.pdf" }, error: null };
      }
      return { data: null, error: null };
    };

    await expect(findUploadedFileForLease({ id: "lease-1", org_id: "org-1", source_file_id: "upload-a" }))
      .resolves.toMatchObject({ id: "upload-a" });
  });

  it("uses explicit document_links when the lease row has no source_file_id", async () => {
    responder = (query) => {
      if (query.table === "document_links") {
        expect(query.filters).toEqual(expect.arrayContaining([
          { column: "entity_type", value: "lease" },
          { column: "entity_id", value: "lease-1" },
          { column: "org_id", value: "org-1" },
        ]));
        return { data: { file_id: "upload-linked" }, error: null };
      }
      if (query.table === "uploaded_files") {
        return { data: { id: "upload-linked", org_id: "org-1", file_name: "Linked.pdf" }, error: null };
      }
      return { data: null, error: null };
    };

    const result = await findUploadedFileForLease({ id: "lease-1", org_id: "org-1", extraction_data: {} });

    expect(result).toMatchObject({ id: "upload-linked" });
    expect(queries.some((query) => query.table === "uploaded_files" && query.filters.some((filter) => filter.column === "reviewed_output"))).toBe(false);
  });

  it("returns null for a missing explicit source link instead of selecting a same-org fallback", async () => {
    responder = (query) => {
      if (query.table === "document_links") return { data: null, error: null };
      throw new Error(`Unexpected ${query.table} lookup without an explicit source id`);
    };

    await expect(findUploadedFileForLease({ id: "lease-missing", org_id: "org-1", extraction_data: {} }))
      .resolves.toBeNull();
  });
});