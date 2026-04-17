/**
 * Utility functions for the CRE Financial Suite.
 */

/**
 * Create a URL path for a page name.
 * @param {string} pageName - The page name (e.g., "Dashboard", "Properties")
 * @param {Record<string, string | number | null | undefined>} [params]
 * @returns {string} The URL path (e.g., "/Dashboard" or "/LeaseReview?id=...")
 */
export function createPageUrl(pageName, params = undefined) {
  const path = `/${String(pageName).replace(/ /g, "-")}`;
  if (!params || typeof params !== "object") return path;

  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  });

  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * Download an array of objects as a CSV file.
 * @param {Array} data - The data objects to export
 * @param {string} filename - The filename for the download
 */
export function downloadCSV(data, filename = "export.csv") {
  if (!data || !data.length) return;
  
  const headers = Object.keys(data[0]);
  const rows = data.map(obj => 
    headers.map(header => {
      const val = obj[header] === null || obj[header] === undefined ? "" : obj[header];
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    }).join(",")
  );
  
  const csvContent = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
