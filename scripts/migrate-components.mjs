
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const basePath = join(import.meta.dirname, '..', 'src');

const files = [
  'components/property/PropertyCAMTab.jsx',
  'components/landing/RequestAccessModal.jsx',
  'components/dashboard/ActivityFeed.jsx',
  'components/dashboard/RecentActivity.jsx',
  'components/AuditTrailPanel.jsx'
];

const SERVICE_MAP = {
  cAMCalculationService: 'CAMCalculationService',
  accessRequestService: 'AccessRequestService',
  auditLogService: 'AuditLogService'
};

for (const file of files) {
  const filePath = join(basePath, file);
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch(e) {
    console.log('SKIP:', file);
    continue;
  }

  const neededServices = new Set();
  const createPattern = /const\s+(\w+)\s*=\s*createEntityService\(['"](\w+)['"]\);?\n?/g;
  let match;
  while ((match = createPattern.exec(content)) !== null) {
    const localVar = match[1];
    if (SERVICE_MAP[localVar]) {
      neededServices.add(SERVICE_MAP[localVar]);
    }
  }

  content = content.replace(/import\s*\{\s*createEntityService\s*\}\s*from\s*["']@\/services\/api["'];?\n?/g, '');
  content = content.replace(/const\s+\w+\s*=\s*createEntityService\(['"]\w+['"]\);?\n?/g, '');

  for (const [localVar, pascalExport] of Object.entries(SERVICE_MAP)) {
    const refPattern = new RegExp('\\b' + localVar + '\\b', 'g');
    content = content.replace(refPattern, pascalExport);
  }

  const existingApiImportMatch = content.match(/import\s*\{([^}]+)\}\s*from\s*["']@\/services\/api["'];?\n?/);
  if (existingApiImportMatch) {
    const existingImports = existingApiImportMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    const allImports = new Set([...existingImports, ...neededServices]);
    const newImportLine = 'import { ' + [...allImports].join(', ') + ' } from "@/services/api";\n';
    content = content.replace(/import\s*\{[^}]+\}\s*from\s*["']@\/services\/api["'];?\n?/, newImportLine);
  } else if (neededServices.size > 0) {
    const importLine = 'import { ' + [...neededServices].join(', ') + ' } from "@/services/api";\n';
    const firstImport = content.match(/^import\s.+;\n/m);
    if (firstImport) {
      content = content.replace(firstImport[0], firstImport[0] + importLine);
    } else {
      content = importLine + content;
    }
  }

  content = content.replace(/\n{3,}/g, '\n\n');

  writeFileSync(filePath, content, 'utf-8');
  console.log('FIXED:', file);
}
