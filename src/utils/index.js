/**
 * Utility functions for the CRE Financial Suite.
 */

/**
 * Create a URL path for a page name.
 * @param {string} pageName - The page name (e.g., "Dashboard", "Properties")
 * @returns {string} The URL path (e.g., "/Dashboard")
 */
export function createPageUrl(pageName) {
  return `/${pageName}`;
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
