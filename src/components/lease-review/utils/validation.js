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
