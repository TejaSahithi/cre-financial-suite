// @ts-nocheck

export function buildPortfolioExport(args: { format: "csv" | "xlsx" | "json"; rows: any[]; scope: any; coverageSummary: any; sourceGenerationDigest: string; filters?: any; includeEvidenceText?: boolean }) {
  if (args.includeEvidenceText) throw new Error("raw_evidence_text_requires_explicit_authorization");
  const metadata = { generatedAt: new Date(0).toISOString(), scope: args.scope, schemaVersion: "portfolio-export-v1", coverageSummary: args.coverageSummary, filters: args.filters ?? {}, sourceGenerationDigest: args.sourceGenerationDigest };
  if (args.format === "json") return { metadata, rows: args.rows };
  const keys = [...new Set(args.rows.flatMap((row) => Object.keys(row)))].sort();
  const csv = [keys.join(","), ...args.rows.map((row) => keys.map((key) => JSON.stringify(row[key] ?? "")).join(","))].join("\n");
  return { metadata, content: csv, format: args.format };
}
