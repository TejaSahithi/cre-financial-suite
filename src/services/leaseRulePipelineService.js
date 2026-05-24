import { supabase } from "@/services/supabaseClient";
import leaseExpenseRuleService from "./leaseExpenseRuleService";
import { resolveLeaseField } from "@/lib/leaseFieldResolver";

const VALID_EVIDENCE = (text) => {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  const invalid = ["manual_review", "tenant_recovery", "tenant_direct", "inferred", "default"];
  if (invalid.some(word => lower.includes(word))) return false;
  
  const unrelated = ["assignment", "notice address", "permitted use", "tenant improvement"];
  if (unrelated.some(word => lower.includes(word))) return false;

  return true;
};

const firstPresent = (...args) => args.find(a => a !== null && a !== undefined && a !== "");
const asNumber = (val) => {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === 'number') return val;
  const str = String(val).replace(/[^0-9.-]/g, '');
  if (!str) return null;
  const num = Number(str);
  return isNaN(num) ? null : num;
};

// ... Wait, I should fetch the lease first
export const leaseRulePipelineService = {
  async generateLeaseExpenseRulesForLease({ leaseId, force = false, source = "manual_extract" }) {
    console.log("[NEW PIPELINE CALLED]", { leaseId, force, source });
    if (!leaseId) throw new Error("leaseId is required");

    let diagnostics = {
      leaseId,
      documentType: "original_lease",
      sourceFileId: null,
      sourceTextLength: 0,
      workflowRulesCount: 0,
      structuredTermRulesCount: 0,
      deterministicRulesCount: 0,
      textFallbackRulesCount: 0,
      llmRulesCount: 0,
      mergedRulesCount: 0,
      persistedRulesCount: 0,
      weakEvidenceCount: 0,
      skippedReasons: null
    };

    // 1. Fetch lease
    const { data: lease, error: leaseErr } = await supabase
      .from("leases")
      .select("*")
      .eq("id", leaseId)
      .maybeSingle();

    if (leaseErr) {
      console.error("[PIPELINE ERROR] Lease fetch failed:", leaseErr);
      throw leaseErr;
    }
    if (!lease) {
      diagnostics.skippedReasons = "Lease not found";
      return diagnostics;
    }

    // 2. Side-load related rows separately only if IDs exist
    if (lease.unit_id) {
      const { data: unit, error: unitErr } = await supabase.from("units").select("*").eq("id", lease.unit_id).maybeSingle();
      if (unitErr) console.warn("[PIPELINE SIDELOAD WARNING] unit fetch failed:", unitErr);
      lease.unit = unit || null;
    }
    if (lease.property_id) {
      const { data: property, error: propErr } = await supabase.from("properties").select("*").eq("id", lease.property_id).maybeSingle();
      if (propErr) console.warn("[PIPELINE SIDELOAD WARNING] property fetch failed:", propErr);
      lease.property = property || null;
    }
    if (lease.building_id) {
      const { data: building, error: buildErr } = await supabase.from("buildings").select("*").eq("id", lease.building_id).maybeSingle();
      if (buildErr) console.warn("[PIPELINE SIDELOAD WARNING] building fetch failed:", buildErr);
      lease.building = building || null;
    }

    // Populate tenant_id and org_id
    let tenantId = lease.tenant_id || lease.primary_tenant_id || lease.unit?.tenant_id || null;
    if (!tenantId && lease.tenant_name) {
      const { data: t } = await supabase.from("tenants").select("id").ilike("name", lease.tenant_name).maybeSingle();
      if (t) tenantId = t.id;
    }
    lease.tenant_id = tenantId;
    lease.org_id = lease.org_id || lease.property?.org_id || lease.building?.org_id || null;

    if (leaseErr || !lease) {
      diagnostics.skippedReasons = "Lease not found";
      return diagnostics;
    }

    // 2. Resolve Source File ID
    let fileId = lease.source_file_id || lease.uploaded_file_id || lease.file_id || lease?.extraction_data?.source_file_id;
    if (!fileId) {
      const { data: docLink } = await supabase
        .from("document_links")
        .select("file_id, uploaded_file_id")
        .eq("entity_id", leaseId)
        .eq("entity_type", "lease")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (docLink) fileId = docLink.uploaded_file_id || docLink.file_id;
    }
    diagnostics.sourceFileId = fileId;

    // 3. Resolve Text
    let sourceText = "";
    let uploadedFile = null;
    if (fileId) {
      const { data: file } = await supabase
        .from("uploaded_files")
        .select("normalized_output, parsed_data, docling_raw, reviewed_output, ui_review_payload, is_scanned, file_type")
        .eq("id", fileId)
        .maybeSingle();
      uploadedFile = file;

      if (file) {
        const candidates = [
          file?.docling_raw?.full_text,
          file?.docling_raw?.markdown,
          file?.docling_raw?.text,
          file?.docling_raw?.body,
          file?.normalized_output?.raw_text,
          file?.normalized_output?.text,
          file?.parsed_data?.full_text,
          file?.parsed_data?.raw_text,
          file?.parsed_data?.text,
          file?.reviewed_output,
          file?.ui_review_payload,
          lease?.extraction_data?.workflow_output,
          lease?.extraction_data?.abstract,
          lease?.extracted_text
        ];

        for (const c of candidates) {
          if (c && typeof c === 'string' && c.trim()) {
            sourceText = c.trim();
            break;
          } else if (c && typeof c === 'object') {
             // If it's an object, stringify to check if it has useful content?
             // Actually, reviewed_output might be an object. We'll stringify it just in case if it has text inside.
             const s = JSON.stringify(c);
             if (s.length > 50) {
                 sourceText = s;
                 break;
             }
          }
        }

        // OCR Fallback for Scanned PDF
        if (!sourceText && (file.is_scanned || String(file.file_type).toLowerCase().includes('pdf') || String(file.file_type).toLowerCase().includes('image'))) {
          try {
            console.log("Triggering OCR Vision Fallback...");
            const { data: ocrData } = await supabase.functions.invoke("ocr-vision-extract", { body: { fileId } });
            if (ocrData?.text) {
              sourceText = ocrData.text;
              await supabase.from("uploaded_files").update({ 
                parsed_data: { ...(file.parsed_data || {}), full_text: sourceText } 
              }).eq("id", fileId);
            }
          } catch (ocrErr) {
             console.warn("OCR fallback failed:", ocrErr);
          }
        }
      }
    }
    
    if (!sourceText && lease?.extracted_text) {
      sourceText = lease.extracted_text;
    }
    
    diagnostics.sourceTextLength = sourceText?.length || 0;

    // 4. Document Type Detection
    const leaseNameLower = String(lease.name || lease.lease_name || "").toLowerCase();
    const isAssignment = leaseNameLower.includes("assignment");
    const isAmendment = leaseNameLower.includes("amend");
    if (isAssignment) diagnostics.documentType = "assignment";
    else if (isAmendment) diagnostics.documentType = "amendment";
    else if (leaseNameLower.includes("renewal")) diagnostics.documentType = "renewal";
    else if (leaseNameLower.includes("estoppel")) diagnostics.documentType = "estoppel";
    else if (leaseNameLower.includes("exhibit")) diagnostics.documentType = "exhibit";



    console.log("[PIPELINE INPUT]", {
      leaseId,
      sourceFileId: diagnostics.sourceFileId,
      sourceTextLength: diagnostics.sourceTextLength,
      documentType: diagnostics.documentType,
      leaseType: lease.lease_type,
      hasExtractionData: !!lease?.extraction_data,
      extractionKeys: Object.keys(lease?.extraction_data || {})
    });

    // For Summit (force true rerun), clean up bad null rows first
    if (force) {
      console.log("[FORCE DELETE OLD RULES]", { leaseId, force });
      const { data: deletedData, error: deleteError } = await supabase.from("lease_expense_rules").delete().eq("lease_id", leaseId).select("*");
      console.log("[DELETE RESULT]", { deletedData, deleteError });
      
      const { count: postDeleteCount, error: countError } = await supabase.from("lease_expense_rules").select("*", { count: "exact", head: true }).eq("lease_id", leaseId);
      console.log("[POST DELETE RULE COUNT]", { postDeleteCount, countError });
    }

    // 5. Collect Candidates
    const candidates = [];

    // 5.a Workflow Output
    let workflowRules = [];
    if (Array.isArray(lease?.extraction_data?.workflow_output?.expense_rules)) {
      workflowRules = lease.extraction_data.workflow_output.expense_rules;
    } else if (Array.isArray(lease?.extraction_data?.expenses)) {
      workflowRules = lease.extraction_data.expenses;
    } else if (Array.isArray(lease?.extraction_data?.rules)) {
      workflowRules = lease.extraction_data.rules;
    }
    diagnostics.workflowRulesCount = workflowRules.length;
    workflowRules.forEach((r, i) => candidates.push(this.mapWorkflowRule(r, i, lease.id)));

    // 5.b Structured Term Rules (Resolver)
    const structuredRules = this.buildStructuredRules(lease, sourceText);
    diagnostics.structuredTermRulesCount = structuredRules.length;
    candidates.push(...structuredRules);

    // 5.c Deterministic Templates
    const templateRules = this.buildTemplateRules(lease, sourceText);
    diagnostics.deterministicRulesCount = templateRules.length;
    candidates.push(...templateRules);

    // 5.d Text Fallback
    const textRules = sourceText ? leaseExpenseRuleService.buildTextFallbackRules(sourceText) : [];
    diagnostics.textFallbackRulesCount = textRules.length;
    textRules.forEach(r => candidates.push({ ...r, source_type: "text_fallback" }));

    // 5.e LLM Extraction
    let llmRules = [];
    if (sourceText && force) {
       try {
         const { data: llmData, error: llmErr } = await supabase.functions.invoke("extract-lease-expense-rules", { body: { text: sourceText } });
         if (llmErr) {
            console.error("[LLM EXTRACTION FAILED]", llmErr);
         } else if (llmData?.rules) {
            llmRules = llmData.rules;
         }
       } catch (err) {
         console.error("[LLM EXTRACTION CATCH ERROR]", err);
       }
    }
    diagnostics.llmRulesCount = llmRules.length;
    llmRules.forEach(r => candidates.push(this.mapLlmRule(r, lease.id)));

    // 6. Merge, Score, Dedupe
    const merged = this.mergeAndScoreCandidates(candidates);
    diagnostics.mergedRulesCount = merged.length;

    console.log("[PIPELINE CANDIDATES]", {
      workflowRulesCount: diagnostics.workflowRulesCount,
      structuredTermRulesCount: diagnostics.structuredTermRulesCount,
      deterministicRulesCount: diagnostics.deterministicRulesCount,
      textFallbackRulesCount: diagnostics.textFallbackRulesCount,
      llmRulesCount: diagnostics.llmRulesCount,
      mergedRulesCount: diagnostics.mergedRulesCount
    });

    if (diagnostics.mergedRulesCount === 0) {
      throw new Error("NEW PIPELINE GENERATED ZERO RULES");
    }

    // 7. Evidence Validation & Save
    const finalRules = merged.map(r => {
      let conf = r.confidence_score || r.confidence || 0.8;
      let valid = VALID_EVIDENCE(r.exact_source_text);
      if (!valid) {
        // If evidence is invalid, force weak evidence and need review
        r.exact_source_text = null;
        r.confidence_score = Math.min(conf, 0.50);
        r.review_status = "needs_review";
        r.approval_status = "draft";
        r.extraction_status = "weak_evidence";
        diagnostics.weakEvidenceCount++;
      } else if (r.confidence_score <= 0.55) {
        r.review_status = "needs_review";
        r.approval_status = "draft";
        r.extraction_status = r.exact_source_text ? "weak_evidence" : "inferred";
        diagnostics.weakEvidenceCount++;
      }

      // Generate rule_type if missing
      if (!r.rule_type) {
         if (r.is_excluded || r.payment_treatment === "not_applicable") r.rule_type = "excluded";
         else if (r.payment_treatment === "tenant_direct_contract") r.rule_type = "tenant_direct";
         else if (r.included_in_base_rent === true || r.included_in_base_rent === "yes") r.rule_type = "full_service_included";
         else if (r.has_base_year || r.recovery_method === "base_year") r.rule_type = "modified_gross_base_year";
         else if (r.recoverable_from_tenant === "conditional") r.rule_type = "conditional_recovery";
         else if (r.recoverable_from_tenant === "yes") r.rule_type = "nnn_recoverable";
         else r.rule_type = "additional_rent";
      }
      // Set rule_key explicitly so saveRuleSet uses it instead of regenerating
      r.rule_key = `${lease.id}_${r.rule_type}_${r.normalized_key}_${r.source_field_key || 'workflow'}`;
      
      r.extraction_version = "lease_rule_pipeline_v2";
      r.generation_source = "lease_rule_pipeline_v2";

      return r;
    }).filter(r => r.normalized_key !== "structured_terms"); // Filter out the dummy row if it wasn't merged away

    // Diagnostics Payload Output
    if (finalRules.length > 0) {
      console.log(`[FINAL PAYLOAD BEFORE SAVE] Lease ${leaseId}:`);
      console.table(finalRules.map(p => ({
        lease_id: lease.id,
        rule_key: p.rule_key,
        rule_type: p.rule_type,
        expense_category: p.expense_category,
        tenant_share_percent: p.tenant_share_percent,
        estimated_annual_amount: p.estimated_annual_amount,
        estimated_monthly_amount: p.estimated_monthly_amount,
        admin_fee_percent: p.admin_fee_percent,
        gross_up_percent: p.gross_up_percent,
        cap_percent: p.cap_percent,
        extraction_version: p.extraction_version,
        generation_source: p.generation_source
      })));
    }

    const saved = await leaseExpenseRuleService.saveRuleSet({
      lease,
      rules: finalRules,
      status: "draft",
      createdFrom: source,
      categories: []
    });

    const { count, error: countError } = await supabase
      .from("lease_expense_rules")
      .select("id", { count: "exact", head: true })
      .eq("lease_id", leaseId);

    console.log("[POST UPSERT RULE COUNT]", { leaseId, count, countError });

    diagnostics.persistedRulesCount = saved?.rules?.length || 0;

    return diagnostics;
  },

  mapWorkflowRule(rule, index, leaseId) {
    // Basic mapping, similar to buildFallbackRulesFromWorkflow
    return {
      ...rule,
      lease_id: leaseId,
      source_type: "workflow_output",
      confidence_score: rule.confidence || 0.9,
      expense_category: rule.expense_category || rule.category || `rule_${index}`,
      normalized_key: String(rule.expense_category || `rule_${index}`).toLowerCase().replace(/\s+/g, '_')
    };
  },

  buildStructuredRules(lease, sourceText = "") {
    const rules = [];
    
    // Extract base structured terms using field resolver
    const resolve = (key) => {
      const res = resolveLeaseField(lease, key, { mode: "canonical" });
      return res?.value ?? null;
    };

    const textMatcher = (regex, processor = asNumber) => {
      const match = typeof sourceText === 'string' ? sourceText.match(regex) : null;
      return match ? processor(match[1]) : null;
    };

    const tenantShare = asNumber(resolve("tenant_share_percent") || resolve("pro_rata_share")) 
      || textMatcher(/tenant'?s\s+pro\s*rata\s+share\s+(?:shall\s+be\s+)?([0-9.]+)\s*%/i)
      || textMatcher(/([0-9.]+)\s*%\s*(?:of|as)\s*(?:tenant'?s)?\s*pro\s*rata\s+share/i);
      
    const estimatedAnnual = asNumber(resolve("estimated_annual_amount") || resolve("cam_estimate_annual"))
      || textMatcher(/estimated?\s+annual\s+(?:amount|cam|expenses?)[\s:]+\$?([0-9,.]+)/i, (val) => asNumber(val.replace(/,/g, '')));
      
    const estimatedMonthly = asNumber(resolve("estimated_monthly_amount") || resolve("cam_estimate_monthly"))
      || textMatcher(/estimated?\s+monthly\s+(?:amount|cam|expenses?)[\s:]+\$?([0-9,.]+)/i, (val) => asNumber(val.replace(/,/g, '')))
      || (estimatedAnnual ? parseFloat((estimatedAnnual / 12).toFixed(2)) : null);
      
    const adminFee = asNumber(resolve("admin_fee_percent") || resolve("administrative_fee"))
      || textMatcher(/administrative\s+fee\s+(?:equal\s+to\s+|of\s+)?([0-9.]+)\s*%/i);
      
    const mgmtFee = asNumber(resolve("management_fee_percent") || resolve("management_fee"))
      || textMatcher(/management\s+fee\s+(?:equal\s+to\s+|of\s+)?([0-9.]+)\s*%/i);
      
    const grossUp = asNumber(resolve("gross_up_percent") || resolve("gross_up"))
      || textMatcher(/gross[- ]up\s+(?:to\s+)?([0-9.]+)\s*%/i);
      
    const capPercent = asNumber(resolve("cap_percent") || resolve("expense_cap"))
      || textMatcher(/shall\s+not\s+increase\s+by\s+more\s+than\s+([0-9.]+)\s*%/i)
      || textMatcher(/cap(?:ped)?\s+at\s+([0-9.]+)\s*%/i);
      
    const capType = resolve("cap_type");
    const reconciliation = resolve("reconciliation_required") || resolve("cam_reconciliation");
    
    const baseYear = resolve("base_year") || resolve("expense_base_year");
    const opExBase = asNumber(resolve("operating_expense_base_amount"));
    const taxBase = asNumber(resolve("tax_base_amount"));
    const insBase = asNumber(resolve("insurance_base_amount"));

    // If we have these values, we should append them to all structured rules or create a dummy rule 
    // that the merger will merge into other rules.
    // Instead of creating a dummy rule, let's create a generic "structured_terms" rule that has these fields.
    // When merging, these fields will enrich the other rules.
    const structuredRule = {
      expense_category: "structured_terms",
      normalized_key: "structured_terms",
      source_type: "structured",
      confidence_score: 0.95,
      tenant_share_percent: tenantShare,
      estimated_annual_amount: estimatedAnnual,
      estimated_monthly_amount: estimatedMonthly,
      admin_fee_percent: adminFee,
      admin_fee_applicable: adminFee != null ? true : undefined,
      management_fee_percent: mgmtFee,
      gross_up_percent: grossUp,
      gross_up_applicable: grossUp != null ? true : undefined,
      cap_percent: capPercent,
      cap_type: capType,
      is_subject_to_cap: (capPercent != null || capType != null) ? true : undefined,
      reconciliation_required: reconciliation === "yes" || reconciliation === true,
      base_year: baseYear,
      base_year_amount: opExBase,
      tax_base_amount: taxBase,
      insurance_base_amount: insBase
    };

    rules.push(structuredRule);
    return rules;
  },

  buildTemplateRules(lease, sourceText = "") {
    const rules = [];
    const leaseType = String(lease.lease_type || lease.abstract_snapshot?.lease_type || "").toLowerCase().trim();
    
    const leaseText = JSON.stringify(lease.extraction_data || {}) + " " + sourceText;
    const textLower = leaseText.toLowerCase();
    
    const isNnn = leaseType.includes("nnn") || leaseType.includes("triple") || leaseType.includes("net")
      || textLower.includes("triple net") || textLower.includes("nnn") 
      || textLower.includes("tenant's pro rata share") || textLower.includes("recoverable common area maintenance")
      || textLower.includes("cam reimbursements") || textLower.includes("tax reimbursements") || textLower.includes("insurance reimbursements");

    if (leaseType.includes("full") || leaseType.includes("gross")) {
       // A. Full Service
       rules.push(this.makeTemplateRule("utilities", true, "no", "no"));
       rules.push(this.makeTemplateRule("janitorial", true, "no", "no"));
       rules.push(this.makeTemplateRule("property tax", true, "no", "no"));
       rules.push(this.makeTemplateRule("property insurance", true, "no", "no"));
       rules.push(this.makeTemplateRule("maintenance", true, "no", "no"));
       rules.push(this.makeTemplateRule("excess utilities", false, "conditional", "conditional"));
       rules.push(this.makeTemplateRule("tenant insurance", false, "tenant_direct", "no", "tenant_direct_contract"));
       rules.push(this.makeTemplateRule("alterations", false, "tenant_direct", "no", "tenant_direct_contract"));
    } else if (isNnn) {
       // B. NNN
       const nnnItems = [
         "Common Area Maintenance", "Operating Expenses", "Real Estate Taxes", "Property Insurance",
         "Utilities", "Repairs & Maintenance", "Management Fees", "Administrative Fees", "Trash Removal",
         "Janitorial", "Security", "Landscaping", "Snow Removal", "Tenant Caused Damage",
         "Legal / Enforcement Fees", "Late Fees", "Interest", "Separately Metered Charges", "Tenant Insurance"
       ];
       nnnItems.forEach(item => {
          rules.push(this.makeTemplateRule(item, false, "yes", "yes"));
       });
    } else if (leaseType.includes("modified") || leaseType.includes("base year")) {
       // C. Modified Gross
       const mgItems = ["operating expenses", "taxes", "insurance"];
       mgItems.forEach(item => {
          rules.push(this.makeTemplateRule(item, true, "conditional", "conditional")); // Up to base year
       });
    }
    return rules;
  },

  makeTemplateRule(category, included, recoverable, camEligible, responsibility = "landlord") {
    let ruleType = "additional_rent";
    if (included) ruleType = "full_service_included";
    else if (recoverable === "yes") ruleType = "nnn_recoverable";
    else if (recoverable === "conditional") ruleType = "modified_gross_base_year";
    else if (recoverable === "tenant_direct" || responsibility === "tenant_direct_contract") ruleType = "tenant_direct";

    return {
      expense_category: category,
      normalized_key: category.replace(/\s+/g, "_"),
      included_in_base_rent: included,
      recoverable_from_tenant: recoverable,
      cam_eligible: camEligible,
      responsibility: responsibility,
      source_type: "deterministic_template",
      confidence_score: 0.85,
      rule_type: ruleType
    };
  },

  mapLlmRule(rule, leaseId) {
    return {
      ...rule,
      lease_id: leaseId,
      source_type: "llm_extraction",
      confidence_score: rule.confidence || 0.7
    };
  },

  mergeAndScoreCandidates(candidates) {
     const mergedMap = new Map();
     
     // 1. Find global structured terms
     const structuredTermsRule = candidates.find(c => c.normalized_key === "structured_terms") || {};
     
     // Dedupe by normalized_key
     for (let c of candidates) {
        if (!c.normalized_key || c.normalized_key === "structured_terms") continue;
        
        // Spread global structured terms onto the rule
        c = { 
           ...c,
           tenant_share_percent: firstPresent(c.tenant_share_percent, structuredTermsRule.tenant_share_percent),
           estimated_annual_amount: firstPresent(c.estimated_annual_amount, structuredTermsRule.estimated_annual_amount),
           estimated_monthly_amount: firstPresent(c.estimated_monthly_amount, structuredTermsRule.estimated_monthly_amount),
           admin_fee_percent: firstPresent(c.admin_fee_percent, structuredTermsRule.admin_fee_percent),
           admin_fee_applicable: firstPresent(c.admin_fee_applicable, structuredTermsRule.admin_fee_applicable),
           management_fee_percent: firstPresent(c.management_fee_percent, structuredTermsRule.management_fee_percent),
           gross_up_percent: firstPresent(c.gross_up_percent, structuredTermsRule.gross_up_percent),
           gross_up_applicable: firstPresent(c.gross_up_applicable, structuredTermsRule.gross_up_applicable),
           cap_percent: firstPresent(c.cap_percent, structuredTermsRule.cap_percent),
           cap_type: firstPresent(c.cap_type, structuredTermsRule.cap_type),
           is_subject_to_cap: firstPresent(c.is_subject_to_cap, structuredTermsRule.is_subject_to_cap),
           reconciliation_required: firstPresent(c.reconciliation_required, structuredTermsRule.reconciliation_required),
           base_year: firstPresent(c.base_year, structuredTermsRule.base_year),
           base_year_amount: firstPresent(c.base_year_amount, structuredTermsRule.base_year_amount),
           tax_base_amount: firstPresent(c.tax_base_amount, structuredTermsRule.tax_base_amount),
           insurance_base_amount: firstPresent(c.insurance_base_amount, structuredTermsRule.insurance_base_amount)
        };

        const key = c.normalized_key;
        if (!mergedMap.has(key)) {
           mergedMap.set(key, c);
        } else {
           const existing = mergedMap.get(key);
           // Merge logic: prefer workflow > llm > template > text_fallback
           const scoreMap = { workflow_output: 4, structured: 3, llm_extraction: 2, deterministic_template: 1, text_fallback: 0 };
           const existingScore = scoreMap[existing.source_type] || 0;
           const newScore = scoreMap[c.source_type] || 0;
           
           if (newScore > existingScore) {
              mergedMap.set(key, { ...existing, ...c, confidence_score: Math.max(existing.confidence_score||0, c.confidence_score||0) });
           } else {
              mergedMap.set(key, { ...c, ...existing, confidence_score: Math.max(existing.confidence_score||0, c.confidence_score||0) });
           }
        }
     }
     
     return Array.from(mergedMap.values());
  }
};

export default leaseRulePipelineService;
