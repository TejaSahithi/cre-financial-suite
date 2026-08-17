export function vendorDisplayName(vendor = {}) {
  const value = [
    vendor.name,
    vendor.company,
    vendor.vendor_name,
    vendor.contact_name,
    vendor.contact_email,
  ].find((item) => String(item || "").trim());
  if (value) return String(value).trim();
  return vendor.id ? `Vendor ${String(vendor.id).slice(0, 8)}` : "Unnamed Vendor";
}

export function buildCombinedVendors(vendors = [], expenses = []) {
  const map = new Map();
  const nameToKey = new Map();

  (vendors || []).forEach((vendor) => {
    const displayName = vendorDisplayName(vendor);
    const key = vendor.id ? `db:${vendor.id}` : `db-name:${displayName.toLowerCase()}`;
    map.set(key, {
      ...vendor,
      name: displayName,
      company: vendor.company || displayName,
      status: vendor.status || "active",
      isSynthetic: false,
    });
    nameToKey.set(displayName.toLowerCase(), key);
  });

  (expenses || []).forEach((expense) => {
    const vendorName = String(expense.vendor || expense.vendor_name || "").trim();
    if (!vendorName || vendorName === "-" || vendorName.toLowerCase() === "unassigned") return;
    const normalizedName = vendorName.toLowerCase();
    if (nameToKey.has(normalizedName)) return;

    const key = `exp:${normalizedName}`;
    if (!map.has(key)) {
      map.set(key, {
        id: `exp_vendor_${normalizedName}`,
        name: vendorName,
        company: vendorName,
        contact_name: "",
        contact_email: "",
        contact_phone: "",
        category: expense.category || "other",
        payment_terms: "net_30",
        status: "active",
        notes: "Derived from actual expense records",
        isSynthetic: true,
      });
      nameToKey.set(normalizedName, key);
    }
  });

  return Array.from(map.values());
}
