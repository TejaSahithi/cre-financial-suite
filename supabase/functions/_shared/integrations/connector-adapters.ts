// @ts-nocheck

export const CONNECTOR_ADAPTERS = {
  sap: { category: "erp", receives: ["lease-fact-v1", "portfolio-summary-v1", "critical-dates-v1"], writesBack: false },
  oracle: { category: "erp", receives: ["lease-fact-v1", "portfolio-summary-v1"], writesBack: false },
  yardi: { category: "erp", receives: ["lease-fact-v1", "critical-dates-v1"], writesBack: false },
  mri: { category: "erp", receives: ["lease-fact-v1", "critical-dates-v1"], writesBack: false },
  dynamics: { category: "erp_crm", receives: ["lease-fact-v1", "portfolio-summary-v1"], writesBack: false },
  netsuite: { category: "erp", receives: ["lease-fact-v1", "portfolio-summary-v1"], writesBack: false },
  maximo: { category: "cmms", receives: ["obligations-v1", "critical-dates-v1"], writesBack: false },
  salesforce: { category: "crm", receives: ["lease-fact-v1", "risk-findings-v1"], writesBack: false },
  sharepoint: { category: "document_management", receives: ["portfolio-export-v1"], writesBack: false },
};

export function buildConnectorPayload(args: { connectorKey: string; contractVersion: string; payload: any }) {
  const adapter = CONNECTOR_ADAPTERS[args.connectorKey];
  if (!adapter) throw new Error(`unsupported_connector:${args.connectorKey}`);
  if (!adapter.receives.includes(args.contractVersion)) throw new Error(`unsupported_contract_for_connector:${args.contractVersion}`);
  return { connectorKey: args.connectorKey, category: adapter.category, contractVersion: args.contractVersion, writeBackAllowed: false, payload: args.payload };
}

export function sanitizeConnectorTelemetry(input: any) {
  return {
    connectorKey: input.connectorKey,
    status: input.status,
    successCount: Number(input.successCount ?? 0),
    failureCount: Number(input.failureCount ?? 0),
    retryCount: Number(input.retryCount ?? 0),
    deadLetterCount: Number(input.deadLetterCount ?? 0),
    averageLatencyMs: Number(input.averageLatencyMs ?? 0),
  };
}
