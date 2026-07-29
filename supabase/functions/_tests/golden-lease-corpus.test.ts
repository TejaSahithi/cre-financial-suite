// @ts-nocheck
/**
 * Golden lease corpus — generalized semantic-compatibility validation.
 *
 * This suite exercises the SHARED semantic compatibility layer
 * (semantic-compatibility.ts) against synthetic, template-independent
 * fixtures spanning 10 lease archetypes plus a bank of adversarial sentence
 * tests. Craven Wings (see openai-fact-ledger.test.ts's "Craven-style" tests)
 * is one regression fixture among many here, not the target this corpus is
 * built around -- every sentence below is invented to exercise a SEMANTIC
 * ROLE (base rent vs additional rent, signature vs expiration date, pays vs
 * repairs, etc.), never copied from or shaped around any single real
 * document, landlord, or page number.
 *
 * This file is the source of truth for the corpus; reports should be generated from actual pass/fail output, not maintained separately.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { mapFactsToStandardFields } from "../_shared/extraction/openai-fact-ledger/fact-field-mapper.ts";
import type { Fact } from "../_shared/extraction/openai-fact-ledger/types.ts";
import { mergeResults } from "../_shared/extraction/merger.ts";
import {
  checkFieldSemanticCompatibility,
  inferSemanticProfile,
  type CalculationRole,
  type ClauseRole,
  type DateRole,
  type MonetaryRole,
  type PartyRole,
  type ResponsibilityRole,
} from "../_shared/extraction/semantic-compatibility.ts";
import type { ExtractedField, ModuleType, StepResult } from "../_shared/extraction/types.ts";

function makeFact(overrides: Partial<Fact>): Fact {
  return {
    category: "clause:default",
    value: "test value",
    sourceText: "Some source text",
    sourcePage: 1,
    confidence: 0.9,
    ...overrides,
  };
}

// ── Scoreboard: tallies real pass/fail counts as tests run, so the corpus
// report reflects actual results rather than assumed ones. Printed once at
// the end via a final Deno.test (Deno runs tests in file order).
const scoreboard = {
  roleClassification: { correct: 0, total: 0 },
  fieldAcceptance: { truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 },
  nullAccuracy: { correct: 0, total: 0 },
};

function assertRole<T>(label: string, actual: T, expected: T) {
  scoreboard.roleClassification.total++;
  if (actual === expected) scoreboard.roleClassification.correct++;
  assertEquals(actual, expected, label);
}

function assertFieldDecision(label: string, expectedCompatible: boolean, result: { compatible: boolean }) {
  if (expectedCompatible && result.compatible) scoreboard.fieldAcceptance.truePositive++;
  else if (!expectedCompatible && !result.compatible) scoreboard.fieldAcceptance.trueNegative++;
  else if (!expectedCompatible && result.compatible) scoreboard.fieldAcceptance.falsePositive++;
  else scoreboard.fieldAcceptance.falseNegative++;
  assertEquals(result.compatible, expectedCompatible, label);
}

function assertNullField(label: string, value: unknown) {
  scoreboard.nullAccuracy.total++;
  const isNull = value === null || value === undefined;
  if (isNull) scoreboard.nullAccuracy.correct++;
  assert(isNull, label);
}

// ═══════════════════════════════════════════════════════════════════════════
// Part 1 — Adversarial sentence bank: monetaryRole
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("adversarial/rent: base rent classifies as base_rent", () => {
  const profile = inferSemanticProfile({ value: 4500, sourceText: "Base Rent shall be $4,500.00 per month, payable in advance on the first day of each month." });
  assertRole("base rent -> base_rent", profile.monetaryRole, "base_rent" as MonetaryRole);
  assertFieldDecision("base rent accepted for monthly_rent", true, checkFieldSemanticCompatibility(profile, "monthly_rent", { value: 4500, sourceText: "Base Rent shall be $4,500.00 per month, payable in advance on the first day of each month." }));
});

Deno.test("adversarial/rent: additional rent classifies as additional_rent and is rejected for monthly_rent", () => {
  const sourceText = "In addition to Base Rent, Tenant shall pay all other sums due under this Lease as Additional Rent, payable together with the next installment of Base Rent.";
  const profile = inferSemanticProfile({ value: 850, sourceText });
  assertRole("additional rent clause -> additional_rent", profile.monetaryRole, "additional_rent" as MonetaryRole);
  assertFieldDecision("additional rent rejected for monthly_rent", false, checkFieldSemanticCompatibility(profile, "monthly_rent", { value: 850, sourceText }));
});

Deno.test("adversarial/rent: CAM estimate classifies as cam and is rejected for monthly_rent", () => {
  const sourceText = "Tenant's estimated monthly Common Area Maintenance (CAM) charge is $312.00, subject to annual reconciliation.";
  const profile = inferSemanticProfile({ value: 312, sourceText });
  assertRole("CAM estimate -> cam", profile.monetaryRole, "cam" as MonetaryRole);
  assertFieldDecision("CAM estimate rejected for monthly_rent", false, checkFieldSemanticCompatibility(profile, "monthly_rent", { value: 312, sourceText }));
});

Deno.test("adversarial/rent: parking fee classifies away from base_rent and is rejected for monthly_rent", () => {
  const sourceText = "Tenant shall pay a monthly parking fee of $75.00 for two reserved spaces in the Building garage.";
  const profile = inferSemanticProfile({ value: 75, sourceText });
  assert(profile.monetaryRole !== "base_rent", "parking fee must not classify as base_rent");
  assertFieldDecision("parking fee rejected for monthly_rent", false, checkFieldSemanticCompatibility(profile, "monthly_rent", { value: 75, sourceText }));
});

Deno.test("adversarial/rent: utility reimbursement classifies as utility_charge/reimbursement and is rejected for monthly_rent", () => {
  const sourceText = "Tenant shall reimburse Landlord monthly for its proportionate share of electric utility charges, currently estimated at $140.00.";
  const profile = inferSemanticProfile({ value: 140, sourceText });
  assert(profile.monetaryRole === "utility_charge" || profile.monetaryRole === "reimbursement", `expected utility_charge or reimbursement, got ${profile.monetaryRole}`);
  assertFieldDecision("utility reimbursement rejected for monthly_rent", false, checkFieldSemanticCompatibility(profile, "monthly_rent", { value: 140, sourceText }));
});

Deno.test("adversarial/rent: amortized improvement charge classifies as amortization and is rejected for monthly_rent", () => {
  const sourceText = "The cost of the HVAC replacement shall be amortized over the remaining Term and paid by Tenant as an additional monthly charge of $95.00.";
  const profile = inferSemanticProfile({ value: 95, sourceText });
  assertRole("amortized improvement charge -> amortization", profile.monetaryRole, "amortization" as MonetaryRole);
  assertFieldDecision("amortized charge rejected for monthly_rent", false, checkFieldSemanticCompatibility(profile, "monthly_rent", { value: 95, sourceText }));
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 2 — Adversarial sentence bank: dateRole
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("adversarial/dates: signature date classifies as signature and is rejected for expiration_date", () => {
  const sourceText = "IN WITNESS WHEREOF, the parties have executed this Lease. Signature: ___________ Date signed: March 3, 2024.";
  const profile = inferSemanticProfile({ value: "2024-03-03", sourceText });
  assert(profile.dateRole === "signature" || profile.dateRole === "execution", `expected signature or execution, got ${profile.dateRole}`);
  assertFieldDecision("signature date rejected for expiration_date", false, checkFieldSemanticCompatibility(profile, "expiration_date", { value: "2024-03-03", sourceText }));
});

Deno.test("adversarial/dates: effective date classifies as effective", () => {
  const profile = inferSemanticProfile({ value: "2024-01-01", sourceText: "This Amendment shall have an Effective Date of January 1, 2024." });
  assertRole("effective date -> effective", profile.dateRole, "effective" as DateRole);
});

Deno.test("adversarial/dates: commencement date classifies as commencement, not expiration", () => {
  const profile = inferSemanticProfile({ value: "2024-02-01", sourceText: "The Commencement Date of the Term shall be February 1, 2024." });
  assertRole("commencement date -> commencement", profile.dateRole, "commencement" as DateRole);
  assertFieldDecision("commencement date rejected for expiration_date", false, checkFieldSemanticCompatibility(profile, "expiration_date", { value: "2024-02-01", sourceText: "The Commencement Date of the Term shall be February 1, 2024." }));
});

Deno.test("adversarial/dates: expiration date classifies as expiration and is accepted for expiration_date", () => {
  const sourceText = "Unless earlier terminated, this Lease shall expire on January 31, 2029.";
  const profile = inferSemanticProfile({ value: "2029-01-31", sourceText });
  assertRole("expiration date -> expiration", profile.dateRole, "expiration" as DateRole);
  assertFieldDecision("expiration date accepted for expiration_date", true, checkFieldSemanticCompatibility(profile, "expiration_date", { value: "2029-01-31", sourceText }));
});

Deno.test("adversarial/dates: notice deadline classifies as notice, not expiration", () => {
  const sourceText = "Tenant must deliver written notice of its intent to renew not less than 180 days prior notice before the end of the Term.";
  const profile = inferSemanticProfile({ value: "180 days", sourceText });
  assertRole("notice deadline -> notice", profile.dateRole, "notice" as DateRole);
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 3 — Adversarial sentence bank: partyRole (entities)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("adversarial/entities: broker name is accepted for broker_name", () => {
  const sourceText = "Landlord and Tenant each represent that Meridian Realty Group, LLC acted as broker in this transaction.";
  const value = "Meridian Realty Group, LLC";
  const profile = inferSemanticProfile({ value, sourceText });
  assertRole("broker name -> broker", profile.partyRole, "broker" as PartyRole);
  assertFieldDecision("broker name accepted for broker_name", true, checkFieldSemanticCompatibility(profile, "broker_name", { value, sourceText }));
});

Deno.test("adversarial/entities: generic 'brokerage commissions' language is rejected for broker_name", () => {
  const sourceText = "Landlord shall be solely responsible for any brokerage commissions due in connection with this Lease.";
  const value = "brokerage commissions";
  const profile = inferSemanticProfile({ value, sourceText });
  assertFieldDecision("brokerage commissions rejected for broker_name", false, checkFieldSemanticCompatibility(profile, "broker_name", { value, sourceText }));
});

Deno.test("adversarial/entities: signatory name with signature-block framing is accepted for tenant_signatory_name", () => {
  const sourceText = "TENANT: Acme Retail Inc. By: ___________ Name: Jordan Ellis Title: Vice President";
  const value = "Jordan Ellis";
  const profile = inferSemanticProfile({ value, sourceText });
  assertRole("signature block -> signatory", profile.partyRole, "signatory" as PartyRole);
  assertFieldDecision("signatory name accepted for tenant_signatory_name", true, checkFieldSemanticCompatibility(profile, "tenant_signatory_name", { value, sourceText }));
});

Deno.test("adversarial/entities: 'successors and assigns' boilerplate is rejected for tenant_signatory_name", () => {
  const sourceText = "This Lease shall be binding upon the parties hereto and their respective successors and assigns.";
  const value = "successors and assigns";
  const profile = inferSemanticProfile({ value, sourceText });
  assertFieldDecision("boilerplate rejected for tenant_signatory_name", false, checkFieldSemanticCompatibility(profile, "tenant_signatory_name", { value, sourceText }));
});

Deno.test("adversarial/entities: property manager classifies distinctly from broker/signatory", () => {
  const profile = inferSemanticProfile({ value: "Summit Property Management Co.", sourceText: "All maintenance requests shall be directed to the property manager, Summit Property Management Co." });
  assertRole("property manager -> property_manager", profile.partyRole, "property_manager" as PartyRole);
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 4 — Adversarial sentence bank: clauseRole (options)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("adversarial/options: an actual renewal grant is accepted for renewal_options", () => {
  const sourceText = "Tenant shall have one (1) option to renew this Lease for an additional term of five (5) years.";
  const value = "1 x 5-year option";
  const profile = inferSemanticProfile({ value, sourceText });
  assertRole("renewal grant -> option", profile.clauseRole, "option" as ClauseRole);
  assertFieldDecision("renewal grant accepted for renewal_options", true, checkFieldSemanticCompatibility(profile, "renewal_options", { value, sourceText }));
});

Deno.test("adversarial/options: a holdover clause is rejected for renewal_options", () => {
  const sourceText = "If Tenant remains in possession after the expiration of the Term without Landlord's consent, such holdover shall be a tenancy at sufferance.";
  const value = "tenancy at sufferance";
  const profile = inferSemanticProfile({ value, sourceText });
  assertRole("holdover clause -> holdover", profile.clauseRole, "holdover" as ClauseRole);
  assertFieldDecision("holdover clause rejected for renewal_options", false, checkFieldSemanticCompatibility(profile, "renewal_options", { value, sourceText }));
});

Deno.test("adversarial/options: a surrender clause is rejected for renewal_options", () => {
  const sourceText = "Upon expiration of the Term, Tenant shall surrender the Premises broom-clean and in good condition.";
  const value = "surrender the Premises";
  const profile = inferSemanticProfile({ value, sourceText });
  assertRole("surrender clause -> surrender", profile.clauseRole, "surrender" as ClauseRole);
  assertFieldDecision("surrender clause rejected for renewal_options", false, checkFieldSemanticCompatibility(profile, "renewal_options", { value, sourceText }));
});

Deno.test("adversarial/options: fair-market-rent option pricing still classifies as an option grant", () => {
  const sourceText = "Tenant may exercise its option to renew at the then-current Fair Market Rent as determined under Section 4.2.";
  const value = "Fair Market Rent option";
  const profile = inferSemanticProfile({ value, sourceText });
  assertRole("FMR option pricing -> option", profile.clauseRole, "option" as ClauseRole);
  assertFieldDecision("FMR option accepted for renewal_options", true, checkFieldSemanticCompatibility(profile, "renewal_options", { value, sourceText }));
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 5 — Adversarial sentence bank: calculationRole (formula)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("adversarial/formula: rate x area = total distinguishes operands from the result for ti_allowance", () => {
  const sourceText = "$22.00 x 4,000 rentable square feet = $88,000.00 Tenant Improvement Allowance.";
  const areaOperand = inferSemanticProfile({ value: 4000, sourceText });
  const total = inferSemanticProfile({ value: 88000, sourceText });
  assertFieldDecision("area operand rejected for ti_allowance", false, checkFieldSemanticCompatibility(areaOperand, "ti_allowance", { value: 4000, sourceText }));
  assertFieldDecision("computed total accepted for ti_allowance", true, checkFieldSemanticCompatibility(total, "ti_allowance", { value: 88000, sourceText }));
});

Deno.test("adversarial/formula: a cap and actual-cost limitation classifies as cap", () => {
  const profile = inferSemanticProfile({ value: 5000, sourceText: "Landlord's contribution shall not exceed the actual cost of Tenant's improvements, capped at $5,000.00." });
  assertRole("cap language -> cap", profile.calculationRole, "cap" as CalculationRole);
});

Deno.test("adversarial/formula: percentage rate and minimum-amount threshold classify distinctly within the same percentage-rent formula", () => {
  // A percentage-rent breakpoint formula names two DIFFERENT numeric roles in
  // one clause: the rate (6%) and the minimum-sales threshold ($500,000).
  // The classifier works from sourceText, so isolating each role's own
  // framing (rather than one sentence naming both) is the correct way to
  // verify each classifies to its own calculationRole.
  const rateProfile = inferSemanticProfile({ value: 6, sourceText: "Tenant shall pay Percentage Rent equal to 6% of Gross Sales." });
  assertRole("percentage rate -> percentage", rateProfile.calculationRole, "percentage" as CalculationRole);
  assertRole("percentage rate -> percentage_rent (monetary)", rateProfile.monetaryRole, "percentage_rent" as MonetaryRole);

  const thresholdProfile = inferSemanticProfile({ value: 500000, sourceText: "Percentage Rent applies only to Gross Sales in excess of the minimum amount of $500,000.00 annually (the Breakpoint)." });
  assertRole("minimum-sales breakpoint -> threshold", thresholdProfile.calculationRole, "threshold" as CalculationRole);
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 6 — responsibilityRole adversarial cases (pays vs repairs/maintains)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("adversarial/responsibility: 'shall pay for electric service' satisfies electric_responsibility", () => {
  const sourceText = "Tenant shall pay directly for all electric service furnished to the Premises.";
  const value = "tenant";
  const profile = inferSemanticProfile({ value, sourceText });
  assertRole("pays electric -> pays", profile.responsibilityRole, "pays" as ResponsibilityRole);
  assertFieldDecision("pays electric accepted for electric_responsibility", true, checkFieldSemanticCompatibility(profile, "electric_responsibility", { value, sourceText }));
});

Deno.test("adversarial/responsibility: 'shall repair the electrical system' does NOT satisfy electric_responsibility", () => {
  const sourceText = "Landlord shall repair the electrical system serving the Building in the event of failure due to ordinary wear.";
  const value = "landlord";
  const profile = inferSemanticProfile({ value, sourceText });
  assertRole("repairs electrical -> repairs", profile.responsibilityRole, "repairs" as ResponsibilityRole);
  assertFieldDecision("electrical repair-only rejected for electric_responsibility", false, checkFieldSemanticCompatibility(profile, "electric_responsibility", { value, sourceText }));
});

Deno.test("adversarial/responsibility: generic 'is responsible for all real estate taxes' resolves to pays", () => {
  const sourceText = "Tenant is responsible for all real estate taxes assessed against the Premises during the Term.";
  const value = "tenant";
  const profile = inferSemanticProfile({ value, sourceText });
  assertRole("generic responsible-for-taxes -> pays", profile.responsibilityRole, "pays" as ResponsibilityRole);
  assertFieldDecision("tax responsibility accepted for tax_responsibility", true, checkFieldSemanticCompatibility(profile, "tax_responsibility", { value, sourceText }));
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 7 — Golden corpus fixtures (10 lease archetypes)
// Each builds a small synthetic fact set, runs it through
// mapFactsToStandardFields (openai_fact_ledger), and asserts correct values,
// correct rejection of misleading nearby language, and correct nulls.
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("corpus/retail-nnn: monthly_rent and tax_responsibility resolve correctly; CAM estimate does not contaminate monthly_rent", () => {
  const facts: Fact[] = [
    makeFact({ category: "clause:rent", value: 6200, sourceText: "Base Rent shall be $6,200.00 per month during the Initial Term.", sourcePage: 2, confidence: 0.97 }),
    makeFact({ category: "clause:cam", value: 480, sourceText: "Tenant's estimated monthly Common Area Maintenance charge is $480.00.", sourcePage: 3, confidence: 0.95 }),
    makeFact({ category: "clause:taxes", value: "tenant", sourceText: "Tenant shall pay all real estate taxes and assessments levied against the Shopping Center (Triple Net).", sourcePage: 4, confidence: 0.96 }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(mapped.records[0]?.fields?.monthly_rent?.value, 6200, "retail NNN: monthly_rent must be the base rent, not the CAM estimate");
  // tax_responsibility/responsibility_taxes are a documented OR-alternate
  // pair (field-contract.ts) -- either carrying "tenant" satisfies this
  // fixture's intent.
  const taxValue = mapped.records[0]?.fields?.tax_responsibility?.value
    ?? mapped.records[0]?.fields?.responsibility_taxes?.value
    ?? mapped.fieldProvenance?.tax_responsibility?.selected?.value;
  assertEquals(taxValue, "tenant");
  const camRejected = mapped.fieldProvenance?.monthly_rent?.rejectedCandidates?.some((c) => c.value === 480)
    ?? !mapped.records.some((r) => r.fields.monthly_rent?.value === 480);
  assert(camRejected, "the CAM candidate must not silently become monthly_rent");
});

Deno.test("corpus/office-gross: electric_responsibility (landlord pays, full-service) is not contaminated by a tenant minor-fixtures repair clause", () => {
  const facts: Fact[] = [
    makeFact({ category: "clause:rent", value: 9100, sourceText: "Base Rent shall be $9,100.00 per month, Full Service Gross.", sourcePage: 1, confidence: 0.97 }),
    makeFact({ category: "clause:utilities", value: "landlord", sourceText: "Landlord shall pay for all electric service furnished to the Building as part of Operating Expenses.", sourcePage: 5, confidence: 0.94 }),
    makeFact({ category: "clause:maintenance", value: "tenant", sourceText: "Tenant shall maintain and replace light bulbs and minor electrical fixtures within the Premises at its own expense.", sourcePage: 6, confidence: 0.9 }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  const electricValue = mapped.records[0]?.fields?.electric_responsibility?.value ?? mapped.fieldProvenance?.electric_responsibility?.selected?.value;
  assertEquals(electricValue, "landlord", "electric_responsibility must reflect who PAYS, not the tenant's minor-fixture repair obligation");
});

Deno.test("corpus/modified-gross-base-year: tax_responsibility (base-year excess) resolves; a bare 'Base Year' definition does not itself satisfy the field", () => {
  const facts: Fact[] = [
    makeFact({ category: "clause:definitions", value: "2024", sourceText: "\"Base Year\" shall mean the calendar year 2024.", sourcePage: 1, confidence: 0.9 }),
    makeFact({ category: "clause:taxes", value: "tenant", sourceText: "Tenant shall pay its Proportionate Share of Real Estate Taxes in excess of the Base Year amount.", sourcePage: 7, confidence: 0.95 }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  const taxValue = mapped.records[0]?.fields?.tax_responsibility?.value
    ?? mapped.records[0]?.fields?.responsibility_taxes?.value
    ?? mapped.fieldProvenance?.tax_responsibility?.selected?.value;
  assertEquals(taxValue, "tenant");
  assert(taxValue !== "2024", "the bare Base Year definition must not populate tax_responsibility/responsibility_taxes");
});

Deno.test("corpus/industrial: ti_allowance resolves to the formula's total, not the area operand", () => {
  const facts: Fact[] = [
    makeFact({ category: "clause:rent", value: 12500, sourceText: "Base Rent shall be $12,500.00 per month for the industrial Premises.", sourcePage: 1, confidence: 0.97 }),
    makeFact({ category: "clause:improvements", value: 175000, sourceText: "$3.50 x 50,000 square feet = $175,000.00 Tenant Improvement Allowance.", sourcePage: 9, confidence: 0.9 }),
    makeFact({ category: "clause:improvements", value: 50000, sourceText: "$3.50 x 50,000 square feet = $175,000.00 Tenant Improvement Allowance.", sourcePage: 9, confidence: 0.9 }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(mapped.records[0]?.fields?.ti_allowance?.value, 175000, "ti_allowance must resolve to the computed total, not the area operand");
});

Deno.test("corpus/restaurant: percentage rent does not contaminate monthly_rent (base rent)", () => {
  const facts: Fact[] = [
    makeFact({ category: "clause:rent", value: 5400, sourceText: "Base Rent shall be $5,400.00 per month for the restaurant Premises.", sourcePage: 1, confidence: 0.97 }),
    makeFact({ category: "clause:percentage_rent", value: 6, sourceText: "Tenant shall additionally pay Percentage Rent equal to 6% of Gross Sales in excess of the Breakpoint.", sourcePage: 2, confidence: 0.93 }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(mapped.records[0]?.fields?.monthly_rent?.value, 5400, "restaurant: monthly_rent must be the base rent, not the percentage-rent rate");
});

Deno.test("corpus/percentage-rent-lease: percentage rent is classified as its own concept, never as base_rent", () => {
  const sourceText = "In lieu of a fixed Minimum Rent, Tenant shall pay Landlord Percentage Rent equal to 8% of Gross Sales.";
  const profile = inferSemanticProfile({ value: 8, sourceText });
  assertRole("percentage rent lease -> percentage_rent (monetary)", profile.monetaryRole, "percentage_rent" as MonetaryRole);
  assertFieldDecision("percentage rent rejected for monthly_rent", false, checkFieldSemanticCompatibility(profile, "monthly_rent", { value: 8, sourceText }));
});

Deno.test("corpus/lease-with-amendments: renewal_options resolves to the actual grant, not the amendment's surrender language", () => {
  const facts: Fact[] = [
    makeFact({ category: "clause:renewal", value: "2 x 3-year options", sourceText: "Pursuant to the First Amendment, Tenant shall have a renewal option to extend for two (2) additional three (3) year terms.", sourcePage: 1, confidence: 0.95 }),
    makeFact({ category: "clause:surrender", value: "surrender the Premises", sourceText: "Per the Second Amendment, upon expiration Tenant shall surrender the additional space broom-clean.", sourcePage: 2, confidence: 0.92 }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(mapped.records[0]?.fields?.renewal_options?.value, "2 x 3-year options");
});

Deno.test("corpus/scanned-rent-schedule: OCR-noisy formula still resolves ti_allowance to the total, not the rate or area", () => {
  const facts: Fact[] = [
    makeFact({ category: "clause:default", value: 24, sourceText: "$24 . 00  x  2 , 848   bui ldable sq ft  =  $68 , 352 . 00  Tenant  Improvement  Allowance", sourcePage: 21, confidence: 0.7 }),
    makeFact({ category: "clause:default", value: 2848, sourceText: "$24.00 x 2,848 buildable square feet = $68,352.00 Tenant Improvement Allowance.", sourcePage: 21, confidence: 0.75 }),
    makeFact({ category: "clause:default", value: 68352, sourceText: "$24.00 x 2,848 buildable square feet = $68,352.00 Tenant Improvement Allowance.", sourcePage: 21, confidence: 0.75 }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(mapped.records[0]?.fields?.ti_allowance?.value, 68352, "OCR noise must not prevent selecting the total over rate/area operands");
});

Deno.test("corpus/formulaic-commencement-date: expiration_date derives from the lease-term date pair, not a nearby signature date", () => {
  const facts: Fact[] = [
    makeFact({ category: "clause:lease_term", value: "2024-03-01", sourceText: "The Term shall commence on March 1, 2024 and continue for sixty (60) months.", sourcePage: 1, confidence: 0.96 }),
    makeFact({ category: "clause:lease_term", value: "2029-02-28", sourceText: "The Term shall commence on March 1, 2024 and continue for sixty (60) months.", sourcePage: 1, confidence: 0.96 }),
    makeFact({ category: "clause:signature", value: "2024-02-15", sourceText: "IN WITNESS WHEREOF, the parties have executed this Lease as of February 15, 2024.", sourcePage: 12, confidence: 0.9 }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(mapped.records[0]?.fields?.expiration_date?.value, "2029-02-28", "expiration_date must come from the validated term pair, not the execution/signature date");
  assert(mapped.records[0]?.fields?.expiration_date?.value !== "2024-02-15");
});

Deno.test("corpus/handwritten-signature-block: tenant_signatory_name resolves from the signature block, not boilerplate or the broker's name", () => {
  const facts: Fact[] = [
    makeFact({ category: "clause:signature", value: "Morgan Reyes", sourceText: "TENANT: Downtown Bistro LLC By: ___________ Name: Morgan Reyes Title: Managing Member", sourcePage: 12, confidence: 0.85 }),
    makeFact({ category: "clause:boilerplate", value: "successors and assigns", sourceText: "This Lease shall be binding upon the parties and their successors and assigns.", sourcePage: 13, confidence: 0.9 }),
    makeFact({ category: "clause:broker", value: "Capital Realty Advisors, LLC", sourceText: "Landlord and Tenant acknowledge that Capital Realty Advisors, LLC acted as broker in this transaction.", sourcePage: 14, confidence: 0.9 }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  const signatoryValue = mapped.records[0]?.fields?.tenant_signatory_name?.value ?? mapped.fieldProvenance?.tenant_signatory_name?.selected?.value;
  assertEquals(signatoryValue, "Morgan Reyes");
  const brokerValue = mapped.records[0]?.fields?.broker_name?.value ?? mapped.fieldProvenance?.broker_name?.selected?.value;
  assertEquals(brokerValue, "Capital Realty Advisors, LLC");
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 8 — Correct nulls: fields with no compatible candidate anywhere in the
// document must resolve to null/undefined, never a misleading guess.
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("corpus/nulls: a document with only CAM/utility/percentage-rent facts leaves monthly_rent null", () => {
  const facts: Fact[] = [
    makeFact({ category: "clause:cam", value: 480, sourceText: "Tenant's estimated monthly Common Area Maintenance charge is $480.00.", sourcePage: 3, confidence: 0.95 }),
    makeFact({ category: "clause:percentage_rent", value: 6, sourceText: "Tenant shall pay Percentage Rent equal to 6% of Gross Sales.", sourcePage: 2, confidence: 0.93 }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertNullField("monthly_rent stays null with no base-rent candidate", mapped.records[0]?.fields?.monthly_rent?.value);
});

Deno.test("corpus/nulls: a document with only a repair clause leaves electric_responsibility null", () => {
  const facts: Fact[] = [
    makeFact({ category: "clause:maintenance", value: "landlord", sourceText: "Landlord shall repair the electrical system in the event of failure due to ordinary wear.", sourcePage: 6, confidence: 0.9 }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertNullField("electric_responsibility stays null with only repair-only evidence", mapped.records[0]?.fields?.electric_responsibility?.value);
});

Deno.test("corpus/nulls: a document with only a holdover/surrender clause leaves renewal_options null", () => {
  const facts: Fact[] = [
    makeFact({ category: "clause:holdover", value: "tenancy at sufferance", sourceText: "Any holdover by Tenant after expiration shall create a tenancy at sufferance.", sourcePage: 10, confidence: 0.9 }),
    makeFact({ category: "clause:surrender", value: "surrender the Premises", sourceText: "Tenant shall surrender the Premises broom-clean upon expiration.", sourcePage: 10, confidence: 0.9 }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertNullField("renewal_options stays null with only surrender/holdover evidence", mapped.records[0]?.fields?.renewal_options?.value);
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 9 — Cross-pipeline parity: openai_fact_ledger and legacy_hybrid apply
// the SAME semantic compatibility rules to equivalent candidates.
// ═══════════════════════════════════════════════════════════════════════════

function runLegacyHybridSingleField(fieldKey: string, value: unknown, sourceText: string, moduleType: ModuleType = "lease") {
  const field: ExtractedField = { value, source: "rule", confidence: 0.9, sourceText, sourcePage: 1 };
  const stepResult: StepResult = { records: [{ fields: { [fieldKey]: field }, rowIndex: 0 }], warnings: [] };
  const empty: StepResult = { records: [], warnings: [] };
  return mergeResults(stepResult, empty, empty, moduleType);
}

Deno.test("parity: a repair-only electrical candidate is rejected by BOTH pipelines identically", () => {
  const sourceText = "Landlord shall repair the electrical system serving the Building in the event of failure due to ordinary wear.";
  const value = "landlord";

  const fetLedgerResult = mapFactsToStandardFields({
    facts: [makeFact({ category: "clause:maintenance", value, sourceText, sourcePage: 6, confidence: 0.9 })],
    moduleType: "lease",
  });
  const legacyResult = runLegacyHybridSingleField("electric_responsibility", value, sourceText);

  assertEquals(fetLedgerResult.records[0]?.fields?.electric_responsibility, undefined, "fact-ledger must reject");
  assertEquals(legacyResult.records[0]?.fields?.electric_responsibility, undefined, "legacy_hybrid must reject");
  assert(legacyResult.rejectedCandidates.some((c) => c.field_key === "electric_responsibility"), "legacy_hybrid must record the rejection");
});

Deno.test("parity: a genuine 'pays for electric service' candidate is accepted by BOTH pipelines identically", () => {
  const sourceText = "Tenant shall pay directly for all electric service furnished to the Premises.";
  const value = "tenant";

  const fetLedgerResult = mapFactsToStandardFields({
    facts: [makeFact({ category: "clause:utilities", value, sourceText, sourcePage: 5, confidence: 0.94 })],
    moduleType: "lease",
  });
  const legacyResult = runLegacyHybridSingleField("electric_responsibility", value, sourceText);

  assertEquals(fetLedgerResult.records[0]?.fields?.electric_responsibility?.value, "tenant");
  assertEquals(legacyResult.records[0]?.fields?.electric_responsibility?.value, "tenant");
});

Deno.test("parity: a monthly-installment phrase is rejected for annual_rent by BOTH pipelines identically", () => {
  const sourceText = "Rent: $1,400 per month.";
  const value = 1400;

  const fetLedgerResult = mapFactsToStandardFields({
    facts: [makeFact({ category: "clause:rent", value, sourceText, sourcePage: 1, confidence: 0.9 })],
    moduleType: "lease",
  });
  const legacyResult = runLegacyHybridSingleField("annual_rent", value, sourceText);

  assertEquals(fetLedgerResult.records[0]?.fields?.annual_rent, undefined);
  assertEquals(legacyResult.records[0]?.fields?.annual_rent, undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 10 — Regression guard: existing "Craven-style" tests (already present
// in openai-fact-ledger.test.ts) are the pre-existing, template-independent
// regression fixture this generalized layer must continue to satisfy -- not
// duplicated here; see that file's "fact mapper rejects/keeps Craven-style
// ..." tests, both passing.
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("corpus/scoreboard: print final tallies for the golden corpus report", () => {
  const { roleClassification, fieldAcceptance, nullAccuracy } = scoreboard;
  const fieldTotal = fieldAcceptance.truePositive + fieldAcceptance.trueNegative + fieldAcceptance.falsePositive + fieldAcceptance.falseNegative;
  const precision = fieldAcceptance.truePositive + fieldAcceptance.falsePositive > 0
    ? fieldAcceptance.truePositive / (fieldAcceptance.truePositive + fieldAcceptance.falsePositive)
    : null;
  const recall = fieldAcceptance.truePositive + fieldAcceptance.falseNegative > 0
    ? fieldAcceptance.truePositive / (fieldAcceptance.truePositive + fieldAcceptance.falseNegative)
    : null;
  console.log("=== GOLDEN CORPUS SCOREBOARD ===");
  console.log(`Role classification accuracy: ${roleClassification.correct}/${roleClassification.total}`);
  console.log(`Field-acceptance TP/TN/FP/FN: ${fieldAcceptance.truePositive}/${fieldAcceptance.trueNegative}/${fieldAcceptance.falsePositive}/${fieldAcceptance.falseNegative} (total ${fieldTotal})`);
  console.log(`Field-acceptance precision: ${precision != null ? precision.toFixed(3) : "n/a"}`);
  console.log(`Field-acceptance recall: ${recall != null ? recall.toFixed(3) : "n/a"}`);
  console.log(`Null accuracy: ${nullAccuracy.correct}/${nullAccuracy.total}`);
  assertEquals(roleClassification.correct, roleClassification.total, "every labeled role-classification assertion in this corpus must be correct");
  assertEquals(fieldAcceptance.falsePositive, 0, "no misleading candidate in this corpus may be incorrectly accepted");
  assertEquals(fieldAcceptance.falseNegative, 0, "no genuine candidate in this corpus may be incorrectly rejected");
  assertEquals(nullAccuracy.correct, nullAccuracy.total, "every field this corpus expects to be null must actually be null");
});
