import React, { useEffect, useMemo, useState } from "react";
import { expenseService } from "@/services/expenseService";
import { useQueryClient } from "@tanstack/react-query";
import useOrgId from "@/hooks/useOrgId";
import useOrgQuery from "@/hooks/useOrgQuery";
import { supabase } from "@/services/supabaseClient";
import { parseCSV } from "@/services/parsingEngine";
import ScopeSelector from "@/components/ScopeSelector";
import { buildHierarchyScope } from "@/lib/hierarchyScope";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, Upload, Download, CheckCircle2, Loader2 } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";

const systemFields = ["expense_date", "category", "amount", "vendor", "recoverable_flag", "description"];

async function resolveWritableOrgId(currentOrgId) {
  if (currentOrgId && currentOrgId !== "__none__") return currentOrgId;

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.app_metadata?.org_id) return user.app_metadata.org_id;

    const { data: membership } = await supabase
      .from("memberships")
      .select("org_id")
      .eq("user_id", user?.id)
      .limit(1)
      .maybeSingle();

    if (membership?.org_id) return membership.org_id;

    const { data: org } = await supabase
      .from("organizations")
      .select("id")
      .limit(1)
      .maybeSingle();

    return org?.id || null;
  } catch {
    return null;
  }
}

export default function BulkImport() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { orgId } = useOrgId();
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [fileUrl, setFileUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [extractedRows, setExtractedRows] = useState([]);
  const [columnMap, setColumnMap] = useState({});
  const [validatedRows, setValidatedRows] = useState([]);
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");

  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");

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

  useEffect(() => {
    setScopeProperty(scope.propertyId || "all");
    setScopeBuilding(scope.buildingId || "all");
    setScopeUnit(scope.unitId || "all");
  }, [scope.propertyId, scope.buildingId, scope.unitId]);

  const scopedBuildings = useMemo(
    () => (scopeProperty !== "all" ? buildings.filter((building) => building.property_id === scopeProperty) : buildings),
    [buildings, scopeProperty]
  );

  const scopedUnits = useMemo(() => {
    if (scopeBuilding !== "all") {
      const buildingUnits = units.filter((unit) => unit.building_id === scopeBuilding);
      if (buildingUnits.length > 0) return buildingUnits;

      const selectedScopeBuilding = buildings.find((building) => building.id === scopeBuilding);
      const fallbackPropertyId = selectedScopeBuilding?.property_id || (scopeProperty !== "all" ? scopeProperty : null);
      return fallbackPropertyId ? units.filter((unit) => unit.property_id === fallbackPropertyId) : [];
    }
    if (scopeProperty !== "all") {
      return units.filter((unit) => unit.property_id === scopeProperty);
    }
    return units;
  }, [units, scopeBuilding, scopeProperty, buildings]);

  const selectedProperty = scopeProperty !== "all" ? properties.find((property) => property.id === scopeProperty) ?? null : null;
  const selectedBuilding = scopeBuilding !== "all" ? buildings.find((building) => building.id === scopeBuilding) ?? null : null;
  const selectedUnit = scopeUnit !== "all" ? units.find((unit) => unit.id === scopeUnit) ?? null : null;
  const effectiveProperty = selectedUnit?.property_id ? properties.find((property) => property.id === selectedUnit.property_id) ?? null : selectedBuilding?.property_id ? properties.find((property) => property.id === selectedBuilding.property_id) ?? null : selectedProperty;
  const effectiveBuilding = selectedUnit?.building_id ? buildings.find((building) => building.id === selectedUnit.building_id) ?? null : selectedBuilding;
  const effectivePortfolio =
    scope.activePortfolio ||
    (effectiveProperty?.portfolio_id ? portfolios.find((portfolio) => portfolio.id === effectiveProperty.portfolio_id) ?? null : null);

  const updateScopeParams = ({ property = scopeProperty, building = scopeBuilding, unit = scopeUnit }) => {
    const params = new URLSearchParams(location.search);
    if (property && property !== "all") params.set("property", property);
    else params.delete("property");

    if (building && building !== "all") params.set("building", building);
    else params.delete("building");

    if (unit && unit !== "all") params.set("unit", unit);
    else params.delete("unit");

    navigate({
      pathname: location.pathname,
      search: params.toString() ? `?${params.toString()}` : "",
    });
  };

  const handlePropertyChange = (value) => {
    setScopeProperty(value);
    setScopeBuilding("all");
    setScopeUnit("all");
    updateScopeParams({ property: value, building: "all", unit: "all" });
  };

  const handleBuildingChange = (value) => {
    setScopeBuilding(value);
    setScopeUnit("all");
    updateScopeParams({ property: scopeProperty, building: value, unit: "all" });
  };

  const handleUnitChange = (value) => {
    setScopeUnit(value);
    updateScopeParams({ property: scopeProperty, building: scopeBuilding, unit: value });
  };

  const handleFileUpload = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setFile(f);
    setUploading(true);

    // Upload to Supabase Storage
    let uploadedUrl = "";
    try {
      const fileName = `bulk-imports/${Date.now()}-${f.name}`;
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('financial-uploads')
        .upload(fileName, f, { upsert: true });
      if (!uploadError && uploadData) {
        const { data: urlData } = supabase.storage.from('financial-uploads').getPublicUrl(fileName);
        uploadedUrl = urlData?.publicUrl || "";
      } else {
        // Storage bucket missing or unavailable — use local blob URL
        uploadedUrl = URL.createObjectURL(f);
      }
    } catch {
      // fallback to local blob URL for dev
      uploadedUrl = URL.createObjectURL(f);
    }
    setFileUrl(uploadedUrl);

    // Parse CSV/Excel client-side
    try {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      let csvText = "";

      if (ext === "xlsx" || ext === "xls") {
        const { read, utils } = await import("xlsx");
        const buf = await f.arrayBuffer();
        const workbook = read(buf, { type: "array" });
        const firstSheet = workbook.SheetNames[0];
        if (!firstSheet) {
          throw new Error("Excel file contains no worksheets.");
        }
        csvText = utils.sheet_to_csv(workbook.Sheets[firstSheet], { blankrows: false });
      } else {
        csvText = await f.text();
      }

      const { headers, rows } = parseCSV(csvText);
      if (headers.length > 0) {
        const autoMap = {};
        headers.forEach(c => {
          const lower = c.toLowerCase();
          if (lower.includes('date')) autoMap[c] = 'expense_date';
          else if (lower.includes('category') || lower.includes('type')) autoMap[c] = 'category';
          else if (lower.includes('amount') || lower.includes('cost') || lower.includes('total')) autoMap[c] = 'amount';
          else if (lower.includes('vendor') || lower.includes('supplier') || lower.includes('payee')) autoMap[c] = 'vendor';
          else if (lower.includes('recover') || lower.includes('class')) autoMap[c] = 'recoverable_flag';
          else if (lower.includes('desc') || lower.includes('note') || lower.includes('memo')) autoMap[c] = 'description';
        });
        setColumnMap(autoMap);
        setExtractedRows(rows);
      } else {
        throw new Error("No tabular rows found in the uploaded file.");
      }
    } catch (err) {
      console.error('[BulkImport] CSV parse error:', err);
      setExtractedRows([]);
      setColumnMap({});
    }

    setUploading(false);
    setStep(2);
  };

  const runValidation = () => {
    const validated = extractedRows.map((row, i) => {
      const warnings = [];
      const errors = [];
      const mappedRow = {};
      Object.entries(columnMap).forEach(([col, field]) => { mappedRow[field] = row[col]; });

      if (!mappedRow.amount || isNaN(parseFloat(String(mappedRow.amount).replace(/[$,]/g, '')))) errors.push("Amount field is empty — required field");
      if (!mappedRow.category) errors.push("Category is empty");
      if (mappedRow.expense_date && !/^\d{4}-\d{2}-\d{2}$/.test(mappedRow.expense_date)) warnings.push("Date format mismatch — expected YYYY-MM-DD");
      if (mappedRow.recoverable_flag?.toLowerCase() === 'conditional') warnings.push("Conditional recoverable — will require lease validation check on import");

      return { ...mappedRow, row_num: i + 1, warnings, errors, status: errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'ready', original: row };
    });
    setValidatedRows(validated);
    setStep(3);
  };

  const importData = async () => {
    const writableOrgId = await resolveWritableOrgId(orgId);
    const effectivePropertyId = selectedUnit?.property_id || selectedBuilding?.property_id || (scopeProperty !== "all" ? scopeProperty : null);
    const effectiveBuildingId = selectedUnit?.building_id || (scopeBuilding !== "all" ? scopeBuilding : null);
    const effectiveUnitId = scopeUnit !== "all" ? scopeUnit : null;
    const effectivePortfolioId =
      effectivePortfolio?.id ||
      (effectivePropertyId
        ? properties.find((property) => property.id === effectivePropertyId)?.portfolio_id || null
        : null);
    const ready = validatedRows.filter(r => r.status !== 'error');
    for (const row of ready) {
      await expenseService.create({
        date: row.expense_date,
        category: row.category?.toLowerCase().replace(/\s+/g, '_') || "other",
        amount: parseFloat(String(row.amount).replace(/[$,]/g, '')) || 0,
        vendor: row.vendor || "",
        description: row.description || "",
        classification: row.recoverable_flag?.toLowerCase().includes('non') ? 'non_recoverable' : row.recoverable_flag?.toLowerCase().includes('cond') ? 'conditional' : 'recoverable',
        source: "import",
        ...(effectivePortfolioId ? { portfolio_id: effectivePortfolioId } : {}),
        ...(effectivePropertyId ? { property_id: effectivePropertyId } : {}),
        ...(effectiveBuildingId ? { building_id: effectiveBuildingId } : {}),
        ...(effectiveUnitId ? { unit_id: effectiveUnitId } : {}),
        ...(writableOrgId ? { org_id: writableOrgId } : {}),
        fiscal_year: new Date().getFullYear()
      });
    }
    queryClient.invalidateQueries({ queryKey: ['Expense'] });
    setStep(4);
  };

  const readyCount = validatedRows.filter(r => r.status === 'ready').length;
  const warningCount = validatedRows.filter(r => r.status === 'warning').length;
  const errorCount = validatedRows.filter(r => r.status === 'error').length;

  const downloadTemplate = () => {
    const csv = "Date,Category,Amount,Vendor,Recoverable,Description\n2025-04-01,HVAC Maintenance,$12400,Arizona Air Systems,Recoverable,Monthly service";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "expense_template.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const stepLabels = ["Upload File", "Map Columns", "Validate", "Complete"];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <Link to={createPageUrl("Expenses") + location.search} className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Back to Expenses</Link>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Bulk Expense Import</h1>
          <p className="text-sm text-slate-500">Import CSV or Excel</p>
        </div>
        <Button variant="outline" onClick={downloadTemplate}><Download className="w-4 h-4 mr-2" />Download Template</Button>
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Expense Scope</h2>
            <p className="text-xs text-slate-500">Imported expenses will be saved against this hierarchy.</p>
          </div>
          <ScopeSelector
            properties={scope.scopedProperties}
            buildings={scopedBuildings}
            units={scopedUnits}
            selectedProperty={scopeProperty}
            selectedBuilding={scopeBuilding}
            selectedUnit={scopeUnit}
            onPropertyChange={handlePropertyChange}
            onBuildingChange={handleBuildingChange}
            onUnitChange={handleUnitChange}
          />
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">Portfolio: {effectivePortfolio?.name || "Org-level only"}</Badge>
            <Badge variant="outline">Property: {effectiveProperty?.name || "All properties"}</Badge>
            <Badge variant="outline">Building: {effectiveBuilding?.name || "All buildings"}</Badge>
            <Badge variant="outline">Unit: {selectedUnit?.unit_number || selectedUnit?.unit_id_code || "All units"}</Badge>
          </div>
        </CardContent>
      </Card>

      {/* Steps */}
      <div className="flex items-center gap-2">
        {stepLabels.map((s, i) => (
          <React.Fragment key={i}>
            <div className="flex items-center gap-2">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${step > i + 1 ? 'bg-emerald-500 text-white' : step === i + 1 ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-500'}`}>
                {step > i + 1 ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
              </div>
              <span className={`text-sm ${step >= i + 1 ? 'text-slate-900 font-medium' : 'text-slate-400'}`}>{s}</span>
            </div>
            {i < 3 && <div className={`flex-1 h-0.5 ${step > i + 1 ? 'bg-emerald-500' : 'bg-slate-200'}`} />}
          </React.Fragment>
        ))}
      </div>

      {/* Step 1: Upload */}
      {step === 1 && (
        <Card>
          <CardContent className="p-12 text-center">
            <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><Upload className="w-8 h-8 text-slate-400" /></div>
            <h2 className="text-lg font-bold text-slate-900 mb-2">Upload Expense File</h2>
            <p className="text-sm text-slate-500 mb-6">
              Drag and drop your CSV or Excel file, or click to browse.
              <br />
              Imported rows will use the selected expense scope shown above.
            </p>
            <label>
              <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleFileUpload} />
              <Button asChild className="bg-[#1a2744] hover:bg-[#243b67] cursor-pointer"><span>{uploading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}Browse Files</span></Button>
            </label>
            <p className="text-xs text-slate-400 mt-3">Supported: CSV, XLSX</p>
          </CardContent>
        </Card>
      )}

      {/* Step 2: Map Columns */}
      {step === 2 && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Column Mapping</h2>
              <p className="text-sm text-slate-500">Map columns from your file to the system fields. Auto-detected matches are pre-filled.</p>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[11px]">YOUR FILE COLUMN</TableHead>
                  <TableHead className="text-[11px]">MAPS TO</TableHead>
                  <TableHead className="text-[11px]">SAMPLE VALUE</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.keys(extractedRows[0] || {}).map(col => (
                  <TableRow key={col}>
                    <TableCell className="text-sm text-blue-600 font-medium">{col}</TableCell>
                    <TableCell>
                      <Select value={columnMap[col] || ""} onValueChange={v => setColumnMap({...columnMap, [col]: v})}>
                        <SelectTrigger className="w-44 h-8 text-xs"><SelectValue placeholder="Select..." /></SelectTrigger>
                        <SelectContent>
                          {systemFields.map(f => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-sm text-slate-400">{String(extractedRows[0]?.[col] || "")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
              <Button className="bg-blue-600 hover:bg-blue-700" onClick={runValidation}>Run Validation</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Validate */}
      {step === 3 && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs">
            <Badge variant="outline">Applied Portfolio: {effectivePortfolio?.name || "Org-level only"}</Badge>
            <Badge variant="outline">Applied Property: {effectiveProperty?.name || "All properties"}</Badge>
            <Badge variant="outline">Applied Building: {effectiveBuilding?.name || "All buildings"}</Badge>
            <Badge variant="outline">Applied Unit: {selectedUnit?.unit_number || selectedUnit?.unit_id_code || "All units"}</Badge>
          </div>

          <div className="grid grid-cols-4 gap-4">
            <Card className="bg-slate-50"><CardContent className="p-4"><p className="text-[10px] font-semibold text-slate-500 uppercase">Total Rows</p><p className="text-2xl font-bold">{validatedRows.length}</p></CardContent></Card>
            <Card className="bg-emerald-50"><CardContent className="p-4"><p className="text-[10px] font-semibold text-emerald-600 uppercase">Ready to Import</p><p className="text-2xl font-bold text-emerald-700">{readyCount}</p></CardContent></Card>
            <Card className="bg-amber-50"><CardContent className="p-4"><p className="text-[10px] font-semibold text-amber-600 uppercase">Warnings (importable)</p><p className="text-2xl font-bold text-amber-700">{warningCount}</p></CardContent></Card>
            <Card className="bg-red-50"><CardContent className="p-4"><p className="text-[10px] font-semibold text-red-600 uppercase">Errors (blocked)</p><p className="text-2xl font-bold text-red-700">{errorCount}</p></CardContent></Card>
          </div>

          <Card>
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="text-[11px]">ROW</TableHead>
                  <TableHead className="text-[11px]">DATE</TableHead>
                  <TableHead className="text-[11px]">CATEGORY</TableHead>
                  <TableHead className="text-[11px]">AMOUNT</TableHead>
                  <TableHead className="text-[11px]">VENDOR</TableHead>
                  <TableHead className="text-[11px]">RECOVERABLE</TableHead>
                  <TableHead className="text-[11px]">STATUS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {validatedRows.map(r => (
                  <React.Fragment key={r.row_num}>
                    <TableRow className={r.status === 'error' ? 'bg-red-50/50' : r.status === 'warning' ? 'bg-amber-50/50' : ''}>
                      <TableCell className="text-sm">{r.row_num}</TableCell>
                      <TableCell className="text-sm">{r.expense_date || '—'}</TableCell>
                      <TableCell className="text-sm font-medium">{r.category}</TableCell>
                      <TableCell className="text-sm font-mono">{r.amount}</TableCell>
                      <TableCell className="text-sm">{r.vendor}</TableCell>
                      <TableCell><Badge className={r.recoverable_flag?.toLowerCase().includes('non') ? 'bg-red-100 text-red-700 text-[10px]' : r.recoverable_flag?.toLowerCase().includes('cond') ? 'bg-amber-100 text-amber-700 text-[10px]' : 'bg-emerald-100 text-emerald-700 text-[10px]'}>{r.recoverable_flag || 'Recoverable'}</Badge></TableCell>
                      <TableCell><Badge className={r.status === 'error' ? 'bg-red-100 text-red-600' : r.status === 'warning' ? 'bg-amber-100 text-amber-600' : 'bg-emerald-100 text-emerald-700'} >{r.status === 'ready' ? '✓ Ready' : r.status === 'warning' ? '⚠ Warning' : '✕ Error'}</Badge></TableCell>
                    </TableRow>
                    {(r.warnings.length > 0 || r.errors.length > 0) && (
                      <TableRow>
                        <TableCell colSpan={7} className="py-1 px-8">
                          {r.warnings.map((w, i) => <p key={i} className="text-xs text-amber-600">⚠ {w}</p>)}
                          {r.errors.map((w, i) => <p key={i} className="text-xs text-red-600">✕ {w}</p>)}
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                ))}
              </TableBody>
            </Table>
          </Card>

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(2)}>Back</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={importData} disabled={readyCount + warningCount === 0}>
              Import {readyCount + warningCount} Rows
            </Button>
          </div>
        </div>
      )}

      {/* Step 4: Complete */}
      {step === 4 && (
        <Card>
          <CardContent className="p-12 text-center">
            <CheckCircle2 className="w-16 h-16 text-emerald-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-slate-900 mb-2">Import Complete!</h2>
            <p className="text-sm text-slate-500 mb-6">{readyCount + warningCount} expenses imported successfully.</p>
            <Link to={createPageUrl("Expenses") + location.search}><Button className="bg-blue-600 hover:bg-blue-700">View Expenses</Button></Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
