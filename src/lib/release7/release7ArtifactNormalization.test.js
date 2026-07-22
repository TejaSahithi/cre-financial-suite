import { describe, expect, it } from "vitest";
import { normalizeBenchmarkArtifact } from "../../../scripts/lease-intelligence-benchmark-lib.mjs";

describe("Release 7 benchmark artifact normalization", () => {
  it("strips volatile values and sorts object keys", () => {
    const normalized = normalizeBenchmarkArtifact({ z: 1, createdAt: "now", requestId: "provider", nested: { b: 2, a: 1, latencyMs: 42 } });

    expect(normalized).toEqual({ nested: { a: 1, b: 2 }, z: 1 });
    expect(JSON.stringify(normalized)).toBe('{"nested":{"a":1,"b":2},"z":1}');
  });
});