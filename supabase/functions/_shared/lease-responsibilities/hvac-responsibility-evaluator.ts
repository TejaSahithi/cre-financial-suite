export type HvacResponsibilityStatus = "resolved" | "review_required";

export interface HvacResponsibilityInput {
  text?: string | null;
  responsibility?: string | null;
  thresholdAmount?: number | string | null;
  replacementText?: string | null;
  source?: Record<string, unknown> | null;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function lower(value: unknown): string {
  return clean(value).toLowerCase();
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function includesAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

export function evaluateHvacResponsibility(input: HvacResponsibilityInput) {
  const explicit = lower(input.responsibility);
  const text = lower([input.text, input.replacementText].filter(Boolean).join(" "));
  const threshold = asNumber(input.thresholdAmount) ?? asNumber(text.match(/\$\s*[\d,]+(?:\.\d{1,2})?/)?.[0]);

  const tenantSignals = [
    /\btenant\b.*\b(maintain|repair|service|replace|responsible|expense|cost)/,
    /\b(maintain|repair|service|replace)\b.*\btenant\b/,
  ];
  const landlordSignals = [
    /\b(landlord|lessor|owner)\b.*\b(maintain|repair|service|replace|responsible|expense|cost)/,
    /\b(maintain|repair|service|replace)\b.*\b(landlord|lessor|owner)\b/,
  ];
  const replacementSignals = [/\breplac(e|ement)\b/, /\bcapital\b.*\bhvac\b/, /\bcatastrophic\b/];
  const programSignals = [/\bmaintenance program\b/, /\bservice contract\b/, /\bcharged to tenant\b/, /\btenant shall reimburse\b/];

  const tenant = explicit === "tenant" || explicit === "tenant_direct" || includesAny(text, tenantSignals);
  const landlord = explicit === "landlord" || explicit === "landlord_direct" || includesAny(text, landlordSignals);
  const replacement = explicit.includes("replacement") || includesAny(text, replacementSignals);
  const programChargedToTenant = includesAny(text, programSignals) && tenant;

  if (tenant && landlord && threshold == null && !replacement && !programChargedToTenant) {
    return {
      status: "review_required" as HvacResponsibilityStatus,
      responsibility: "review_required",
      reasonCodes: ["HVAC_RESPONSIBILITY_AMBIGUOUS"],
      evidence: input.source ?? {},
    };
  }

  if (programChargedToTenant) {
    return {
      status: "resolved" as HvacResponsibilityStatus,
      responsibility: "landlord_maintenance_program_charged_to_tenant",
      thresholdAmount: threshold,
      replacementResponsibility: replacement ? "review_required" : null,
      reasonCodes: replacement ? ["HVAC_REPLACEMENT_REVIEW_REQUIRED"] : [],
      evidence: input.source ?? {},
    };
  }

  if (tenant && threshold != null) {
    return {
      status: "resolved" as HvacResponsibilityStatus,
      responsibility: "tenant_up_to_threshold",
      thresholdAmount: threshold,
      replacementResponsibility: replacement ? "landlord_or_review" : null,
      reasonCodes: replacement ? ["HVAC_REPLACEMENT_REVIEW_REQUIRED"] : [],
      evidence: input.source ?? {},
    };
  }

  if (landlord && threshold != null) {
    return {
      status: "resolved" as HvacResponsibilityStatus,
      responsibility: "landlord_up_to_threshold",
      thresholdAmount: threshold,
      replacementResponsibility: replacement ? "landlord" : null,
      reasonCodes: [],
      evidence: input.source ?? {},
    };
  }

  if (tenant && replacement) {
    return {
      status: "resolved" as HvacResponsibilityStatus,
      responsibility: "tenant",
      thresholdAmount: null,
      replacementResponsibility: "tenant",
      reasonCodes: [],
      evidence: input.source ?? {},
    };
  }

  if (landlord && replacement) {
    return {
      status: "resolved" as HvacResponsibilityStatus,
      responsibility: "landlord",
      thresholdAmount: null,
      replacementResponsibility: "landlord",
      reasonCodes: [],
      evidence: input.source ?? {},
    };
  }

  if (tenant) {
    return {
      status: "resolved" as HvacResponsibilityStatus,
      responsibility: "tenant",
      thresholdAmount: null,
      replacementResponsibility: null,
      reasonCodes: [],
      evidence: input.source ?? {},
    };
  }

  if (landlord) {
    return {
      status: "resolved" as HvacResponsibilityStatus,
      responsibility: "landlord",
      thresholdAmount: null,
      replacementResponsibility: null,
      reasonCodes: [],
      evidence: input.source ?? {},
    };
  }

  return {
    status: "review_required" as HvacResponsibilityStatus,
    responsibility: "review_required",
    thresholdAmount: null,
    replacementResponsibility: null,
    reasonCodes: ["HVAC_RESPONSIBILITY_NOT_DETERMINISTIC"],
    evidence: input.source ?? {},
  };
}

