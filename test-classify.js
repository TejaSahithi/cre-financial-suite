import fs from 'fs';
import path from 'path';

const envLocal = fs.readFileSync(path.resolve('.env'), 'utf-8');
for (const line of envLocal.split('\n')) {
  const [key, ...values] = line.split('=');
  if (key && values.length > 0) {
    process.env[key.trim()] = values.join('=').trim().replace(/^['"]|['"]$/g, '');
  }
}

import { expenseService } from './src/services/expenseService.js';
import { supabase } from './src/services/supabaseClient.js';

async function run() {
  const { data: expenses } = await supabase.from('expenses').select('*').eq('id', '3639257c-9ee2-4a9f-9a4c-d135dd7013d7');
  
  if (!expenses || expenses.length === 0) {
    console.log("No test expense found.");
    return;
  }
  
  console.log("Classifying expense", expenses[0].id);
  try {
    const res = await expenseService.classifyExpenses({ expenses });
    console.log("Classify result:", res);
  } catch (error) {
    console.error("Classify error:", error);
  }
}

run();
