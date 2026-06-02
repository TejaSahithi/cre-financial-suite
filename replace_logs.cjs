const fs = require('fs');
const files = [
  'src/services/leaseRulePipelineService.js',
  'src/services/leaseExpenseRuleService.js'
];
const helpers = `
const devLog = (...args) => { if (import.meta.env.DEV) console.log(...args); };
const devWarn = (...args) => { if (import.meta.env.DEV) console.warn(...args); };
const devTable = (...args) => { if (import.meta.env.DEV) console.table(...args); };
`;

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  const importMatches = [...content.matchAll(/^import .* from .*$/gm)];
  if (importMatches.length > 0) {
    const lastImport = importMatches[importMatches.length - 1];
    const insertIndex = lastImport.index + lastImport[0].length;
    content = content.slice(0, insertIndex) + '\n\n' + helpers.trim() + '\n' + content.slice(insertIndex);
  } else {
    content = helpers.trim() + '\n\n' + content;
  }
  content = content.replace(/console\.log\(/g, 'devLog(');
  content = content.replace(/console\.warn\(/g, 'devWarn(');
  content = content.replace(/console\.table\(/g, 'devTable(');
  fs.writeFileSync(file, content, 'utf8');
}
console.log('Done');
