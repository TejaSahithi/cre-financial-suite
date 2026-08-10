import React, { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Paperclip, ArrowLeft, Plus, FileUp, CheckCircle2, AlertCircle } from "lucide-react";

import { expenseService } from "@/services/expenseService";
import { vendorService } from "@/services/vendorService";
import { createNotificationsForEvent } from "@/services/notificationService";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction, invokeEdgeFunctionFormData } from "@/services/edgeFunctions";
import useOrgQuery from "@/hooks/useOrgQuery";
import useExpenseCategories from "@/hooks/useExpenseCategories";
import { buildHierarchyScope } from "@/lib/hierarchyScope";
import { resolveWritableOrgId } from "@/lib/orgUtils";
import {
  buildInvoiceExpenseCandidate,
  extractExpenseRowsFromUploadedFile,
  findEntityByName,
} from "@/lib/expenseInvoicePrefill";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { createPageUrl } from "@/utils";

const VENDOR_CATEGORIES = ["maintenance", "utilities", "insurance", "janitorial", "landscaping", "security", "legal", "accounting", "construction", "technology", "other"];

const DOCUMENT_UPLOAD_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.tsv,.png,.jpg,.jpeg,.tiff,.tif,.webp,.gif,.bmp";
const DOCUMENT_UPLOAD_HELP_TEXT = "PDF, Word, Excel, CSV, text, or image files up to 50MB";

function buildInitialForm(scope) {
  return {
    date: "",
    amount: "",
    category: "",
    expense_category_id: "",
    expense_subcategory: "",
    gl_code: "",
    invoice_number: "",
    vendor: "",
    vendor_id: "",
    tenant_name: "",
    tenant_id: "",
    lease_id: "",
    recovery_rule_id: "",
    linked_expense_rule_id: "",
    source: "manual",
    source_file_id: "",
    description: "",
    classification: "recoverable",
    portfolio_id: scope.portfolioId || "",
    property_id: scope.propertyId || "",
    building_id: scope.buildingId || "",
    unit_id: scope.unitId || "",
  };
}

export default function AddExpense() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const urlParams = new URLSearchParams(location.search);
  const editExpenseId = urlParams.get("id");
  const entryMode = urlParams.get("mode") === "invoice" ? "invoice" : "manual";
  const isInvoiceMode = !editExpenseId && entryMode === "invoice";
  const prefillParams = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return {
      tenantId: params.get("tenant_id") || params.get("tenant") || "",
      leaseId: params.get("lease_id") || "",
      category: params.get("category") || "",
      subcategory: params.get("subcategory") || params.get("expense_subcategory") || "",
      description: params.get("description") || "",
      vendor: params.get("vendor") || "",
      date: params.get("date") || "",
      amount: params.get("amount") || "",
      recoveryRuleId: params.get("rule_id") || params.get("recovery_rule_id") || "",
    };
  }, [location.search]);
  const { data: vendors = [], orgId } = useOrgQuery("Vendor");
  const { data: expenses = [] } = useOrgQuery("Expense");
  const { data: tenants = [] } = useOrgQuery("Tenant");
  const { data: leases = [] } = useOrgQuery("Lease");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  const { data: expenseCategories = [] } = useExpenseCategories();

  const scope = useMemo(
    () =>
      buildHierarchyScope({
        search: location.search,
        portfolios,
        properties,
        buildings,
        units,
      }),
    [location.search, portfolios, properties, buildings, units]
  );

  const [form, setForm] = useState(() => buildInitialForm(scope));
  const [attachmentUrl, setAttachmentUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [invoiceExtractionStatus, setInvoiceExtractionStatus] = useState("");
  const [invoiceExtractionError, setInvoiceExtractionError] = useState("");
  const [extractedInvoiceName, setExtractedInvoiceName] = useState("");
  const [pendingInvoiceUpload, setPendingInvoiceUpload] = useState(null);
  const [invoiceDetailsVisible, setInvoiceDetailsVisible] = useState(!isInvoiceMode);
  const invoiceFileInputRef = useRef(null);
  const prefillAppliedKeyRef = useRef("");
  const [showNewVendor, setShowNewVendor] = useState(false);
  const [newVendorForm, setNewVendorForm] = useState({
    name: "",
    company: "",
    contact_email: "",
    category: "other",
    payment_terms: "net_30",
  });

  const editingExpense = useMemo(
    () => expenses.find((expense) => expense.id === editExpenseId) || null,
    [expenses, editExpenseId]
  );
  const isEditing = Boolean(editExpenseId);

  useEffect(() => {
    setInvoiceDetailsVisible(isEditing || !isInvoiceMode);
    if (!isInvoiceMode) {
      setPendingInvoiceUpload(null);
      setInvoiceExtractionStatus("");
      setInvoiceExtractionError("");
      setExtractedInvoiceName("");
    }
  }, [isEditing, isInvoiceMode]);
  useEffect(() => {
    if (isEditing) return;
    setForm((current) => ({
      ...current,
      portfolio_id: scope.portfolioId || current.portfolio_id || "",
      property_id: scope.propertyId || current.property_id || "",
      building_id: scope.buildingId || current.building_id || "",
      unit_id: scope.unitId || current.unit_id || "",
    }));
  }, [isEditing, scope.portfolioId, scope.propertyId, scope.buildingId, scope.unitId]);

  useEffect(() => {
    if (isEditing) return;
    const hasPrefill = Object.values(prefillParams).some(Boolean);
    if (!hasPrefill) return;
    if (prefillParams.leaseId && leases.length === 0) return;
    if (prefillParams.tenantId && tenants.length === 0) return;
    const prefillKey = JSON.stringify(prefillParams);
    if (prefillAppliedKeyRef.current === prefillKey) return;
    prefillAppliedKeyRef.current = prefillKey;

    const lease = prefillParams.leaseId
      ? leases.find((item) => item.id === prefillParams.leaseId) || null
      : null;
    const tenant = prefillParams.tenantId
      ? tenants.find((item) => item.id === prefillParams.tenantId) || null
      : lease?.tenant_id
        ? tenants.find((item) => item.id === lease.tenant_id) || null
        : null;
    const leaseUnit = lease?.unit_id ? units.find((unit) => unit.id === lease.unit_id) || null : null;

    setForm((current) => ({
      ...current,
      date: prefillParams.date || current.date,
      amount: prefillParams.amount || current.amount,
      category: prefillParams.category || current.category,
      expense_subcategory: prefillParams.subcategory || current.expense_subcategory,
      vendor: prefillParams.vendor || current.vendor,
      tenant_name:
        tenant?.tenant_name ||
        tenant?.name ||
        tenant?.company ||
        lease?.tenant_name ||
        current.tenant_name,
      tenant_id: prefillParams.tenantId || lease?.tenant_id || current.tenant_id,
      lease_id: prefillParams.leaseId || current.lease_id,
      description: prefillParams.description || current.description,
      property_id: lease?.property_id || current.property_id,
      building_id: lease?.building_id || leaseUnit?.building_id || current.building_id,
      unit_id: lease?.unit_id || current.unit_id,
      recovery_rule_id: prefillParams.recoveryRuleId || current.recovery_rule_id,
      linked_expense_rule_id: prefillParams.recoveryRuleId || current.linked_expense_rule_id,
    }));
  }, [isEditing, prefillParams, leases, tenants, units]);
  useEffect(() => {
    if (!editingExpense) return;
    setForm({
      date: editingExpense.date || "",
      amount: editingExpense.amount ?? "",
      category: editingExpense.category || "",
      expense_category_id: editingExpense.expense_category_id || "",
      expense_subcategory: editingExpense.expense_subcategory || "",
      gl_code: editingExpense.gl_code || "",
      invoice_number: editingExpense.invoice_number || "",
      vendor: editingExpense.vendor || "",
      vendor_id: editingExpense.vendor_id || "",
      tenant_name: editingExpense.tenant_name || "",
      tenant_id: editingExpense.tenant_id || "",
      lease_id: editingExpense.lease_id || "",
      recovery_rule_id: editingExpense.recovery_rule_id || "",
      linked_expense_rule_id: editingExpense.linked_expense_rule_id || "",
      source: editingExpense.source || "manual",
      source_file_id: editingExpense.source_file_id || "",
      description: editingExpense.description || "",
      classification: editingExpense.classification || "recoverable",
      portfolio_id: editingExpense.portfolio_id || "",
      property_id: editingExpense.property_id || "",
      building_id: editingExpense.building_id || "",
      unit_id: editingExpense.unit_id || "",
    });
    setAttachmentUrl(editingExpense.attachment_url || "");
  }, [editingExpense]);

  const categoryOptions = useMemo(
    () => [...expenseCategories].sort((left, right) => {
      const leftOrder = Number(left.display_order ?? 999999);
      const rightOrder = Number(right.display_order ?? 999999);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return String(left.category_name || "").localeCompare(String(right.category_name || ""));
    }),
    [expenseCategories]
  );

  const categoryById = useMemo(
    () => new Map(categoryOptions.map((category) => [category.id, category])),
    [categoryOptions]
  );

  const selectedCategory = form.expense_category_id ? categoryById.get(form.expense_category_id) || null : null;

  const handleCategorySelect = (categoryId) => {
    const category = categoryById.get(categoryId) || null;
    setForm((current) => ({
      ...current,
      expense_category_id: categoryId,
      category: category?.category_name || current.category,
      expense_subcategory: category?.subcategory_name || "",
    }));
  };

  const visibleProperties = scope.scopedProperties;
  const visibleBuildings = form.property_id
    ? scope.scopedBuildings.filter((building) => building.property_id === form.property_id)
    : scope.scopedBuildings;
  const visibleUnits = form.building_id
    ? scope.scopedUnits.filter((unit) => unit.building_id === form.building_id)
    : form.property_id
      ? scope.scopedUnits.filter((unit) => unit.property_id === form.property_id)
      : scope.scopedUnits;

  const expensesUrl = useMemo(() => {
    const params = new URLSearchParams(location.search);
    params.delete("id");
    params.delete("mode");
    const query = params.toString();
    return createPageUrl("Expenses") + (query ? `?${query}` : "");
  }, [location.search]);

  const createMutation = useMutation({
    mutationFn: (data) => expenseService.createExpenseWorkflow(data),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => expenseService.updateExpenseWorkflow(id, data),
  });

  const createVendorMutation = useMutation({
    mutationFn: (data) => vendorService.create(data),
    onSuccess: (newVendor) => {
      queryClient.setQueriesData({ queryKey: ["Vendor"] }, (current = []) =>
        current.some((vendor) => vendor.id === newVendor.id)
          ? current
          : [...current, newVendor]
      );
      queryClient.invalidateQueries({ queryKey: ["Vendor"] });
      setForm((current) => ({ ...current, vendor: newVendorForm.name, vendor_id: newVendor.id }));
      setShowNewVendor(false);
      setNewVendorForm({ name: "", company: "", contact_email: "", category: "other", payment_terms: "net_30" });
    },
  });

  const ensureVendorForSave = async (writableOrgId) => {
    const vendorName = String(form.vendor || "").trim();
    if (!vendorName) return {};

    const matchedVendor = form.vendor_id
      ? vendors.find((vendor) => vendor.id === form.vendor_id)
      : findEntityByName(vendors, vendorName, [(vendor) => vendor.name, (vendor) => vendor.company]);

    if (matchedVendor?.id) {
      return { vendor: matchedVendor.name || vendorName, vendor_id: matchedVendor.id };
    }

    const vendorCategory = VENDOR_CATEGORIES.includes(form.category) ? form.category : "other";
    const createdVendor = await vendorService.create({
      name: vendorName,
      company: vendorName,
      category: vendorCategory,
      payment_terms: "net_30",
      ...(writableOrgId ? { org_id: writableOrgId } : {}),
      status: "active",
    });

    if (!createdVendor?.id) {
      throw new Error(`Could not create vendor ${vendorName}`);
    }

    queryClient.setQueriesData({ queryKey: ["Vendor"] }, (current = []) =>
      current.some((vendor) => vendor.id === createdVendor.id)
        ? current
        : [...current, createdVendor]
    );
    queryClient.invalidateQueries({ queryKey: ["Vendor"] });
    setForm((current) => ({ ...current, vendor: createdVendor.name || vendorName, vendor_id: createdVendor.id }));
    return { vendor: createdVendor.name || vendorName, vendor_id: createdVendor.id };
  };

  const handleSubmit = async (addAnother, { saveAsDraft = false } = {}) => {
    const writableOrgId = await resolveWritableOrgId(orgId);
    let resolvedVendorFields = {};
    try {
      resolvedVendorFields = await ensureVendorForSave(writableOrgId);
    } catch (err) {
      toast.error(`Could not create/link vendor: ${err?.message || "Unknown error"}`);
      return;
    }
    const property = form.property_id ? scope.propertyById.get(form.property_id) ?? null : null;
    
    // Respect the user's tenant selection. Only derive a lease when exactly
    // one approved/active lease matches the selected tenant, scope and date.
    const matchingLeases = leases.filter((lease) => {
      const status = String(lease.status || "").toLowerCase();
      if (status && !["approved", "active", "executed", "budget_ready"].includes(status)) return false;
      if (form.tenant_id && lease.tenant_id !== form.tenant_id) return false;
      if (form.property_id && lease.property_id !== form.property_id) return false;
      if (form.building_id && lease.building_id && lease.building_id !== form.building_id) return false;
      if (form.unit_id && lease.unit_id && lease.unit_id !== form.unit_id) return false;
      if (form.date && lease.start_date && form.date < lease.start_date) return false;
      if (form.date && lease.end_date && form.date > lease.end_date) return false;
      return true;
    });
    const matchedLease =
      (form.lease_id ? leases.find((lease) => lease.id === form.lease_id) : null) ||
      (matchingLeases.length === 1 ? matchingLeases[0] : null);
    const resolvedLeaseId = matchedLease?.id || null;
    const resolvedTenantId = form.tenant_id || matchedLease?.tenant_id || null;

    if (isEditing) {
      updateMutation.mutate(
        {
          id: editExpenseId,
          data: {
            ...form,
            ...resolvedVendorFields,
            amount: parseFloat(form.amount),
            attachment_url: attachmentUrl,
            ...(writableOrgId ? { org_id: writableOrgId } : {}),
            portfolio_id: property?.portfolio_id || form.portfolio_id || null,
            property_id: form.property_id || null,
            building_id: form.building_id || null,
            unit_id: form.unit_id || null,
            lease_id: resolvedLeaseId,
            tenant_id: resolvedTenantId,
            skip_lease_resolution: !resolvedLeaseId && !resolvedTenantId,
            source: form.source || "manual",
            fiscal_year: form.date ? new Date(form.date).getFullYear() : new Date().getFullYear(),
            service_period_start: form.date || null,
            service_period_end: form.date || null,
          },
        },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["Expense"] });
            toast.success("Expense updated successfully");
            navigate(expensesUrl);
          },
          onError: (err) => {
            toast.error(`Failed to update expense: ${err?.message || "Unknown error"}`);
          },
        }
      );
      return;
    }

    createMutation.mutate(
      {
        ...form,
        ...resolvedVendorFields,
        amount: parseFloat(form.amount),
        attachment_url: attachmentUrl,
        // Only set org_id if resolved — api.js handles the SuperAdmin fallback
        ...(writableOrgId ? { org_id: writableOrgId } : {}),
        portfolio_id: property?.portfolio_id || form.portfolio_id || null,
        property_id: form.property_id || null,
        building_id: form.building_id || null,
        unit_id: form.unit_id || null,
        lease_id: resolvedLeaseId,
        tenant_id: resolvedTenantId,
        skip_lease_resolution: !resolvedLeaseId && !resolvedTenantId,
        source: form.source || (isInvoiceMode ? "invoice" : "manual"),
        fiscal_year: form.date ? new Date(form.date).getFullYear() : new Date().getFullYear(),
        // Batch E (F9). Manual entries default to approved so the existing
        // single-step path stays unchanged. Save-as-draft sets both fields
        // to "draft" so the row fails isActualClassificationEligible until
        // a reviewer promotes it via the Expense Review workflow.
        approval_status: saveAsDraft ? "draft" : "approved",
        review_status: saveAsDraft ? "draft" : "approved",
        service_period_start: form.date || null,
        service_period_end: form.date || null,
      },
      {
          onSuccess: (result) => {
            const createdId = result?.expense_id || result?.id || result?.created_ids?.[0] || result?.createdIds?.[0] || null;
            createNotificationsForEvent({
              org_id: writableOrgId,
              event_type: saveAsDraft ? "expense.submitted" : "expense.approved",
              entity_type: "expense",
              entity_id: createdId,
              entity_label: form.description || resolvedVendorFields.vendor || form.vendor || "Expense",
              portfolio_id: property?.portfolio_id || form.portfolio_id || null,
              property_id: form.property_id || null,
              tenant_id: resolvedTenantId,
              action_url: createdId ? `${createPageUrl("Expenses")}?id=${createdId}` : expensesUrl,
              metadata: {
                source: saveAsDraft ? "expense_draft_create" : "expense_manual_approved_create",
                property_name: property?.name || property?.property_name || null,
                vendor_name: resolvedVendorFields.vendor || form.vendor || null,
                amount: parseFloat(form.amount),
                fiscal_year: form.date ? new Date(form.date).getFullYear() : new Date().getFullYear(),
                status: saveAsDraft ? "draft" : "approved",
              },
            }).catch((error) => {
              console.warn("[AddExpense] notification event failed:", error?.message || error);
            });
            queryClient.invalidateQueries({ queryKey: ["Expense"] });
            toast.success(saveAsDraft ? "Expense saved as draft" : "Expense saved successfully");
          if (addAnother) {
            setForm({
              ...buildInitialForm(scope),
              vendor: resolvedVendorFields.vendor || form.vendor,
              vendor_id: resolvedVendorFields.vendor_id || form.vendor_id,
              tenant_name: form.tenant_name,
              tenant_id: form.tenant_id,
              portfolio_id: property?.portfolio_id || form.portfolio_id || "",
              property_id: form.property_id || "",
              building_id: form.building_id || "",
              unit_id: form.unit_id || "",
            });
            setAttachmentUrl("");
          } else {
            navigate(expensesUrl);
          }
        },
        onError: (err) => {
          toast.error(`Failed to save expense: ${err?.message || "Unknown error"}`);
        },
      }
    );
  };

  const waitForInvoiceExtraction = async (fileId, timeoutMs = 120000) => {
    const startedAt = Date.now();
    let lastRecord = null;
    while (Date.now() - startedAt <= timeoutMs) {
      const { data, error } = await supabase
        .from("uploaded_files")
        .select("status,error_message,parsed_data,valid_data,normalized_output,ui_review_payload,reviewed_output,storage_path,docling_raw,azure_raw_response")
        .eq("id", fileId)
        .single();
      if (error) throw error;
      lastRecord = data;
      if (data?.status === "failed") {
        throw new Error(data.error_message || "Invoice extraction failed.");
      }
      const rows = extractExpenseRowsFromUploadedFile(data);
      if (rows.length > 0) return { record: data, rows };
      await new Promise((resolve) => globalThis.setTimeout(resolve, 1000));
    }
    throw new Error(lastRecord?.error_message || "Invoice extraction is still processing. Please try again.");
  };

  const applyInvoiceCandidate = (candidate) => {
    const matchedProperty = findEntityByName(
      properties,
      candidate.property_name,
      [(property) => property.name, (property) => property.address]
    );
    const propertyId = matchedProperty?.id || form.property_id || "";
    const propertyBuildings = propertyId
      ? buildings.filter((building) => building.property_id === propertyId)
      : buildings;
    const matchedBuilding = findEntityByName(
      propertyBuildings,
      candidate.building_name,
      [(building) => building.name]
    );
    const currentBuildingStillMatches = buildings.some(
      (building) => building.id === form.building_id && (!propertyId || building.property_id === propertyId)
    );
    const buildingId = matchedBuilding?.id || (currentBuildingStillMatches ? form.building_id : "");
    const scopedUnits = buildingId
      ? units.filter((unit) => unit.building_id === buildingId)
      : propertyId
        ? units.filter((unit) => unit.property_id === propertyId)
        : units;
    const matchedUnit = findEntityByName(
      scopedUnits,
      candidate.unit_number,
      [(unit) => unit.unit_number, (unit) => unit.unit_id_code]
    );
    const currentUnitStillMatches = scopedUnits.some((unit) => unit.id === form.unit_id);
    const matchedVendor = findEntityByName(
      vendors,
      candidate.vendor,
      [(vendor) => vendor.name, (vendor) => vendor.company]
    );
    const matchedTenant = findEntityByName(
      tenants,
      candidate.tenant_name,
      [(tenant) => tenant.tenant_name, (tenant) => tenant.name, (tenant) => tenant.company]
    );

    setForm((current) => ({
      ...current,
      date: candidate.date || current.date,
      amount: candidate.amount || current.amount,
      category: candidate.category || current.category,
      expense_subcategory: candidate.expense_subcategory || current.expense_subcategory,
      gl_code: candidate.gl_code || current.gl_code,
      invoice_number: candidate.invoice_number || current.invoice_number,
      vendor: matchedVendor?.name || candidate.vendor || current.vendor,
      vendor_id: matchedVendor?.id || current.vendor_id,
      tenant_name:
        matchedTenant?.tenant_name ||
        matchedTenant?.name ||
        candidate.tenant_name ||
        current.tenant_name,
      tenant_id: matchedTenant?.id || current.tenant_id,
      description:
        candidate.description ||
        (candidate.invoice_number ? `Invoice ${candidate.invoice_number}` : "") ||
        current.description,
      classification: candidate.classification || current.classification,
      portfolio_id: matchedProperty?.portfolio_id || current.portfolio_id,
      property_id: propertyId,
      building_id: buildingId,
      unit_id: matchedUnit?.id || (currentUnitStillMatches ? current.unit_id : ""),
      source: "invoice",
    }));
  };

  const handleInvoiceUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setInvoiceDetailsVisible(false);
    setInvoiceExtractionError("");
    setInvoiceExtractionStatus("Uploading document securely...");
    setExtractedInvoiceName(file.name);
    setPendingInvoiceUpload(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("file_type", "expenses");
      if (orgId && orgId !== "__none__") formData.append("org_id", orgId);
      if (form.property_id) formData.append("property_id", form.property_id);
      if (form.building_id) formData.append("building_id", form.building_id);
      if (form.unit_id) formData.append("unit_id", form.unit_id);

      const upload = await invokeEdgeFunctionFormData(
        "upload-handler",
        formData,
        {},
        { page: "AddExpense", action: "expense_document_upload" }
      );
      if (!upload?.file_id) throw new Error("Document upload completed without a file id.");

      setPendingInvoiceUpload({
        file_id: upload.file_id,
        file_name: upload.file_name || file.name,
        storage_path: upload.storage_path || null,
      });
      setForm((current) => ({ ...current, source_file_id: upload.file_id, source: "invoice" }));

      if (upload.storage_path) {
        const { data: signedData } = await supabase.storage
          .from("financial-uploads")
          .createSignedUrl(upload.storage_path, 60 * 60 * 24 * 7);
        setAttachmentUrl(signedData?.signedUrl || "");
      }

      setInvoiceExtractionStatus("Document uploaded. Proceed with extraction or cancel.");
      toast.success("Document uploaded. Choose Proceed with Extraction to map the fields.");
    } catch (error) {
      console.error("[AddExpense] expense document upload failed:", error);
      const message = error?.message || "Document upload failed.";
      setInvoiceExtractionError(message);
      setInvoiceExtractionStatus("");
      setPendingInvoiceUpload(null);
      toast.error(message);
    } finally {
      setUploading(false);
      if (event.target) event.target.value = "";
    }
  };

  const handleProceedInvoiceExtraction = async () => {
    const fileId = pendingInvoiceUpload?.file_id || form.source_file_id;
    if (!fileId) {
      toast.error("Choose a document before starting extraction.");
      return;
    }

    setUploading(true);
    setInvoiceDetailsVisible(true);
    setInvoiceExtractionError("");
    setInvoiceExtractionStatus("Reading document and mapping expense fields...");

    let confirmError = null;
    try {
      try {
        await invokeEdgeFunction(
          "confirm-upload",
          { file_id: fileId, defer_store: true },
          {},
          { page: "AddExpense", action: "expense_document_confirm_extract" }
        );
      } catch (error) {
        if (!/timeout|timed out|failed to send|network|fetch/i.test(String(error?.message || error))) {
          throw error;
        }
        confirmError = error;
      }

      let extracted;
      try {
        extracted = await waitForInvoiceExtraction(fileId);
      } catch (pollError) {
        throw confirmError || pollError;
      }

      const { rows } = extracted;
      const candidate = buildInvoiceExpenseCandidate(rows[0], categoryOptions.map((category) => category.normalized_key || category.category_name).filter(Boolean), extracted.record);
      applyInvoiceCandidate(candidate);
      setInvoiceExtractionStatus("Document fields extracted. Review them before saving.");
      toast.success("Document extracted and the Add Expense form was prefilled.");
    } catch (error) {
      console.error("[AddExpense] expense document extraction failed:", error);
      const message = error?.message || "Document extraction failed.";
      setInvoiceExtractionError(message);
      setInvoiceExtractionStatus("");
      toast.error(message);
    } finally {
      setUploading(false);
    }
  };

  const handleCancelInvoiceUpload = async () => {
    const fileId = pendingInvoiceUpload?.file_id || form.source_file_id;
    setUploading(true);
    setInvoiceExtractionError("");

    try {
      if (fileId) {
        await invokeEdgeFunction(
          "cancel-upload",
          { file_id: fileId },
          {},
          { page: "AddExpense", action: "expense_document_cancel_upload" }
        );
      }
      setPendingInvoiceUpload(null);
      setInvoiceDetailsVisible(false);
      setInvoiceExtractionStatus("");
      setExtractedInvoiceName("");
      setAttachmentUrl("");
      setForm((current) => ({ ...current, source_file_id: "", source: "manual" }));
      toast.success("Upload cancelled.");
    } catch (error) {
      console.error("[AddExpense] expense document cancel failed:", error);
      const message = error?.message || "Could not cancel upload.";
      setInvoiceExtractionError(message);
      toast.error(message);
    } finally {
      setUploading(false);
    }
  };

  const handleAttachment = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    let fileUrl = "";
    try {
      // Resolve org_id for scoped path so RLS is satisfied
      const resolvedOrg = await resolveWritableOrgId(orgId);
      const orgPrefix = resolvedOrg || "shared";
      const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const fileName = `${orgPrefix}/expenses/${Date.now()}-${safeFileName}`;

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from("financial-uploads")
        .upload(fileName, file, { upsert: true });

      if (uploadError) {
        console.error("[AddExpense] upload error:", uploadError);
        toast.error(`Upload failed: ${uploadError.message}`);
        // Fallback: object URL so the user at least sees a preview
        fileUrl = URL.createObjectURL(file);
      } else if (uploadData) {
        // Bucket is private — use a long-lived signed URL (7 days)
        const { data: signedData, error: signedError } = await supabase.storage
          .from("financial-uploads")
          .createSignedUrl(fileName, 60 * 60 * 24 * 7);
        fileUrl = signedData?.signedUrl || "";
        if (signedError) {
          console.warn("[AddExpense] signed URL error:", signedError.message);
        }
      }
    } catch (err) {
      console.error("[AddExpense] handleAttachment exception:", err);
      fileUrl = URL.createObjectURL(file);
    }
    setAttachmentUrl(fileUrl);
    setUploading(false);
  };

  const handleVendorSelect = (vendorId) => {
    if (vendorId === "__extracted__") return;
    if (vendorId === "__new__") {
      setShowNewVendor(true);
      return;
    }

    const vendor = vendors.find((item) => item.id === vendorId);
    setForm((current) => ({ ...current, vendor: vendor?.name || "", vendor_id: vendorId }));
  };

  const handleTenantSelect = (tenantId) => {
    if (tenantId === "__extracted__") return;
    if (tenantId === "__none__") {
      setForm((current) => ({ ...current, tenant_name: "", tenant_id: "", lease_id: "" }));
      return;
    }
    const tenant = tenants.find((item) => item.id === tenantId);
    setForm((current) => ({
      ...current,
      tenant_name: tenant?.tenant_name || tenant?.name || "",
      tenant_id: tenantId,
      lease_id: "",
    }));
  };

  const handleCreateVendor = async () => {
    if (!newVendorForm.name) return;
    const writableOrgId = await resolveWritableOrgId(orgId);
    createVendorMutation.mutate({
      name: newVendorForm.name,
      company: newVendorForm.company || null,
      email: newVendorForm.contact_email || null,
      category: newVendorForm.category,
      payment_terms: newVendorForm.payment_terms,
      org_id: writableOrgId || "",
      status: "active",
    });
  };

  const isValid = form.date && form.amount && form.expense_category_id && form.category && form.vendor && form.property_id;
  const showExpenseEntryForm = isEditing || !isInvoiceMode || invoiceDetailsVisible;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <Link to={expensesUrl} className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" />
        Back to Expenses
      </Link>
      <h1 className="text-[28px] font-bold text-slate-900">
        {isEditing ? "Edit Expense" : isInvoiceMode ? "Add Expense from Invoice" : "Add Expense"}
      </h1>

      {isInvoiceMode && (
        <Card className="border-blue-200 bg-blue-50/50">
          <CardContent className="p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-semibold text-slate-900 flex items-center gap-2">
                  <FileUp className="w-5 h-5 text-blue-600" />
                  Upload vendor invoice or expense document
                </p>
                <p className="text-sm text-slate-600 mt-1">
                  Upload the source document first. Extraction starts only after you choose Proceed with Extraction, and nothing is saved until you review and submit.
                </p>
                <p className="text-xs text-slate-500 mt-2">{DOCUMENT_UPLOAD_HELP_TEXT}</p>
              </div>
              {!pendingInvoiceUpload && (
                <Button type="button" onClick={() => invoiceFileInputRef.current?.click()} disabled={uploading}>
                  {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <FileUp className="w-4 h-4 mr-2" />}
                  {uploading ? "Uploading..." : "Choose Document"}
                </Button>
              )}
              <input
                ref={invoiceFileInputRef}
                type="file"
                className="hidden"
                accept={DOCUMENT_UPLOAD_ACCEPT}
                onChange={handleInvoiceUpload}
              />
            </div>

            {pendingInvoiceUpload && !invoiceDetailsVisible && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-200 bg-white p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900">{pendingInvoiceUpload.file_name || extractedInvoiceName}</p>
                  <p className="text-xs text-slate-500">Ready for extraction. Review starts after you proceed.</p>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={handleCancelInvoiceUpload} disabled={uploading}>
                    Cancel
                  </Button>
                  <Button type="button" onClick={handleProceedInvoiceExtraction} disabled={uploading}>
                    {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <FileUp className="w-4 h-4 mr-2" />}
                    Proceed with Extraction
                  </Button>
                </div>
              </div>
            )}

            {invoiceExtractionStatus && (
              <div className="flex items-center gap-2 text-sm text-emerald-700">
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                <span>{invoiceExtractionStatus}{extractedInvoiceName ? ` (${extractedInvoiceName})` : ""}</span>
              </div>
            )}
            {invoiceExtractionError && (
              <div className="flex items-center gap-2 text-sm text-red-700">
                <AlertCircle className="w-4 h-4" />
                <span>{invoiceExtractionError}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {showExpenseEntryForm && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Expense Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Date *</Label>
              <Input type="date" required value={form.date} onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))} />
            </div>
            <div>
              <Label>Amount ($) *</Label>
              <Input type="number" step="0.01" required placeholder="0.00" value={form.amount} onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Category *</Label>
              <Select value={form.expense_category_id} onValueChange={handleCategorySelect}>
                <SelectTrigger>
                  <SelectValue placeholder="Select category..." />
                </SelectTrigger>
                <SelectContent>
                  {categoryOptions.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {[category.category_name, category.subcategory_name].filter(Boolean).join(" / ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Property *</Label>
              <Select
                value={form.property_id}
                onValueChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    property_id: value,
                    portfolio_id: scope.propertyById.get(value)?.portfolio_id || current.portfolio_id || "",
                    building_id: "",
                    unit_id: "",
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select property..." />
                </SelectTrigger>
                <SelectContent>
                  {visibleProperties.map((property) => (
                    <SelectItem key={property.id} value={property.id}>
                      {property.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Subcategory</Label>
              <Input value={selectedCategory?.subcategory_name || form.expense_subcategory} readOnly placeholder="Selected category subcategory" />
            </div>
            <div>
              <Label>GL Code</Label>
              <Input value={form.gl_code} onChange={(event) => setForm((current) => ({ ...current, gl_code: event.target.value }))} placeholder="Optional GL code..." />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Invoice Number</Label>
              <Input value={form.invoice_number} onChange={(event) => setForm((current) => ({ ...current, invoice_number: event.target.value }))} placeholder="Optional invoice #..." />
            </div>
            <div>
              <Label>Building</Label>
              <Select value={form.building_id || "__all__"} onValueChange={(value) => setForm((current) => ({ ...current, building_id: value === "__all__" ? "" : value, unit_id: "" }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Select building..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Property-Level Expense</SelectItem>
                  {visibleBuildings.map((building) => (
                    <SelectItem key={building.id} value={building.id}>
                      {building.name || building.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Unit</Label>
              <Select value={form.unit_id || "__all__"} onValueChange={(value) => setForm((current) => ({ ...current, unit_id: value === "__all__" ? "" : value }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Select unit..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Building-Level Expense</SelectItem>
                  {visibleUnits.map((unit) => (
                    <SelectItem key={unit.id} value={unit.id}>
                      {unit.unit_number || unit.unit_id_code || unit.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Vendor *</Label>
              <Select value={form.vendor_id || (form.vendor ? "__extracted__" : "")} onValueChange={handleVendorSelect}>
                <SelectTrigger className={!form.vendor_id ? "border-amber-300" : ""}>
                  <SelectValue placeholder="Select vendor (required)..." />
                </SelectTrigger>
                <SelectContent>
                  {form.vendor && !form.vendor_id && (
                    <SelectItem value="__extracted__">{form.vendor} (from invoice)</SelectItem>
                  )}
                  {vendors.map((vendor) => (
                    <SelectItem key={vendor.id} value={vendor.id}>
                      <span className="flex items-center gap-2">
                        {vendor.name}
                        {vendor.company ? <span className="text-slate-400 text-xs">({vendor.company})</span> : ""}
                      </span>
                    </SelectItem>
                  ))}
                  <SelectItem value="__new__">
                    <span className="flex items-center gap-1 text-violet-600 font-medium">
                      <Plus className="w-3 h-3" />
                      Create New Vendor
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
              {form.vendor && form.vendor_id && (
                <Link to={`/VendorProfile?id=${form.vendor_id}`} className="text-[10px] text-blue-600 hover:underline mt-1 inline-block">
                  View {form.vendor} profile →
                </Link>
              )}
            </div>
            <div>
              <Label>Tenant</Label>
              <Select
                value={form.tenant_id || (form.tenant_name ? "__extracted__" : "__none__")}
                onValueChange={handleTenantSelect}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select tenant..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No tenant / property expense</SelectItem>
                  {form.tenant_name && !form.tenant_id && (
                    <SelectItem value="__extracted__">{form.tenant_name} (from invoice)</SelectItem>
                  )}
                  {tenants.map((tenant) => (
                    <SelectItem key={tenant.id} value={tenant.id}>
                      {tenant.tenant_name || tenant.name || tenant.company || tenant.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Description</Label>
            <Textarea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="Optional notes..." rows={3} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recoverable Classification</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            {[
              { value: "recoverable", label: "Recoverable", description: "Charged to tenants via CAM" },
              { value: "non_recoverable", label: "Non-Recoverable", description: "Owner/landlord responsibility" },
              { value: "conditional", label: "Conditional", description: "Depends on lease terms" },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setForm((current) => ({ ...current, classification: option.value }))}
                className={`p-4 rounded-xl border-2 text-left transition-all ${form.classification === option.value ? "border-blue-600 bg-blue-50" : "border-slate-200 hover:border-slate-300"}`}
              >
                <p className="text-sm font-semibold text-slate-900">{option.label}</p>
                <p className="text-xs text-slate-500 mt-1">{option.description}</p>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Attachment (Optional)</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-3 cursor-pointer p-3 border border-dashed rounded-lg hover:bg-slate-50">
            <Paperclip className="w-5 h-5 text-slate-400" />
            <div>
              <p className="text-sm font-medium text-blue-600">{attachmentUrl ? "File attached" : "Attach Receipt or Invoice"}</p>
              <p className="text-xs text-slate-400">{DOCUMENT_UPLOAD_HELP_TEXT}</p>
            </div>
            {uploading && <Loader2 className="w-4 h-4 animate-spin ml-auto" />}
            <input type="file" className="hidden" accept={DOCUMENT_UPLOAD_ACCEPT} onChange={handleAttachment} />
          </label>
        </CardContent>
      </Card>

      <div className="flex gap-3 justify-end">
        <Link to={expensesUrl}>
          <Button variant="outline" type="button">
            Cancel
          </Button>
        </Link>
        <Button variant="outline" onClick={() => handleSubmit(true)} disabled={isEditing || !isValid || createMutation.isPending}>
          <Plus className="w-4 h-4 mr-1" />
          Save & Add Another
        </Button>
        {!isEditing && (
          <Button
            variant="outline"
            onClick={() => handleSubmit(false, { saveAsDraft: true })}
            disabled={!isValid || createMutation.isPending}
            title="Save without approving — the expense stays out of classification until a reviewer promotes it."
          >
            Save as Draft
          </Button>
        )}
        <Button onClick={() => handleSubmit(false)} disabled={!isValid || createMutation.isPending || updateMutation.isPending} className="bg-emerald-600 hover:bg-emerald-700">
          {(createMutation.isPending || updateMutation.isPending) && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
          {isEditing ? "Save Changes" : "Save & Approve"}
        </Button>
      </div>
        </>
      )}

      <Dialog open={showNewVendor} onOpenChange={setShowNewVendor}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Vendor</DialogTitle>
            <DialogDescription>Add a new vendor to link to this expense</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Vendor Name *</Label>
                <Input value={newVendorForm.name} onChange={(event) => setNewVendorForm((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. ABC Maintenance" />
              </div>
              <div>
                <Label className="text-xs">Company</Label>
                <Input value={newVendorForm.company} onChange={(event) => setNewVendorForm((current) => ({ ...current, company: event.target.value }))} />
              </div>
            </div>
            <div>
              <Label className="text-xs">Email</Label>
              <Input value={newVendorForm.contact_email} onChange={(event) => setNewVendorForm((current) => ({ ...current, contact_email: event.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Category</Label>
                <Select value={newVendorForm.category} onValueChange={(value) => setNewVendorForm((current) => ({ ...current, category: value }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VENDOR_CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>
                        {category.charAt(0).toUpperCase() + category.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Payment Terms</Label>
                <Select value={newVendorForm.payment_terms} onValueChange={(value) => setNewVendorForm((current) => ({ ...current, payment_terms: value }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["net_15", "net_30", "net_45", "net_60", "immediate"].map((term) => (
                      <SelectItem key={term} value={term}>
                        {term.replace(/_/g, " ").toUpperCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewVendor(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateVendor} disabled={!newVendorForm.name || createVendorMutation.isPending} className="bg-violet-600 hover:bg-violet-700">
              {createVendorMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              Create Vendor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
