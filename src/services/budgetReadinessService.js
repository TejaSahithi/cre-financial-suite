const TERMINAL_STATUSES = ["finalized", "matched", "excluded"];

export async function checkBudgetReadiness(supabase, { propertyId, fiscalYear, orgId }) {
  const [
    propertyResult,
    leasesResult,
    ruleSetResult,
    expenseClassResult,
    camSnapshotResult,
  ] = await Promise.all([
    supabase.from("properties").select("id, name, total_sqft").eq("id", propertyId).single(),
    supabase.from("leases").select("id, abstract_status").eq("property_id", propertyId).eq("status", "active"),
    supabase.from("lease_expense_rule_sets").select("id").eq("property_id", propertyId).eq("status", "approved"),
    supabase.from("expense_classifications").select("id, classification_status").eq("property_id", propertyId).eq("org_id", orgId),
    // Scope-aware CAM snapshots: a property can now have multiple completed "cam" snapshots
    // for the same fiscal_year (property + any building/unit runs), so
    // .maybeSingle() would start erroring as soon as a building/unit CAM run
    // exists alongside the property one. Budget readiness has always meant
    // "is the property-wide CAM data ready", so pin to property scope.
    supabase
      .from("computation_snapshots")
      .select("id, computed_at")
      .eq("engine_type", "cam")
      .eq("property_id", propertyId)
      .eq("scope_level", "property")
      .eq("fiscal_year", fiscalYear)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const property = propertyResult.data;
  const activeLeases = leasesResult.data ?? [];
  const approvedRuleSets = ruleSetResult.data ?? [];
  const expenseClasses = expenseClassResult.data ?? [];
  const camSnapshot = camSnapshotResult.data ?? null;

  const hasSqft = property && Number(property.total_sqft) > 0;
  const hasActiveLeases = activeLeases.length > 0;
  const unapprovedCount = activeLeases.filter((l) => l.abstract_status !== "approved").length;
  const hasApprovedRules = approvedRuleSets.length > 0;
  const terminalCount = expenseClasses.filter((e) => TERMINAL_STATUSES.includes(e.classification_status)).length;
  const classificationPct = expenseClasses.length > 0 ? terminalCount / expenseClasses.length : null;

  const checks = [
    {
      id: "property_sqft",
      label: "Property square footage configured",
      status: hasSqft ? "pass" : "fail",
      message: hasSqft
        ? `${Number(property.total_sqft).toLocaleString()} SF`
        : "Set total_sqft on the property before generating a budget",
      actionPage: "Properties",
    },
    {
      id: "active_leases",
      label: "Active leases exist",
      status: hasActiveLeases ? "pass" : "fail",
      message: hasActiveLeases
        ? `${activeLeases.length} active lease${activeLeases.length !== 1 ? "s" : ""}`
        : "No active leases found — budget will have no rent income",
      actionPage: "Leases",
    },
    {
      id: "lease_abstracts",
      label: "Lease abstracts approved",
      status: unapprovedCount === 0 ? "pass" : "warn",
      message:
        unapprovedCount === 0
          ? "All active leases have approved abstracts"
          : `${unapprovedCount} lease${unapprovedCount !== 1 ? "s" : ""} pending abstract approval`,
      actionPage: "LeaseReview",
    },
    {
      id: "cam_rules",
      label: "CAM rules approved",
      status: hasApprovedRules ? "pass" : "warn",
      message: hasApprovedRules
        ? "Approved CAM rule set found"
        : "No approved CAM rule sets — CAM recovery may be inaccurate",
      actionPage: "ExpenseClassification",
    },
    {
      id: "expenses_classified",
      label: "Expenses ≥ 80% classified",
      status:
        classificationPct === null
          ? "warn"
          : classificationPct >= 0.8
          ? "pass"
          : "warn",
      message:
        classificationPct === null
          ? "No expense classifications found"
          : `${Math.round(classificationPct * 100)}% classified (${terminalCount}/${expenseClasses.length})`,
      actionPage: "ExpenseReview",
    },
    {
      id: "cam_snapshot",
      label: "CAM snapshot available",
      status: camSnapshot ? "pass" : "warn",
      message: camSnapshot
        ? `CAM snapshot from ${new Date(camSnapshot.computed_at).toLocaleDateString()}`
        : `No CAM snapshot for FY ${fiscalYear} — budget will exclude CAM recovery`,
      actionPage: "CAMRun",
    },
  ];

  return {
    checks,
    hasBlockers: checks.some((c) => c.status === "fail"),
    hasWarnings: checks.some((c) => c.status === "warn"),
    meta: { camSnapshot, property },
  };
}
