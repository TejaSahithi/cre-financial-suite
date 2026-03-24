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
