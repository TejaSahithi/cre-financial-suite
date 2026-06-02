export function matchBuildingAndUnit({ approvedLease, candidateBuildings, candidateUnits }) {
  const extractionData = approvedLease?.extraction_data || {};
  const extractedFields = approvedLease?.extracted_fields
    || extractionData.extracted_fields
    || extractionData.fields
    || {};

  const fieldVal = (key) => {
    const entry = extractedFields?.[key];
    if (entry == null) return null;
    if (typeof entry === "object") return entry.value ?? entry.raw_value ?? null;
    return entry;
  };

  const extractedBuildingName = String(
    fieldVal("building_name")
    ?? fieldVal("building")
    ?? approvedLease?.building_name
    ?? "",
  ).trim();

  const extractedUnitText = String(
    fieldVal("unit_number")
    ?? fieldVal("suite_number")
    ?? fieldVal("suite")
    ?? approvedLease?.unit_number
    ?? "",
  ).trim();

  const premisesAddress = String(
    fieldVal("premises_address")
    ?? fieldVal("property_address")
    ?? "",
  ).trim();

  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  const updates = {};

  if (!approvedLease?.building_id && (extractedBuildingName || premisesAddress) && candidateBuildings?.length) {
    const needles = [extractedBuildingName, premisesAddress].filter(Boolean).map(norm);
    const match = candidateBuildings.find((b) => {
      const haystack = [b.name, b.building_id_code].map(norm).filter(Boolean);
      return haystack.some((h) => needles.some((n) => n && (n.includes(h) || h.includes(n))));
    });
    if (match?.id) updates.building_id = match.id;
  }

  const buildingIdForUnit = updates.building_id || approvedLease?.building_id || null;
  if (!approvedLease?.unit_id && extractedUnitText && candidateUnits?.length) {
    const needle = norm(extractedUnitText);
    const scoped = buildingIdForUnit
      ? candidateUnits.filter((u) => u.building_id === buildingIdForUnit)
      : candidateUnits;
    const match = (scoped.length ? scoped : candidateUnits).find((u) => {
      const haystack = [u.unit_number, u.unit_id_code].map(norm).filter(Boolean);
      return haystack.some((h) => h && (h === needle || h.includes(needle) || needle.includes(h)));
    });
    if (match?.id) {
      updates.unit_id = match.id;
      if (!updates.building_id && match.building_id) updates.building_id = match.building_id;
    }
  }

  return updates;
}
