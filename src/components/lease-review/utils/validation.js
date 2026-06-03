/**
 * Compare top-level stored lease values against values extracted from the
 * most recently uploaded source document (via ui_review_payload). Returns an
 * array of mismatch objects when key fields diverge significantly, which
 * usually means the document was uploaded against the wrong lease record.
 */
export function detectDocumentMismatch(lease, uploadedFile) {
  const mismatches = [];
  if (!lease || !uploadedFile) return mismatches;

  const payload = uploadedFile?.ui_review_payload;
  const extractedRecord = (payload?.records || payload?.rows || [])[0];
  const extractedFields = extractedRecord?.fields || {};

  const extractedVal = (key) => {
    const field = extractedFields[key];
    if (!field) return null;
    return field.value ?? field.normalized_value ?? null;
  };

  // Square footage — flag if they differ by more than 10 %.
  const storedSqft = Number(lease.square_footage || 0);
  const exSqft = Number(extractedVal("square_footage") || 0);
  if (storedSqft > 0 && exSqft > 0 && Math.abs(storedSqft - exSqft) / storedSqft > 0.1) {
    mismatches.push({
      field: "square_footage",
      label: "Square Footage",
      stored: storedSqft,
      extracted: exSqft,
      detail: `Lease record shows ${storedSqft.toLocaleString()} RSF but document shows ${exSqft.toLocaleString()} RSF — may be a different property or lease.`,
    });
  }

  // Premises address — flag if the street numbers differ.
  const storedAddr = String(lease.property_address || "").trim();
  const exAddr = String(extractedVal("property_address") || "").trim();
  if (storedAddr && exAddr) {
    const storedStreet = storedAddr.match(/^\d+/)?.[0];
    const exStreet = exAddr.match(/^\d+/)?.[0];
    if (storedStreet && exStreet && storedStreet !== exStreet) {
      mismatches.push({
        field: "property_address",
        label: "Premises Address",
        stored: storedAddr,
        extracted: exAddr,
        detail: `Lease record shows "${storedAddr}" but document shows "${exAddr}".`,
      });
    }
  }

  // Tenant name — flag if they are completely different strings after normalization.
  const storedTenant = String(lease.tenant_name || "").trim();
  const exTenant = String(extractedVal("tenant_name") || "").trim();
  if (storedTenant && exTenant) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
    const sn = norm(storedTenant);
    const en = norm(exTenant);
    if (sn !== en && !sn.includes(en) && !en.includes(sn)) {
      mismatches.push({
        field: "tenant_name",
        label: "Tenant Name",
        stored: storedTenant,
        extracted: exTenant,
        detail: `Lease record shows "${storedTenant}" but document shows "${exTenant}".`,
      });
    }
  }

  // Expiration date — flag if they differ by more than 30 days.
  const storedEnd = lease.expiration_date || lease.end_date;
  const exEnd = extractedVal("expiration_date") || extractedVal("end_date");
  if (storedEnd && exEnd) {
    const diff = Math.abs(new Date(storedEnd).getTime() - new Date(exEnd).getTime());
    if (Number.isFinite(diff) && diff > 30 * 86_400_000) {
      mismatches.push({
        field: "expiration_date",
        label: "Expiration Date",
        stored: storedEnd,
        extracted: exEnd,
        detail: `Lease record expires ${storedEnd} but document shows ${exEnd}.`,
      });
    }
  }

  return mismatches;
}

export function detectFieldConflicts(lease) {
  const conflicts = [];
  const monthly = Number(lease?.monthly_rent || 0);
  const annual = Number(lease?.annual_rent || 0);
  if (monthly > 0 && annual > 0) {
    const expectedAnnual = monthly * 12;
    if (Math.abs(expectedAnnual - annual) / Math.max(expectedAnnual, annual) > 0.05) {
      conflicts.push({
        field_key: "monthly_rent",
        label: "Monthly Rent × 12 ≠ Annual Rent",
        detail: `${monthly.toLocaleString()} × 12 = ${expectedAnnual.toLocaleString()} vs annual ${annual.toLocaleString()}`,
      });
    }
  }
  const start = lease?.commencement_date || lease?.start_date;
  const end = lease?.expiration_date || lease?.end_date;
  if (start && end && new Date(start) >= new Date(end)) {
    conflicts.push({
      field_key: "commencement_date",
      label: "Commencement date is on or after expiration",
      detail: `${start} → ${end}`,
    });
  }
  const leaseDate = lease?.lease_date;
  if (leaseDate && start && new Date(leaseDate) > new Date(start)) {
    conflicts.push({
      field_key: "lease_date",
      label: "Lease signed after commencement",
      detail: `signed ${leaseDate}, commences ${start}`,
    });
  }
  // Commencement equals the lease-signing date — almost always means the
  // extractor put the signing date into start_date by mistake. Real CRE
  // leases rarely start the day they're signed.
  if (leaseDate && start && new Date(leaseDate).toDateString() === new Date(start).toDateString()) {
    conflicts.push({
      field_key: "commencement_date",
      label: "Commencement date equals lease signing date",
      detail: `Likely extractor copied the signing date (${leaseDate}) into start_date — verify the actual commencement.`,
    });
  }
  // Term shorter than 30 days — usually means end_date got the wrong year
  // (e.g. "January 31" was assumed to be the same year as the start).
  if (start && end) {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      const days = Math.round((endMs - startMs) / 86400000);
      if (days < 30) {
        conflicts.push({
          field_key: "expiration_date",
          label: `Lease term is only ${days} day(s)`,
          detail: `${start} → ${end} is suspiciously short. The expiration date may have been extracted with the wrong year (commonly +1 year off).`,
        });
      }
    }
  }
  return conflicts;
}
