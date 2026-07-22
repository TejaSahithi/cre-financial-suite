// @ts-nocheck

export function paginateRows(rows: any[], args: { cursor?: string | null; limit?: number }) {
  const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200);
  const sorted = [...rows].sort((a, b) => String(a.id ?? a.eventId).localeCompare(String(b.id ?? b.eventId)));
  const startIndex = args.cursor ? Math.max(0, sorted.findIndex((row) => String(row.id ?? row.eventId) === args.cursor) + 1) : 0;
  const page = sorted.slice(startIndex, startIndex + limit);
  return { data: page, nextCursor: page.length === limit ? String(page.at(-1)?.id ?? page.at(-1)?.eventId) : null, limit };
}

export function buildIntegrationApiResponse(resource: string, rows: any[], args: any = {}) {
  return { schemaVersion: "integration-api-v1", resource, ...paginateRows(rows, args) };
}
