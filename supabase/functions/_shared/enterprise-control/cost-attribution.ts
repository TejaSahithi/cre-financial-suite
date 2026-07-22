// @ts-nocheck
export function attributeCost(record) {
  return { organizationId: record.organizationId, stage: record.stage, units: record.units, unitCost: record.unitCost, totalCost: Number(record.units) * Number(record.unitCost), currency: record.currency || "USD" };
}