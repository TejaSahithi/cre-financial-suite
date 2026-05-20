const fs = require('fs');

const path = 'c:/Users/tejas/Downloads/cre-financial-suite-main (3)/cre-financial-suite-main/src/services/expenseService.js';
let content = fs.readFileSync(path, 'utf8');

// We need to add loadExpenseRecoverabilityScope, loadApprovedLeaseExpenseRules, loadApprovedActualExpenses, and runExpenseClassification.

const newFunctions = `
  async loadApprovedLeaseExpenseRules(scope = {}) {
    const { property_id, building_id, unit_id, lease_id, tenant_id } = scope;
    if (!lease_id && !property_id && !tenant_id) return [];

    let query = supabase.from("lease_expense_rules").select(\`
      *,
      rule_set:lease_expense_rule_sets!inner (
        id, lease_id, property_id, status
      )
    \`);
    
    // We fetch approved rules
    query = query.in("review_status", ["approved", "mapped"]).or("approval_status.eq.approved,review_status.eq.approved");

    const { data, error } = await query;
    if (error || !data) return [];
    
    // scope inheritance filtering
    return data.filter(rule => {
      const rs = rule.rule_set;
      if (lease_id && rs.lease_id === lease_id) return true;
      if (property_id && rule.property_id === property_id) return true;
      if (building_id && rule.building_id === building_id) return true;
      if (unit_id && rule.unit_id === unit_id) return true;
      if (!rule.building_id && !rule.unit_id && property_id && rs.property_id === property_id) return true;
      return false;
    });
  },

  async loadApprovedActualExpenses(scope = {}) {
    const { property_id, building_id, unit_id, lease_id, tenant_id, fiscal_year, date_range } = scope;
    
    let query = supabase.from("expenses").select('*');
    
    query = query.in("approved_status", ["approved"]).or("review_status.eq.approved,approved_status.eq.approved");
    
    if (property_id) query = query.eq("property_id", property_id);
    if (building_id) query = query.eq("building_id", building_id);
    if (unit_id) query = query.eq("unit_id", unit_id);
    if (lease_id) query = query.eq("lease_id", lease_id);
    if (tenant_id) query = query.eq("tenant_id", tenant_id);
    if (fiscal_year) query = query.eq("fiscal_year", fiscal_year);
    // Note: Date range omitted for simplicity, can be added if start/end dates are passed

    const { data, error } = await query;
    if (error || !data) return [];
    return data;
  },

  async loadExpenseRecoverabilityScope(scope = {}) {
    const [approvedRules, approvedActuals] = await Promise.all([
      this.loadApprovedLeaseExpenseRules(scope),
      this.loadApprovedActualExpenses(scope)
    ]);
    
    const expenseIds = approvedActuals.map(e => e.id);
    const existingClassifications = expenseIds.length > 0 
      ? await fetchExistingExpenseClassifications(expenseIds) 
      : [];

    return {
      approvedRules,
      approvedActuals,
      existingClassifications,
      summary: {
        rulesCount: approvedRules.length,
        actualsCount: approvedActuals.length,
        classificationsCount: existingClassifications.length
      }
    };
  },

  async runExpenseClassification(scope = {}) {
    const { approvedRules, approvedActuals } = await this.loadExpenseRecoverabilityScope(scope);
    if (approvedRules.length === 0 || approvedActuals.length === 0) return { updated: 0 };

    const rulesByLeaseId = new Map();
    approvedRules.forEach(r => {
      const lId = r.rule_set?.lease_id || r.lease_id;
      if (!rulesByLeaseId.has(lId)) rulesByLeaseId.set(lId, []);
      rulesByLeaseId.get(lId).push(r);
    });

    const leases = await baseLeaseService.list();

    return await this.classifyExpenses({
      expenses: approvedActuals,
      leases: leases
    });
  },
`;

// Insert before the last closing brace
content = content.replace(/export const expenseService = \{([\s\S]*?)\n\};\n\nexport default expenseService;/g, \`export const expenseService = {$1\n\n$newFunctions\n};\n\nexport default expenseService;\`);

// Also fix the select columns in fetchExistingExpenseClassifications to avoid 400s
// Remove audit_logs, cam_pool_id, linked_expense_rule_id
content = content.replace(/"linked_expense_rule_id",\\s*/g, '');
content = content.replace(/"cam_pool_id",\\s*/g, '');
content = content.replace(/"audit_logs",\\s*/g, '');

content = content.replace(/"classification_key",/g, '"classification_key",\\n"rule_source",\\n"recoverability_result",\\n"recovery_reason",\\n"review_status",');

fs.writeFileSync(path, content, 'utf8');
console.log('expenseService.js updated');
