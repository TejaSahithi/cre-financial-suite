/**
 * This script patches all remaining pages that use createEntityService('XYZ')
 * to instead import the centralized PascalCase service exports from @/services/api.
 *
 * It reads each file, removes the createEntityService import/calls,
 * adds the proper import, and updates all variable references.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const PAGES_DIR = join(import.meta.dirname, '..', 'src', 'pages');

// Map: camelCase local variable name -> PascalCase export from api.js
const SERVICE_MAP = {
  cAMCalculationService: 'CAMCalculationService',
  unitService: 'UnitService',
  buildingService: 'BuildingService',
  invoiceService: 'InvoiceService',
  reconciliationService: 'ReconciliationService',
  stakeholderService: 'StakeholderService',
  accessRequestService: 'AccessRequestService',
  auditLogService: 'AuditLogService',
  gLAccountService: 'GLAccountService',
  userService: 'UserService',
  propertyService: 'PropertyService',
  leaseService: 'LeaseService',
  expenseService: 'ExpenseService',
  budgetService: 'BudgetService',
  vendorService: 'VendorService',
  documentService: 'DocumentService',
  tenantService: 'TenantService',
  notificationService: 'NotificationService',
  organizationService: 'OrganizationService',
  portfolioService: 'PortfolioService',
};

// Also map PascalCase services imported from individual service files
const INDIVIDUAL_SERVICE_MAP = {
  'propertyService': { file: '@/services/propertyService', export: 'PropertyService' },
  'leaseService': { file: '@/services/leaseService', export: 'LeaseService' },
  'expenseService': { file: '@/services/expenseService', export: 'ExpenseService' },
  'budgetService': { file: '@/services/budgetService', export: 'BudgetService' },
  'documentService': { file: '@/services/documentService', export: 'DocumentService' },
  'tenantService': { file: '@/services/tenantService', export: 'TenantService' },
  'vendorService': { file: '@/services/vendorService', export: 'VendorService' },
  'notificationService': { file: '@/services/notificationService', export: 'NotificationService' },
  'organizationService': { file: '@/services/organizationService', export: 'OrganizationService' },
};

const files = [
  'Workflows.jsx',
  'TenantDetail.jsx',
  'Stakeholders.jsx',
  'RequestAccess.jsx',
  'Reconciliation.jsx',
  'PortfolioInsights.jsx',
  'PendingApproval.jsx',
  'OrgSettings.jsx',
  'CreateBudget.jsx',
  'Comparison.jsx',
  'ChartOfAccounts.jsx',
  'CAMCalculation.jsx',
  'BuildingsUnits.jsx',
  'Billing.jsx',
  'AnalyticsReports.jsx',
  'AuditLog.jsx',
  'Analytics.jsx',
];

for (const file of files) {
  const filePath = join(PAGES_DIR, file);
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    console.log(`SKIP: ${file} not found`);
    continue;
  }

  const neededServices = new Set();

  // Find all createEntityService('XYZ') calls and determine the needed PascalCase imports
  const createPattern = /const\s+(\w+)\s*=\s*createEntityService\(['"](\w+)['"]\);?\n?/g;
  let match;
  while ((match = createPattern.exec(content)) !== null) {
    const localVar = match[1];
    const pascalExport = SERVICE_MAP[localVar];
    if (pascalExport) {
      neededServices.add(pascalExport);
    }
  }

  // Also check for individual service file imports
  for (const [localVar, info] of Object.entries(INDIVIDUAL_SERVICE_MAP)) {
    const importPattern = new RegExp(`import\\s*\\{\\s*${localVar}\\s*\\}\\s*from\\s*["']${info.file.replace('/', '\\/')}["'];?\\n?`, 'g');
    if (importPattern.test(content)) {
      neededServices.add(info.export);
    }
  }

  if (neededServices.size === 0 && !content.includes('createEntityService')) {
    console.log(`SKIP: ${file} — no changes needed`);
    continue;
  }

  // Remove createEntityService import line
  content = content.replace(/import\s*\{\s*createEntityService\s*\}\s*from\s*["']@\/services\/api["'];?\n?/g, '');

  // Remove const xxxService = createEntityService('Xxx'); lines
  content = content.replace(/const\s+\w+\s*=\s*createEntityService\(['"]\w+['"]\);?\n?/g, '');

  // Remove individual service file imports
  for (const [localVar, info] of Object.entries(INDIVIDUAL_SERVICE_MAP)) {
    const pat = new RegExp(`import\\s*\\{\\s*${localVar}\\s*\\}\\s*from\\s*["']${info.file.replace('/', '\\/')}["'];?\\n?`, 'g');
    content = content.replace(pat, '');
  }

  // Replace variable references in function bodies
  for (const [localVar, pascalExport] of Object.entries(SERVICE_MAP)) {
    // Only replace word-boundary matches to avoid partial replacements
    const refPattern = new RegExp(`\\b${localVar}\\b`, 'g');
    content = content.replace(refPattern, pascalExport);
  }
  for (const [localVar, info] of Object.entries(INDIVIDUAL_SERVICE_MAP)) {
    const refPattern = new RegExp(`\\b${localVar}\\b`, 'g');
    content = content.replace(refPattern, info.export);
  }

  // Check if there's already an import from @/services/api
  const existingApiImportMatch = content.match(/import\s*\{([^}]+)\}\s*from\s*["']@\/services\/api["'];?\n?/);
  
  if (existingApiImportMatch) {
    // Merge new services into existing import
    const existingImports = existingApiImportMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    const allImports = new Set([...existingImports, ...neededServices]);
    const newImportLine = `import { ${[...allImports].join(', ')} } from "@/services/api";\n`;
    content = content.replace(/import\s*\{[^}]+\}\s*from\s*["']@\/services\/api["'];?\n?/, newImportLine);
  } else if (neededServices.size > 0) {
    // Add new import after the first import line
    const firstImport = content.match(/^import\s.+;\n/m);
    if (firstImport) {
      const importLine = `import { ${[...neededServices].join(', ')} } from "@/services/api";\n`;
      content = content.replace(firstImport[0], firstImport[0] + importLine);
    }
  }

  // Clean up any blank lines that got doubled
  content = content.replace(/\n{3,}/g, '\n\n');

  writeFileSync(filePath, content, 'utf-8');
  console.log(`FIXED: ${file} — added imports: ${[...neededServices].join(', ')}`);
}

console.log('\nDone! All pages updated.');
