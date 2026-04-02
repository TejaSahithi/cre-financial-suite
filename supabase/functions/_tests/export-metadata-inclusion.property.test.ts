// @ts-nocheck
/**
 * Property-Based Test: Export Metadata Inclusion
 * Feature: backend-driven-pipeline, Task 18.4
 *
 * **Validates: Requirements 18.5**
 *
 * Property 47: Every export must include metadata (export_date, property_name, fiscal_year).
 * addMetadata always produces result containing export_date, property_name, fiscal_year strings.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure function under test
// ---------------------------------------------------------------------------

interface ExportMetadata {
  export_date: string;
  property_name: string;
  fiscal_year: string | number;
  [key: string]: any;
}

/**
 * Prepends metadata rows to CSV text.
 * Adds export_date, property_name, and fiscal_year as comment-style header rows.
 */
function addMetadata(csvText: string, metadata: ExportMetadata): string {
  const metaLines = [
    `# export_date: ${metadata.export_date}`,
    `# property_name: ${metadata.property_name}`,
    `# fiscal_year: ${metadata.fiscal_year}`,
  ];

  // Add any additional metadata fields
  for (const [key, value] of Object.entries(metadata)) {
    if (!["export_date", "property_name", "fiscal_year"].includes(key)) {
      metaLines.push(`# ${key}: ${value}`);
    }
  }

  return [...metaLines, csvText].join("\n");
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const exportDateArb = fc.date({
  min: new Date("2020-01-01"),
  max: new Date("2030-12-31"),
}).map((d) => d.toISOString().split("T")[0]);

const propertyNameArb = fc.string({ minLength: 1, maxLength: 100 }).filter(
  (s) => s.trim().length > 0 && !s.includes("\n"),
);

const fiscalYearArb = fc.oneof(
  fc.integer({ min: 2000, max: 2030 }).map(String),
  fc.integer({ min: 2000, max: 2030 }),
);

const metadataArb = fc.record({
  export_date: exportDateArb,
  property_name: propertyNameArb,
  fiscal_year: fiscalYearArb,
});

const csvTextArb = fc.string({ minLength: 0, maxLength: 500 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 47: addMetadata result always contains export_date",
  fn: () => {
    fc.assert(
      fc.property(csvTextArb, metadataArb, (csvText, metadata) => {
        const result = addMetadata(csvText, metadata);
        assert(
          result.includes(`export_date: ${metadata.export_date}`),
          `Result must contain export_date '${metadata.export_date}'`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 47: addMetadata result always contains property_name",
  fn: () => {
    fc.assert(
      fc.property(csvTextArb, metadataArb, (csvText, metadata) => {
        const result = addMetadata(csvText, metadata);
        assert(
          result.includes(`property_name: ${metadata.property_name}`),
          `Result must contain property_name '${metadata.property_name}'`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 47: addMetadata result always contains fiscal_year",
  fn: () => {
    fc.assert(
      fc.property(csvTextArb, metadataArb, (csvText, metadata) => {
        const result = addMetadata(csvText, metadata);
        assert(
          result.includes(`fiscal_year: ${metadata.fiscal_year}`),
          `Result must contain fiscal_year '${metadata.fiscal_year}'`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 47: addMetadata preserves the original CSV content",
  fn: () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
        metadataArb,
        (csvText, metadata) => {
          const result = addMetadata(csvText, metadata);
          assert(
            result.includes(csvText),
            "Result must contain the original CSV text",
          );
        },
      ),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 47: metadata rows appear before CSV content",
  fn: () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => !s.startsWith("#")),
        metadataArb,
        (csvText, metadata) => {
          const result = addMetadata(csvText, metadata);
          const exportDateIdx = result.indexOf(`export_date: ${metadata.export_date}`);
          const csvIdx = result.indexOf(csvText);

          assert(
            exportDateIdx < csvIdx,
            "Metadata must appear before CSV content",
          );
        },
      ),
      { numRuns: 100 },
    );
  },
});
