const fs = require('fs');
const path = require('path');
const d = 'src/pages';
let updatedCount = 0;
fs.readdirSync(d).forEach(f => {
  if(f.endsWith('.jsx')){
    let p = path.join(d,f);
    let c = fs.readFileSync(p,'utf8');
    if(c.includes('window.location.search') && !c.includes('useLocation')) {
      c = c.replace(/import\s+\{([^}]+)\}\s+from\s+['"]react-router-dom['"];/, "import { $1, useLocation } from 'react-router-dom';");
      c = c.replace(/const\s+([a-zA-Z0-9_]+)\s*=\s*new\s+URLSearchParams\(window\.location\.search\);/, "const location = useLocation();\n  const $1 = new URLSearchParams(location.search);");
      fs.writeFileSync(p, c);
      console.log("Updated " + f);
      updatedCount++;
    }
  }
});
console.log(`Updated ${updatedCount} files.`);
