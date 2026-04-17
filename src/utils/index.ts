export function createPageUrl(
  pageName: string,
  params?: Record<string, string | number | boolean | null | undefined>,
) {
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
