export function createPageUrl(
  pageName: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): string {
  const path = '/' + pageName.replace(/ /g, '-');
  if (!params) return path;

  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  });

  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export function createAbsolutePageUrl(
  pageName: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): string {
  const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env || {};
  const envBaseUrl = String(viteEnv.VITE_APP_BASE_URL || '').trim().replace(/\/$/, '');
  const baseUrl = envBaseUrl && !/(vercel\.app|localhost)/i.test(envBaseUrl)
    ? envBaseUrl
    : 'https://www.proformaos.ai';
  return new URL(createPageUrl(pageName, params), baseUrl).toString();
}

export function downloadCSV(
  data: Record<string, unknown>[],
  filename = 'export.csv',
): void {
  if (!data || !data.length) return;

  const headers = Object.keys(data[0]);
  const rows = data.map((obj) =>
    headers
      .map((header) => {
        const val = obj[header] === null || obj[header] === undefined ? '' : obj[header];
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
      })
      .join(','),
  );

  const csvContent = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');

  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}
